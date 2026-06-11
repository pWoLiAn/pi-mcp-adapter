import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  ElicitRequestSchema,
  ErrorCode,
  McpError,
  type ElicitRequest,
  type ElicitRequestFormParams,
  type ElicitRequestURLParams,
  type ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation/types.js";
import open from "open";
import { waitForAbortSignal } from "./utils.ts";

type ElicitationValue = string | number | boolean | string[] | undefined;
type FormProperty = ElicitRequestFormParams["requestedSchema"]["properties"][string];
type SelectOption = { value: string; label?: string };
type QueueEntry<T> = {
  serverName: string;
  operation: (signal: AbortSignal) => Promise<T>;
  controller: AbortController;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  removeExternalAbort?: () => void;
};

type CompiledValidator = ReturnType<AjvJsonSchemaValidator["getValidator"]>;

let formValidator = new AjvJsonSchemaValidator();
let compiledFormValidators = new WeakMap<object, CompiledValidator>();
let compiledPropertyValidators = new WeakMap<object, { required?: CompiledValidator; optional?: CompiledValidator }>();
let validatorCompilationCount = 0;
const MAX_VALIDATOR_COMPILATIONS = 64;
const MAX_DISPLAY_MESSAGE = 4_000;
const MAX_DISPLAY_LABEL = 300;
const MAX_DISPLAY_SERVER = 200;
const MAX_URL_LENGTH = 4_096;
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_FORM_PROPERTIES = 100;
const MAX_FIELD_CHOICES = 200;
const MAX_FORM_VALUE_BYTES = 64 * 1024;
const MAX_ELICITATION_ID_LENGTH = 1_024;
const DEFAULT_MAX_QUEUE = 32;
const DEFAULT_MAX_PER_SERVER = 8;

export type ElicitationUIContext = ExtensionUIContext;

/** A bounded, abort-aware FIFO because Pi can only display one dialog at a time. */
export class ElicitationCoordinator {
  private queue: QueueEntry<unknown>[] = [];
  private active: QueueEntry<unknown> | undefined;
  private closedError: Error | undefined;

  constructor(
    private readonly maxQueue = DEFAULT_MAX_QUEUE,
    private readonly maxPerServer = DEFAULT_MAX_PER_SERVER,
  ) {}

  run<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    options: { serverName?: string; signal?: AbortSignal } = {},
  ): Promise<T> {
    const serverName = options.serverName ?? "(unknown)";
    if (this.closedError) return Promise.reject(this.closedError);
    if (options.signal?.aborted) return Promise.reject(abortError(options.signal.reason));

    const waitingForServer = this.queue.filter((entry) => entry.serverName === serverName).length
      + (this.active?.serverName === serverName ? 1 : 0);
    if (this.queue.length >= this.maxQueue || waitingForServer >= this.maxPerServer) {
      return Promise.reject(new McpError(
        ErrorCode.InternalError,
        `Too many pending elicitation requests${serverName === "(unknown)" ? "" : ` from ${safeInline(serverName, MAX_DISPLAY_SERVER)}`}`,
      ));
    }

    return new Promise<T>((resolve, reject) => {
      const controller = new AbortController();
      const entry: QueueEntry<T> = { serverName, operation, controller, resolve, reject };
      if (options.signal) {
        const onAbort = () => this.abortEntry(entry as QueueEntry<unknown>, options.signal?.reason);
        options.signal.addEventListener("abort", onAbort, { once: true });
        entry.removeExternalAbort = () => options.signal?.removeEventListener("abort", onAbort);
      }
      this.queue.push(entry as QueueEntry<unknown>);
      this.pump();
    });
  }

  cancelServer(serverName: string, reason = "MCP server closed"): void {
    const error = abortError(reason);
    if (this.active?.serverName === serverName) this.active.controller.abort(error);
    for (const entry of [...this.queue]) {
      if (entry.serverName === serverName) this.abortEntry(entry, error);
    }
  }

  close(reason = "MCP elicitation manager shut down"): void {
    if (this.closedError) return;
    this.closedError = abortError(reason);
    this.active?.controller.abort(this.closedError);
    for (const entry of [...this.queue]) this.abortEntry(entry, this.closedError);
  }

  get pendingCount(): number {
    return this.queue.length + (this.active ? 1 : 0);
  }

  private abortEntry(entry: QueueEntry<unknown>, reason: unknown): void {
    const error = reason instanceof Error ? reason : abortError(reason);
    if (entry === this.active) {
      entry.controller.abort(error);
      return;
    }
    const index = this.queue.indexOf(entry);
    if (index < 0) return;
    this.queue.splice(index, 1);
    entry.removeExternalAbort?.();
    entry.reject(error);
  }

  private pump(): void {
    if (this.active || this.closedError) return;
    const entry = this.queue.shift();
    if (!entry) return;
    this.active = entry;
    void entry.operation(entry.controller.signal).then(entry.resolve, entry.reject).finally(() => {
      entry.removeExternalAbort?.();
      if (this.active === entry) this.active = undefined;
      this.pump();
    });
  }
}

export interface ElicitationHandlerOptions {
  serverName: string;
  ui: ElicitationUIContext;
  allowUrl?: boolean;
  coordinator?: ElicitationCoordinator;
  validateUrlElicitation?: (elicitationId: string) => void;
  reserveUrlElicitation?: (elicitationId: string) => void;
  releaseUrlElicitation?: (elicitationId: string) => void;
}

export type ServerElicitationConfig = Omit<
  ElicitationHandlerOptions,
  "serverName" | "coordinator" | "validateUrlElicitation" | "reserveUrlElicitation" | "releaseUrlElicitation"
>;

export function registerElicitationHandler(client: Client, options: ElicitationHandlerOptions): void {
  client.setRequestHandler(ElicitRequestSchema, (request, extra) => {
    assertElicitationRequestWithinLimits(request);
    const operation = (signal: AbortSignal) => handleElicitationRequest(options, request, signal);
    return options.coordinator
      ? options.coordinator.run(operation, { serverName: options.serverName, signal: extra.signal })
      : operation(extra.signal);
  });
}

export async function handleElicitationRequest(
  options: ElicitationHandlerOptions,
  request: ElicitRequest,
  signal?: AbortSignal,
): Promise<ElicitResult> {
  assertElicitationRequestWithinLimits(request);
  if (request.params.mode === "url") {
    if (options.allowUrl === false) {
      throw new McpError(ErrorCode.InvalidParams, "URL elicitation is not supported in this Pi mode");
    }
    return handleUrlElicitation(options, request.params, signal);
  }
  validateRequestedSchema(request.params);
  return handleFormElicitation(options, request.params, signal);
}

export async function handleFormElicitation(
  options: ElicitationHandlerOptions,
  params: ElicitRequestFormParams,
  signal?: AbortSignal,
): Promise<ElicitResult> {
  validateRequestedSchema(params);
  const server = safeInline(options.serverName, MAX_DISPLAY_SERVER);
  const message = indentUntrusted(safeDisplay(params.message, MAX_DISPLAY_MESSAGE));
  const decision = await selectDialog(
    options.ui,
    `MCP Input Request\nServer: ${server}\n\nRequest from server:\n${message}\n\nDo not enter passwords, API keys, access tokens, or payment credentials.`,
    ["Continue", "Decline"],
    signal,
  );
  if (decision === undefined) return { action: "cancel" };
  if (decision === "Decline") return { action: "decline" };

  const values: Record<string, ElicitationValue> = {};
  const properties = Object.entries(params.requestedSchema.properties);
  for (const [name, schema] of properties) {
    const collected = await collectFormField(options, params, name, schema, values[name], signal);
    if (!("value" in collected)) return { action: "cancel" };
    values[name] = collected.value;
  }

  while (true) {
    const content = coerceAndValidateFormValues(params, values);
    const reviewActions = properties.length > 0 ? ["Submit", "Edit", "Decline"] : ["Submit", "Decline"];
    const submission = await selectDialog(options.ui, formatFormReview(options.serverName, params, content), reviewActions, signal);
    if (submission === undefined) return { action: "cancel" };
    if (submission === "Decline") return { action: "decline" };
    if (submission === "Submit") return { action: "accept", content };

    const editChoices = uniqueDisplays(properties.map(([name, schema]) =>
      `${safeInline(schema.title ?? humanizeName(name), MAX_DISPLAY_LABEL)} (${safeInline(name, MAX_DISPLAY_LABEL)})`));
    const selected = await selectDialog(options.ui, "Choose a field to edit", editChoices, signal);
    if (selected === undefined) return { action: "cancel" };
    const property = properties[editChoices.indexOf(selected)];
    if (!property) continue;
    const [name, schema] = property;
    const collected = await collectFormField(options, params, name, schema, values[name], signal);
    if (!("value" in collected)) return { action: "cancel" };
    values[name] = collected.value;
  }
}

async function collectFormField(
  options: ElicitationHandlerOptions,
  params: ElicitRequestFormParams,
  name: string,
  schema: FormProperty,
  currentValue: ElicitationValue,
  signal?: AbortSignal,
): Promise<{ cancelled: true } | { cancelled: false; value: ElicitationValue }> {
  const isRequired = new Set(params.requestedSchema.required ?? []).has(name);
  const label = safeInline(schema.title ?? humanizeName(name), MAX_DISPLAY_LABEL);
  const description = schema.description ? safeDisplay(schema.description, MAX_DISPLAY_MESSAGE) : undefined;
  const title = [isRequired ? `${label} (required)` : label, description].filter(Boolean).join("\n");

  if (schema.type === "string" && ("enum" in schema || "oneOf" in schema)) {
    const rawChoices = "oneOf" in schema
      ? schema.oneOf.map((option) => ({ display: formatChoice(option.const, option.title), value: option.const }))
      : schema.enum.map((value, index) => ({
          display: formatChoice(value, "enumNames" in schema ? schema.enumNames?.[index] : undefined),
          value,
        }));
    const displays = uniqueDisplays(rawChoices.map((choice) => choice.display));
    const actions = [...displays];
    const useDefault = schema.default === undefined ? undefined : uniqueActionLabel(`Use default (${safeInline(String(schema.default), MAX_DISPLAY_LABEL)})`, actions);
    if (useDefault) actions.push(useDefault);
    const omit = isRequired ? undefined : uniqueActionLabel("Omit", actions);
    if (omit) actions.push(omit);
    const selected = await selectDialog(options.ui, title, actions, signal);
    if (selected === undefined) return { cancelled: true };
    const value = selected === useDefault ? schema.default : selected === omit ? undefined : rawChoices[displays.indexOf(selected)]?.value;
    return validateCollectedField(options, params, name, schema, isRequired, value);
  }

  if (schema.type === "boolean") {
    const actions = ["Yes", "No"];
    const useDefault = schema.default === undefined ? undefined : uniqueActionLabel(`Use default (${schema.default})`, actions);
    if (useDefault) actions.push(useDefault);
    const omit = isRequired ? undefined : uniqueActionLabel("Omit", actions);
    if (omit) actions.push(omit);
    const selected = await selectDialog(options.ui, title, actions, signal);
    if (selected === undefined) return { cancelled: true };
    const value = selected === useDefault ? schema.default : selected === omit ? undefined : selected === "Yes";
    return validateCollectedField(options, params, name, schema, isRequired, value);
  }

  if (schema.type === "array") {
    const actions: string[] = ["Choose values"];
    const useDefault = schema.default === undefined ? undefined : `Use default (${schema.default.map((value) => safeInline(value, 80)).join(", ")})`;
    if (useDefault) actions.push(uniqueActionLabel(useDefault, actions));
    const omit = isRequired ? undefined : uniqueActionLabel("Omit", actions);
    if (omit) actions.push(omit);
    const action = await selectDialog(options.ui, title, actions, signal);
    if (action === undefined) return { cancelled: true };
    if (action === omit) return { cancelled: false, value: undefined };
    if (useDefault && action.startsWith("Use default (")) {
      return validateCollectedField(options, params, name, schema, isRequired, schema.default);
    }

    const choices = extractMultiSelectOptions(schema).map((option) => ({
      display: formatChoice(option.value, option.label), value: option.value,
    }));
    const displays = uniqueDisplays(choices.map((choice) => choice.display));
    const selectedValues = new Set(Array.isArray(currentValue) ? currentValue : []);
    while (true) {
      const marked = displays.map((display, index) => selectedValues.has(choices[index]?.value ?? "") ? `✓ ${display}` : display);
      const done = uniqueActionLabel("Done", marked);
      const selected = await selectDialog(options.ui, title, [...marked, done], signal);
      if (selected === undefined) return { cancelled: true };
      if (selected === done) {
        const validated = validateCollectedField(options, params, name, schema, isRequired, [...selectedValues]);
        if ("value" in validated) return validated;
        continue;
      }
      const choice = choices[marked.indexOf(selected)];
      if (!choice) continue;
      if (selectedValues.has(choice.value)) selectedValues.delete(choice.value);
      else selectedValues.add(choice.value);
    }
  }

  const scalarActions: string[] = ["Enter custom value"];
  const useDefault = schema.default === undefined ? undefined : uniqueActionLabel(
    `Use default (${safeInline(String(schema.default), MAX_DISPLAY_LABEL)})`, scalarActions);
  if (useDefault) scalarActions.push(useDefault);
  const omit = isRequired ? undefined : uniqueActionLabel("Omit", scalarActions);
  if (omit) scalarActions.push(omit);
  const action = await selectDialog(options.ui, title, scalarActions, signal);
  if (action === undefined) return { cancelled: true };
  if (action === omit) return { cancelled: false, value: undefined };
  if (action === useDefault) return validateCollectedField(options, params, name, schema, isRequired, schema.default);

  const suggestedValue = currentValue === undefined ? undefined : String(currentValue);
  while (true) {
    const entered = await inputDialog(options.ui, title, suggestedValue, signal);
    if (entered === undefined) return { cancelled: true };
    const validated = validateCollectedField(options, params, name, schema, isRequired, entered);
    if ("value" in validated) return validated;
  }
}

function validateCollectedField(
  options: ElicitationHandlerOptions,
  params: ElicitRequestFormParams,
  name: string,
  schema: FormProperty,
  required: boolean,
  value: ElicitationValue,
): { cancelled: true } | { cancelled: false; value: ElicitationValue } {
  try {
    return { cancelled: false, value: validateFieldValue(params, name, schema, required, value) };
  } catch (error) {
    options.ui.notify(error instanceof Error ? error.message : String(error), "error");
    return { cancelled: true };
  }
}

function formatFormReview(
  serverName: string,
  params: ElicitRequestFormParams,
  content: Record<string, string | number | boolean | string[]>,
): string {
  const lines = Object.entries(params.requestedSchema.properties).map(([name, schema]) => {
    const label = safeInline(schema.title ?? humanizeName(name), MAX_DISPLAY_LABEL);
    const value = content[name];
    const displayed = value === undefined ? "(omitted)" : Array.isArray(value)
      ? value.map((item) => safeInline(item, MAX_DISPLAY_LABEL)).join(", ")
      : safeInline(String(value), MAX_DISPLAY_LABEL);
    return `${label}: ${displayed}`;
  });
  return [`Review input for ${safeInline(serverName, MAX_DISPLAY_SERVER)}`, "", ...lines].join("\n");
}

export async function handleUrlElicitation(
  options: ElicitationHandlerOptions,
  params: ElicitRequestURLParams,
  signal?: AbortSignal,
): Promise<ElicitResult> {
  if (options.allowUrl === false) throw new McpError(ErrorCode.InvalidParams, "URL elicitation is not supported in this Pi mode");
  const browserUrl = getBrowserElicitationUrl(params.url);
  const exactUrl = params.url;
  options.validateUrlElicitation?.(params.elicitationId);
  const server = safeInline(options.serverName, MAX_DISPLAY_SERVER);
  const message = indentUntrusted(safeDisplay(params.message, MAX_DISPLAY_MESSAGE));
  const promptLines = [
    "MCP Browser Request",
    `Server: ${server}`,
    "",
    "Request from server:",
    message,
    "",
    `Scheme: ${browserUrl.protocol.slice(0, -1)}`,
    `Host: ${browserUrl.hostname}`,
    ...(browserUrl.port ? [`Port: ${browserUrl.port}`] : []),
    `Domain: ${browserUrl.host}`,
    `Full URL: ${exactUrl}`,
  ];
  if (browserUrl.hostname.split(".").some((label) => label.startsWith("xn--"))) {
    promptLines.push("", "Warning: the hostname contains Punycode. Check it carefully for impersonation.");
  }
  if (browserUrl.protocol === "http:" && !isLoopbackHostname(browserUrl.hostname)) {
    promptLines.push("", "Warning: this URL does not use HTTPS.");
  }
  promptLines.push("", "Open this exact URL in your browser?");

  const result = await selectDialog(options.ui, promptLines.join("\n"), ["Open", "Decline"], signal);
  if (result === "Decline") return { action: "decline" };
  if (result === undefined) return { action: "cancel" };

  if (signal?.aborted) return { action: "cancel" };
  options.reserveUrlElicitation?.(params.elicitationId);
  try {
    await waitForAbortSignal(open(exactUrl), signal);
  } catch (error) {
    options.releaseUrlElicitation?.(params.elicitationId);
    if (signal?.aborted) return { action: "cancel" };
    const message = error instanceof Error ? error.message : String(error);
    options.ui.notify(`Could not open MCP elicitation URL: ${safeInline(message, MAX_DISPLAY_MESSAGE)}`, "error");
    return { action: "cancel" };
  }
  if (signal?.aborted) {
    options.releaseUrlElicitation?.(params.elicitationId);
    return { action: "cancel" };
  }
  options.ui.notify("Opened browser for MCP elicitation.", "info");
  return { action: "accept" };
}

async function selectDialog(ui: ElicitationUIContext, title: string, choices: string[], signal?: AbortSignal): Promise<string | undefined> {
  const selected = await (signal ? ui.select(title, choices, { signal }) : ui.select(title, choices));
  return selected === undefined || choices.includes(selected) ? selected : undefined;
}

function inputDialog(ui: ElicitationUIContext, title: string, placeholder: string | undefined, signal?: AbortSignal): Promise<string | undefined> {
  return signal ? ui.input(title, placeholder, { signal }) : ui.input(title, placeholder);
}

function validateFieldValue(
  params: ElicitRequestFormParams,
  name: string,
  schema: FormProperty,
  required: boolean,
  value: ElicitationValue,
): ElicitationValue {
  const fieldParams = {
    ...params,
    requestedSchema: { type: "object", properties: { [name]: schema }, ...(required ? { required: [name] } : {}) },
  } as ElicitRequestFormParams;
  const coerced = coerceFormValues(fieldParams, { [name]: value });
  const validation = getPropertyValidator(schema, required)(coerced[name]);
  if (!validation.valid) {
    throw new Error(`Invalid elicitation field ${safeInline(name, MAX_DISPLAY_LABEL)}: ${validation.errorMessage}`);
  }
  return coerced[name];
}

export function coerceAndValidateFormValues(
  params: ElicitRequestFormParams,
  values: Record<string, ElicitationValue>,
): Record<string, string | number | boolean | string[]> {
  const output = coerceFormValues(params, values);
  const validate = getCompiledValidator(params.requestedSchema);
  const validation = validate(output);
  if (!validation.valid) throw new Error(`Invalid elicitation response: ${validation.errorMessage}`);
  return output;
}

function coerceFormValues(
  params: ElicitRequestFormParams,
  values: Record<string, ElicitationValue>,
): Record<string, string | number | boolean | string[]> {
  const output: Record<string, string | number | boolean | string[]> = {};
  const required = new Set(params.requestedSchema.required ?? []);
  for (const [name, schema] of Object.entries(params.requestedSchema.properties)) {
    const raw = values[name];
    if (typeof raw === "string" && Buffer.byteLength(raw, "utf8") > MAX_FORM_VALUE_BYTES) {
      throw new Error(`Elicitation field ${safeInline(name, MAX_DISPLAY_LABEL)} exceeds ${MAX_FORM_VALUE_BYTES} bytes`);
    }
    if (raw === undefined || (raw === "" && schema.type !== "string")) {
      if (required.has(name)) throw new Error(`Missing required elicitation field: ${safeInline(name, MAX_DISPLAY_LABEL)}`);
      continue;
    }
    if (schema.type === "string") {
      const value = String(raw);
      if ("enum" in schema && !schema.enum.includes(value)) throw new Error(`Elicitation field ${safeInline(name, MAX_DISPLAY_LABEL)} is not an allowed value`);
      if ("oneOf" in schema && !schema.oneOf.some((option) => option.const === value)) throw new Error(`Elicitation field ${safeInline(name, MAX_DISPLAY_LABEL)} is not an allowed value`);
      output[name] = value;
    } else if (schema.type === "number" || schema.type === "integer") {
      const value = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(value)) throw new Error(`Elicitation field ${safeInline(name, MAX_DISPLAY_LABEL)} must be a number`);
      if (schema.type === "integer" && !Number.isInteger(value)) throw new Error(`Elicitation field ${safeInline(name, MAX_DISPLAY_LABEL)} must be an integer`);
      if (schema.minimum !== undefined && value < schema.minimum) throw new Error(`Elicitation field ${safeInline(name, MAX_DISPLAY_LABEL)} is below minimum ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum) throw new Error(`Elicitation field ${safeInline(name, MAX_DISPLAY_LABEL)} is above maximum ${schema.maximum}`);
      output[name] = value;
    } else if (schema.type === "boolean") {
      output[name] = typeof raw === "boolean" ? raw : raw === "true";
    } else if (schema.type === "array") {
      if (!Array.isArray(raw)) throw new Error(`Elicitation field ${safeInline(name, MAX_DISPLAY_LABEL)} must be a list`);
      const allowed = new Set(extractMultiSelectOptions(schema).map((option) => option.value));
      const value = raw.map(String);
      if (schema.minItems !== undefined && value.length < schema.minItems) throw new Error(`Elicitation field ${safeInline(name, MAX_DISPLAY_LABEL)} has fewer than ${schema.minItems} selections`);
      if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new Error(`Elicitation field ${safeInline(name, MAX_DISPLAY_LABEL)} has more than ${schema.maxItems} selections`);
      if (value.some((item) => !allowed.has(item))) throw new Error(`Elicitation field ${safeInline(name, MAX_DISPLAY_LABEL)} contains an invalid selection`);
      output[name] = value;
    }
  }
  return output;
}

function assertElicitationRequestWithinLimits(request: ElicitRequest): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(request);
  } catch {
    throw new McpError(ErrorCode.InvalidParams, "MCP elicitation request is not serializable");
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_REQUEST_BYTES) {
    throw new McpError(ErrorCode.InvalidParams, `MCP elicitation request exceeds ${MAX_REQUEST_BYTES} bytes`);
  }

  const params = request.params;
  if (params.mode === "url") {
    if (params.url.length > MAX_URL_LENGTH) {
      throw new McpError(ErrorCode.InvalidParams, `MCP URL elicitation URL exceeds ${MAX_URL_LENGTH} characters`);
    }
    if (params.elicitationId.length > MAX_ELICITATION_ID_LENGTH) {
      throw new McpError(ErrorCode.InvalidParams, "MCP URL elicitation ID is too long");
    }
    return;
  }

  const properties = Object.values(params.requestedSchema.properties);
  if (properties.length > MAX_FORM_PROPERTIES) {
    throw new McpError(ErrorCode.InvalidParams, `MCP elicitation form exceeds ${MAX_FORM_PROPERTIES} properties`);
  }
  for (const property of properties) {
    const choiceCount = property.type === "array"
      ? ("anyOf" in property.items ? property.items.anyOf.length : property.items.enum.length)
      : "oneOf" in property
        ? property.oneOf.length
        : "enum" in property
          ? property.enum.length
          : 0;
    if (choiceCount > MAX_FIELD_CHOICES) {
      throw new McpError(ErrorCode.InvalidParams, `MCP elicitation field exceeds ${MAX_FIELD_CHOICES} choices`);
    }
  }
}

function validateRequestedSchema(params: ElicitRequestFormParams): void {
  const schema = params.requestedSchema;
  const properties = schema.properties;
  const required = new Set(schema.required ?? []);
  for (const name of required) {
    if (!(name in properties)) throw new McpError(ErrorCode.InvalidParams, `Required elicitation property does not exist: ${safeInline(name, MAX_DISPLAY_LABEL)}`);
  }
  for (const [name, property] of Object.entries(properties)) {
    if (property.type === "string") {
      const limits = property as typeof property & { minLength?: number; maxLength?: number };
      if (limits.minLength !== undefined && limits.maxLength !== undefined && limits.minLength > limits.maxLength) {
        throw new McpError(ErrorCode.InvalidParams, `Invalid elicitation length range for ${safeInline(name, MAX_DISPLAY_LABEL)}`);
      }
      if (required.has(name) && limits.minLength !== undefined && limits.minLength > MAX_FORM_VALUE_BYTES) {
        throw new McpError(ErrorCode.InvalidParams, `Required elicitation length exceeds the client limit for ${safeInline(name, MAX_DISPLAY_LABEL)}`);
      }
      const choices = "oneOf" in property ? property.oneOf : "enum" in property ? property.enum : undefined;
      if (required.has(name) && choices?.length === 0) {
        throw new McpError(ErrorCode.InvalidParams, `Required elicitation field has no choices: ${safeInline(name, MAX_DISPLAY_LABEL)}`);
      }
    } else if (property.type === "number" || property.type === "integer") {
      if (property.minimum !== undefined && property.maximum !== undefined && property.minimum > property.maximum) {
        throw new McpError(ErrorCode.InvalidParams, `Invalid elicitation numeric range for ${safeInline(name, MAX_DISPLAY_LABEL)}`);
      }
    } else if (property.type === "array") {
      const choiceCount = extractMultiSelectOptions(property).length;
      if (property.minItems !== undefined && property.maxItems !== undefined && property.minItems > property.maxItems) {
        throw new McpError(ErrorCode.InvalidParams, `Invalid elicitation selection range for ${safeInline(name, MAX_DISPLAY_LABEL)}`);
      }
      if (required.has(name) && (property.minItems ?? 0) > choiceCount) {
        throw new McpError(ErrorCode.InvalidParams, `Required elicitation field cannot satisfy minItems: ${safeInline(name, MAX_DISPLAY_LABEL)}`);
      }
    }
  }
  try {
    // Compile once up front so malformed JSON Schemas fail as InvalidParams before UI.
    getCompiledValidator(schema);
    for (const [name, property] of Object.entries(properties)) {
      if (property.default !== undefined) {
        validateFieldValue(params, name, property, true, property.default);
      }
    }
  } catch (error) {
    if (error instanceof McpError) throw error;
    throw new McpError(ErrorCode.InvalidParams, `Invalid elicitation schema: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function compileValidator(schema: JsonSchemaType): CompiledValidator {
  if (validatorCompilationCount >= MAX_VALIDATOR_COMPILATIONS) {
    formValidator = new AjvJsonSchemaValidator();
    compiledFormValidators = new WeakMap();
    compiledPropertyValidators = new WeakMap();
    validatorCompilationCount = 0;
  }
  validatorCompilationCount += 1;
  return formValidator.getValidator(schema);
}

function getCompiledValidator(schema: object): CompiledValidator {
  let validate = compiledFormValidators.get(schema);
  if (!validate) {
    validate = compileValidator(schema as JsonSchemaType);
    compiledFormValidators.set(schema, validate);
  }
  return validate;
}

function getPropertyValidator(
  schema: FormProperty,
  required: boolean,
): (value: ElicitationValue) => ReturnType<ReturnType<AjvJsonSchemaValidator["getValidator"]>> {
  let cached = compiledPropertyValidators.get(schema);
  if (!cached) {
    cached = {};
    compiledPropertyValidators.set(schema, cached);
  }
  const key = required ? "required" : "optional";
  let validate = cached[key];
  if (!validate) {
    validate = compileValidator({
      type: "object",
      properties: { value: schema },
      ...(required ? { required: ["value"] } : {}),
    } as JsonSchemaType);
    cached[key] = validate;
  }
  return (value) => validate!({ ...(value === undefined ? {} : { value }) });
}

function extractMultiSelectOptions(schema: Extract<FormProperty, { type: "array" }>): SelectOption[] {
  const items = schema.items as { enum?: string[]; anyOf?: Array<{ const: string; title: string }> };
  return Array.isArray(items.anyOf)
    ? items.anyOf.map((option) => ({ value: option.const, label: option.title }))
    : (items.enum ?? []).map((value) => ({ value }));
}

function formatChoice(value: string, label?: string): string {
  const safeValue = safeInline(value, MAX_DISPLAY_LABEL);
  const safeLabel = label ? safeInline(label, MAX_DISPLAY_LABEL) : undefined;
  return safeLabel && safeLabel !== safeValue ? `${safeLabel} (${safeValue})` : safeValue;
}

function uniqueDisplays(choices: string[]): string[] {
  const used: string[] = [];
  return choices.map((choice) => {
    let result = choice;
    while (used.includes(result)) result += "…";
    used.push(result);
    return result;
  });
}

function uniqueActionLabel(label: string, choices: string[]): string {
  let result = label;
  while (choices.includes(result)) result += "…";
  return result;
}

function humanizeName(name: string): string {
  return name.replace(/[_-]+/gu, " ").replace(/([a-z0-9])([A-Z])/gu, "$1 $2").replace(/^./u, (char) => char.toUpperCase());
}

function getBrowserElicitationUrl(url: string): URL {
  if (url.length > MAX_URL_LENGTH) {
    throw new McpError(ErrorCode.InvalidParams, `MCP URL elicitation URL exceeds ${MAX_URL_LENGTH} characters`);
  }
  const sanitized = stripTerminalControls(url);
  if (sanitized !== url || /[\x00-\x1F\x7F-\x9F]/u.test(url)) {
    throw new McpError(ErrorCode.InvalidParams, "MCP URL elicitation URLs must not contain terminal or directional control characters");
  }
  let parsed: URL;
  try {
    parsed = new URL(sanitized);
  } catch {
    throw new McpError(ErrorCode.InvalidParams, "MCP URL elicitation supplied an invalid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new McpError(ErrorCode.InvalidParams, `MCP URL elicitation only supports http/https URLs: ${safeInline(parsed.protocol, 20)}`);
  }
  if (parsed.username || parsed.password) {
    throw new McpError(ErrorCode.InvalidParams, "MCP URL elicitation URLs must not contain embedded credentials or user-info");
  }
  return parsed;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  return normalized === "localhost" || normalized === "::1" || /^127(?:\.\d{1,3}){3}$/u.test(normalized);
}

/** Remove terminal escapes, controls, and Unicode bidi controls from untrusted display text. */
export function stripTerminalControls(value: string): string {
  return value
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/gu, "")
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\x1B[PX^_][\s\S]*?\x1B\\/gu, "")
    .replace(/[\x00-\x09\x0B-\x1F\x7F-\x9F]/gu, "")
    .replace(/[\u061C\u200E\u200F\u2028-\u202E\u2066-\u206F]/gu, "");
}

function safeDisplay(value: string, maxLength: number): string {
  const sanitized = stripTerminalControls(value).replace(/\r\n?/gu, "\n");
  return sanitized.length <= maxLength ? sanitized : `${sanitized.slice(0, maxLength)}…`;
}

function safeInline(value: string, maxLength: number): string {
  return safeDisplay(value, maxLength).replace(/[\n\t]+/gu, " ");
}

function indentUntrusted(value: string): string {
  return value.split("\n").map((line) => `  ${line}`).join("\n");
}

function abortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason;
  const error = new Error(typeof reason === "string" ? reason : "Elicitation cancelled");
  error.name = "AbortError";
  return error;
}
