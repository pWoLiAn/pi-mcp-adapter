import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionSelectorComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema, ErrorCode, McpError, type ElicitRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  ElicitationCoordinator,
  coerceAndValidateFormValues,
  handleElicitationRequest,
  registerElicitationHandler,
  stripTerminalControls,
} from "../elicitation-handler.ts";

const mocks = vi.hoisted(() => ({
  open: vi.fn(async () => undefined),
}));

vi.mock("open", () => ({ default: mocks.open }));

function formRequest(params: ElicitRequest["params"]): ElicitRequest {
  return { method: "elicitation/create", params } as ElicitRequest;
}

describe("elicitation handler", () => {
  beforeEach(() => {
    mocks.open.mockClear();
  });

  it("collects form elicitation fields with stock Pi dialogs and returns accepted content", async () => {
    const ui = {
      select: vi
        .fn()
        .mockResolvedValueOnce("Continue")
        .mockResolvedValueOnce("Enter custom value")
        .mockResolvedValueOnce("Medium (medium)")
        .mockResolvedValueOnce("Yes")
        .mockResolvedValueOnce("Submit"),
      input: vi.fn(async () => "Bug in auth flow"),
    };

    const result = await handleElicitationRequest(
      { serverName: "github", ui: ui as any },
      formRequest({
        mode: "form",
        message: "Create a new issue",
        requestedSchema: {
          type: "object",
          properties: {
            title: {
              type: "string",
              title: "Title",
              description: "Issue title",
              minLength: 1,
            },
            priority: {
              type: "string",
              title: "Priority",
              oneOf: [
                { const: "low", title: "Low" },
                { const: "medium", title: "Medium" },
                { const: "high", title: "High" },
              ],
              default: "medium",
            },
            assignToMe: {
              type: "boolean",
              title: "Assign to me",
              default: false,
            },
          },
          required: ["title"],
        },
      }),
    );

    expect(ui.select).toHaveBeenNthCalledWith(
      1,
      "MCP Input Request\nServer: github\n\nRequest from server:\n  Create a new issue\n\nDo not enter passwords, API keys, access tokens, or payment credentials.",
      ["Continue", "Decline"],
    );
    expect(ui.input).toHaveBeenCalledWith("Title (required)\nIssue title", undefined);
    expect(ui.select).toHaveBeenNthCalledWith(2, "Title (required)\nIssue title", ["Enter custom value"]);
    expect(ui.select).toHaveBeenNthCalledWith(3, "Priority", [
      "Low (low)",
      "Medium (medium)",
      "High (high)",
      "Use default (medium)",
      "Omit",
    ]);
    expect(ui.select).toHaveBeenNthCalledWith(4, "Assign to me", ["Yes", "No", "Use default (false)", "Omit"]);
    expect(ui.select).toHaveBeenNthCalledWith(
      5,
      "Review input for github\n\nTitle: Bug in auth flow\nPriority: medium\nAssign to me: true",
      ["Submit", "Edit", "Decline"],
    );
    expect(result).toEqual({
      action: "accept",
      content: {
        title: "Bug in auth flow",
        priority: "medium",
        assignToMe: true,
      },
    });
  });

  it("prompts for URL elicitations with stock Pi dialogs and opens accepted URLs", async () => {
    const ui = {
      select: vi.fn(async () => "Open"),
      notify: vi.fn(),
    };

    const result = await handleElicitationRequest(
      { serverName: "stripe", ui: ui as any },
      formRequest({
        mode: "url",
        message: "Confirm payment authorization",
        elicitationId: "elicit_123",
        url: "https://checkout.stripe.com/c/pay/cs_test_123",
      }),
    );

    expect(ui.select).toHaveBeenCalledWith(
      [
        "MCP Browser Request",
        "Server: stripe",
        "",
        "Request from server:",
        "  Confirm payment authorization",
        "",
        "Scheme: https",
        "Host: checkout.stripe.com",
        "Domain: checkout.stripe.com",
        "Full URL: https://checkout.stripe.com/c/pay/cs_test_123",
        "",
        "Open this exact URL in your browser?",
      ].join("\n"),
      ["Open", "Decline"],
    );
    expect(mocks.open).toHaveBeenCalledWith("https://checkout.stripe.com/c/pay/cs_test_123");
    expect(ui.notify).toHaveBeenCalledWith("Opened browser for MCP elicitation.", "info");
    expect(result).toEqual({ action: "accept" });
  });

  it("opens the exact supplied URL while displaying its parsed origin", async () => {
    const supplied = "HTTPS://EXAMPLE.COM:443/%7e?next=%2Fcallback";
    const ui = { select: vi.fn(async () => "Open"), notify: vi.fn() };

    await handleElicitationRequest(
      { serverName: "demo", ui: ui as any },
      formRequest({ mode: "url", message: "Authorize", elicitationId: "exact", url: supplied }),
    );

    expect(ui.select.mock.calls[0][0]).toContain("Host: example.com");
    expect(ui.select.mock.calls[0][0]).toContain(`Full URL: ${supplied}`);
    expect(mocks.open).toHaveBeenCalledWith(supplied);
  });

  it("always requires explicit consent before opening URL elicitations", async () => {
    const ui = {
      select: vi.fn(async () => "Decline"),
      notify: vi.fn(),
    };

    const result = await handleElicitationRequest(
      { serverName: "demo", ui: ui as any },
      formRequest({
        mode: "url",
        message: "Authorize access",
        elicitationId: "elicit_consent",
        url: "https://example.com/authorize",
      }),
    );

    expect(ui.select).toHaveBeenCalledOnce();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(result).toEqual({ action: "decline" });
  });

  it("warns before opening suspicious Punycode URL hosts", async () => {
    const ui = { select: vi.fn(async () => "Decline"), notify: vi.fn() };

    await handleElicitationRequest(
      { serverName: "demo", ui: ui as any },
      formRequest({
        mode: "url",
        message: "Authorize",
        elicitationId: "elicit_punycode",
        url: "https://xn--pple-43d.example/authorize",
      }),
    );

    expect(ui.select.mock.calls[0]?.[0]).toContain("Warning: the hostname contains Punycode");
  });

  it("highlights Unicode-confusable hosts and recognizes IPv6 loopback", async () => {
    const confusableUi = { select: vi.fn(async () => "Decline"), notify: vi.fn() };
    await handleElicitationRequest(
      { serverName: "demo", ui: confusableUi as any },
      formRequest({ mode: "url", message: "Authorize", elicitationId: "confusable", url: "https://аpple.example/" }),
    );
    expect(confusableUi.select.mock.calls[0]?.[0]).toContain("Punycode");

    const loopbackUi = { select: vi.fn(async () => "Decline"), notify: vi.fn() };
    await handleElicitationRequest(
      { serverName: "demo", ui: loopbackUi as any },
      formRequest({ mode: "url", message: "Local callback", elicitationId: "ipv6", url: "http://[::1]:8080/callback" }),
    );
    expect(loopbackUi.select.mock.calls[0]?.[0]).toContain("Host: [::1]");
    expect(loopbackUi.select.mock.calls[0]?.[0]).not.toContain("does not use HTTPS");
  });

  it("returns cancel if the request is aborted while browser launch is pending", async () => {
    let finishOpen!: () => void;
    mocks.open.mockImplementationOnce(() => new Promise<void>((resolve) => { finishOpen = resolve; }));
    const controller = new AbortController();
    const releaseUrlElicitation = vi.fn();
    const ui = { select: vi.fn(async () => "Open"), notify: vi.fn() };

    const pending = handleElicitationRequest(
      { serverName: "demo", ui: ui as any, reserveUrlElicitation: vi.fn(), releaseUrlElicitation },
      formRequest({ mode: "url", message: "Authorize", elicitationId: "abort-open", url: "https://example.com/" }),
      controller.signal,
    );
    await vi.waitFor(() => expect(mocks.open).toHaveBeenCalled());
    controller.abort(new Error("cancelled"));

    await expect(pending).resolves.toEqual({ action: "cancel" });
    finishOpen();
    expect(releaseUrlElicitation).toHaveBeenCalledWith("abort-open");
    expect(ui.notify).not.toHaveBeenCalledWith("Opened browser for MCP elicitation.", "info");
  });

  it("returns cancel and notifies when the browser cannot be opened", async () => {
    mocks.open.mockRejectedValueOnce(new Error("no browser"));
    const ui = { select: vi.fn(async () => "Open"), notify: vi.fn() };
    const reserveUrlElicitation = vi.fn();
    const releaseUrlElicitation = vi.fn();

    const result = await handleElicitationRequest(
      { serverName: "demo", ui: ui as any, reserveUrlElicitation, releaseUrlElicitation },
      formRequest({
        mode: "url",
        message: "Authorize",
        elicitationId: "elicit_open_error",
        url: "https://example.com/authorize",
      }),
    );

    expect(result).toEqual({ action: "cancel" });
    expect(reserveUrlElicitation).toHaveBeenCalledWith("elicit_open_error");
    expect(releaseUrlElicitation).toHaveBeenCalledWith("elicit_open_error");
    expect(ui.notify).toHaveBeenCalledWith("Could not open MCP elicitation URL: no browser", "error");
  });

  it("rejects non-browser URL elicitation schemes before prompting or opening", async () => {
    const ui = {
      select: vi.fn(async () => "Open"),
      notify: vi.fn(),
    };

    await expect(
      handleElicitationRequest(
        { serverName: "demo", ui: ui as any },
        formRequest({
          mode: "url",
          message: "Open local file",
          elicitationId: "elicit_file",
          url: "file:///etc/passwd",
        }),
      ),
    ).rejects.toThrow("MCP URL elicitation only supports http/https URLs: file:");

    expect(ui.select).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(ui.notify).not.toHaveBeenCalled();
  });

  it("shows submitted values and lets the user edit a field before accepting", async () => {
    const ui = {
      select: vi
        .fn()
        .mockResolvedValueOnce("Continue")
        .mockResolvedValueOnce("Enter custom value")
        .mockResolvedValueOnce("Edit")
        .mockResolvedValueOnce("Name (name)")
        .mockResolvedValueOnce("Enter custom value")
        .mockResolvedValueOnce("Submit"),
      input: vi.fn().mockResolvedValueOnce("Alice").mockResolvedValueOnce("Bob"),
      notify: vi.fn(),
    };

    const result = await handleElicitationRequest(
      { serverName: "demo", ui: ui as any },
      formRequest({
        mode: "form",
        message: "Provide a name",
        requestedSchema: {
          type: "object",
          properties: { name: { type: "string", title: "Name" } },
          required: ["name"],
        },
      }),
    );

    expect(ui.select).toHaveBeenNthCalledWith(
      3,
      "Review input for demo\n\nName: Alice",
      ["Submit", "Edit", "Decline"],
    );
    expect(ui.select).toHaveBeenNthCalledWith(4, "Choose a field to edit", ["Name (name)"]);
    expect(ui.select).toHaveBeenNthCalledWith(
      6,
      "Review input for demo\n\nName: Bob",
      ["Submit", "Edit", "Decline"],
    );
    expect(result).toEqual({ action: "accept", content: { name: "Bob" } });
  });

  it("collects multi-select fields with stock Pi selectors", async () => {
    const ui = {
      select: vi
        .fn()
        .mockResolvedValueOnce("Continue")
        .mockResolvedValueOnce("Choose values")
        .mockResolvedValueOnce("urgent")
        .mockResolvedValueOnce("Done")
        .mockResolvedValueOnce("Submit"),
      input: vi.fn(),
      notify: vi.fn(),
    };

    const result = await handleElicitationRequest(
      { serverName: "github", ui: ui as any },
      formRequest({
        mode: "form",
        message: "Choose labels",
        requestedSchema: {
          type: "object",
          properties: {
            labels: {
              type: "array",
              title: "Labels",
              items: { type: "string", enum: ["bug", "urgent"] },
              minItems: 1,
            },
          },
          required: ["labels"],
        },
      }),
    );

    expect(ui.select).toHaveBeenNthCalledWith(2, "Labels (required)", ["Choose values"]);
    expect(ui.select).toHaveBeenNthCalledWith(3, "Labels (required)", ["bug", "urgent", "Done"]);
    expect(result).toEqual({ action: "accept", content: { labels: ["urgent"] } });
  });

  it("collects numeric fields and applies advertised defaults", async () => {
    const ui = {
      select: vi.fn()
        .mockResolvedValueOnce("Continue")
        .mockResolvedValueOnce("Use default (2.5)")
        .mockResolvedValueOnce("Enter custom value")
        .mockResolvedValueOnce("Submit"),
      input: vi.fn().mockResolvedValueOnce("4"),
    };

    const result = await handleElicitationRequest(
      { serverName: "demo", ui: ui as any },
      formRequest({
        mode: "form",
        message: "Set limits",
        requestedSchema: {
          type: "object",
          properties: {
            minimum: { type: "number", title: "Minimum", default: 2.5 },
            retries: { type: "integer", title: "Retries", minimum: 1 },
          },
          required: ["retries"],
        },
      }),
    );

    expect(ui.select).toHaveBeenNthCalledWith(2, "Minimum", ["Enter custom value", "Use default (2.5)", "Omit"]);
    expect(ui.input).toHaveBeenCalledOnce();
    expect(ui.input).toHaveBeenCalledWith("Retries (required)", undefined);
    expect(result).toEqual({ action: "accept", content: { minimum: 2.5, retries: 4 } });
  });

  it("reprompts when a field value does not satisfy the requested schema", async () => {
    const ui = {
      select: vi.fn()
        .mockResolvedValueOnce("Continue")
        .mockResolvedValueOnce("Enter custom value")
        .mockResolvedValueOnce("Submit"),
      input: vi.fn().mockResolvedValueOnce("not-a-number").mockResolvedValueOnce("4"),
      notify: vi.fn(),
    };

    const result = await handleElicitationRequest(
      { serverName: "demo", ui: ui as any },
      formRequest({
        mode: "form",
        message: "Set retries",
        requestedSchema: {
          type: "object",
          properties: { retries: { type: "integer", title: "Retries" } },
          required: ["retries"],
        },
      }),
    );

    expect(ui.notify).toHaveBeenCalledWith("Elicitation field retries must be a number", "error");
    expect(result).toEqual({ action: "accept", content: { retries: 4 } });
  });

  it("bounds free-form values even when the server omits maxLength", () => {
    const params = {
      mode: "form",
      message: "Value",
      requestedSchema: { type: "object", properties: { value: { type: "string" } } },
    } as const;

    expect(() => coerceAndValidateFormValues(params, { value: "x".repeat(64 * 1024 + 1) }))
      .toThrow(/value.*65536 bytes/i);
  });

  it("uses JSON Schema Unicode length semantics", () => {
    const params = {
      mode: "form",
      message: "Unicode",
      requestedSchema: {
        type: "object",
        properties: { symbol: { type: "string", maxLength: 1 } },
        required: ["symbol"],
      },
    } as const;

    expect(coerceAndValidateFormValues(params, { symbol: "😀" })).toEqual({ symbol: "😀" });
  });

  it("preserves empty strings for string fields unless schema constraints reject them", async () => {
    const params = {
      mode: "form",
      message: "Collect note",
      requestedSchema: {
        type: "object",
        properties: {
          note: { type: "string", title: "Note" },
          summary: { type: "string", title: "Summary", minLength: 1 },
        },
        required: ["note"],
      },
    } as const;

    expect(coerceAndValidateFormValues(params, { note: "", summary: "ok" })).toEqual({
      note: "",
      summary: "ok",
    });
    expect(() => coerceAndValidateFormValues(params, { note: "ok", summary: "" })).toThrow(/summary.*fewer than 1/i);
  });

  it("validates the complete response against the requested JSON Schema", () => {
    const params = {
      mode: "form",
      message: "Provide required data",
      requestedSchema: {
        type: "object",
        properties: {},
        required: ["missing"],
      },
    } as any;

    expect(() => coerceAndValidateFormValues(params, {})).toThrow(/missing|required/i);
  });

  it("uses the MCP SDK's restricted schema after unsupported keywords are stripped", () => {
    const parsed = ElicitRequestSchema.parse(formRequest({
      mode: "form",
      message: "Code",
      requestedSchema: {
        type: "object",
        properties: { code: { type: "string", pattern: "^[A-Z]{3}$" } },
      },
    } as any));

    expect((parsed.params as any).requestedSchema.properties.code.pattern).toBeUndefined();
  });

  it("validates formatted string fields before accepting elicited content", () => {
    const params = {
      mode: "form",
      message: "Contact details",
      requestedSchema: {
        type: "object",
        properties: {
          email: { type: "string", format: "email" },
        },
      },
    } as const;

    expect(() => coerceAndValidateFormValues(params, { email: "not-an-email" })).toThrow(/email.*format/i);
    expect(coerceAndValidateFormValues(params, { email: "user@example.com" })).toEqual({
      email: "user@example.com",
    });
  });

  it("serializes concurrent elicitations that share a Pi UI", async () => {
    let releaseFirst!: (value: string) => void;
    const firstUi = {
      select: vi
        .fn()
        .mockImplementationOnce(() => new Promise<string>((resolve) => { releaseFirst = resolve; })),
      notify: vi.fn(),
    };
    const secondUi = { select: vi.fn(async () => "Decline"), notify: vi.fn() };
    const coordinator = new ElicitationCoordinator();
    let firstHandler!: (request: ElicitRequest, extra: { signal: AbortSignal }) => Promise<unknown>;
    let secondHandler!: (request: ElicitRequest, extra: { signal: AbortSignal }) => Promise<unknown>;
    const firstClient = { setRequestHandler: vi.fn((_schema, handler) => { firstHandler = handler; }) };
    const secondClient = { setRequestHandler: vi.fn((_schema, handler) => { secondHandler = handler; }) };

    registerElicitationHandler(firstClient as any, {
      serverName: "one",
      ui: firstUi as any,
      coordinator,
    });
    registerElicitationHandler(secondClient as any, {
      serverName: "two",
      ui: secondUi as any,
      coordinator,
    });

    const first = firstHandler(formRequest({
      mode: "url",
      message: "First",
      elicitationId: "first",
      url: "https://one.example/",
    }), { signal: new AbortController().signal });
    const second = secondHandler(formRequest({
      mode: "url",
      message: "Second",
      elicitationId: "second",
      url: "https://two.example/",
    }), { signal: new AbortController().signal });

    await vi.waitFor(() => expect(firstUi.select).toHaveBeenCalledOnce());
    expect(secondUi.select).not.toHaveBeenCalled();
    releaseFirst("Decline");
    await expect(first).resolves.toEqual({ action: "decline" });
    await expect(second).resolves.toEqual({ action: "decline" });
    expect(secondUi.select).toHaveBeenCalledOnce();
  });

  it("passes cancellation to Pi dialogs and returns cancel when the MCP request is aborted", async () => {
    const controller = new AbortController();
    const ui = {
      select: vi.fn((_title: string, _options: string[], opts?: { signal?: AbortSignal }) =>
        new Promise<string | undefined>((resolve) => {
          opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
        })),
    };

    const pending = handleElicitationRequest(
      { serverName: "demo", ui: ui as any },
      formRequest({
        mode: "form",
        message: "Continue?",
        requestedSchema: { type: "object", properties: {} },
      }),
      controller.signal,
    );
    controller.abort();

    await expect(pending).resolves.toEqual({ action: "cancel" });
    expect(ui.select.mock.calls[0]?.[2]?.signal).toBe(controller.signal);
  });

  it("cancels when a stock Pi field dialog is dismissed", async () => {
    const ui = {
      select: vi.fn().mockResolvedValueOnce("Continue").mockResolvedValueOnce("Enter custom value"),
      input: vi.fn(async () => undefined),
    };

    await expect(
      handleElicitationRequest(
        { serverName: "demo", ui: ui as any },
        formRequest({
          mode: "form",
          message: "Why?",
          requestedSchema: {
            type: "object",
            properties: { reason: { type: "string", title: "Reason" } },
          },
        }),
      ),
    ).resolves.toEqual({ action: "cancel" });
    expect(ui.select).toHaveBeenCalledTimes(2);
    expect(ui.input).toHaveBeenCalledOnce();
  });

  it("treats out-of-protocol RPC selector values as cancellation", async () => {
    const ui = { select: vi.fn(async () => "forged-option"), input: vi.fn(), notify: vi.fn() };
    await expect(handleElicitationRequest(
      { serverName: "demo", ui: ui as any },
      formRequest({ mode: "form", message: "Continue?", requestedSchema: { type: "object", properties: {} } }),
    )).resolves.toEqual({ action: "cancel" });
  });

  it("maps stock Pi decline and cancel choices to MCP actions", async () => {
    const makeRequest = () =>
      formRequest({
        mode: "form",
        message: "Continue?",
        requestedSchema: {
          type: "object",
          properties: {
            reason: { type: "string", title: "Reason" },
          },
        },
      });

    const declineUi = { select: vi.fn(async () => "Decline") };
    const cancelUi = { select: vi.fn(async () => undefined) };

    await expect(
      handleElicitationRequest({ serverName: "demo", ui: declineUi as any }, makeRequest()),
    ).resolves.toEqual({ action: "decline" });
    await expect(
      handleElicitationRequest({ serverName: "demo", ui: cancelUi as any }, makeRequest()),
    ).resolves.toEqual({ action: "cancel" });
  });

  it("removes terminal and bidi controls from every untrusted consent label", async () => {
    const ui = { select: vi.fn(async () => "Decline"), notify: vi.fn() };
    await handleElicitationRequest(
      { serverName: "evil\u001b]8;;https://phish.example\u0007name\u202e", ui: ui as any },
      formRequest({
        mode: "url",
        message: "\u001b[2Jfake domain\rrewritten\u2066",
        elicitationId: "hostile",
        url: "https://example.com/path",
      }),
    );

    const rendered = ui.select.mock.calls[0]?.[0] ?? "";
    expect(rendered).toContain("Server: evilname");
    expect(rendered).toContain("Host: example.com");
    expect(rendered).not.toMatch(/[\u001b\u0007\r\u202e\u2066]/u);
    const tuiOutput = new Text(rendered, 0, 0).render(120).join("\n");
    expect(tuiOutput).not.toMatch(/[\u001b\u0007\r\u202e\u2066]/u);
  });

  it("removes all terminal C0/C1 and directional controls at the rendering boundary", () => {
    const controls = [...Array.from({ length: 0x20 }, (_, code) => code), ...Array.from({ length: 0x21 }, (_, index) => 0x7f + index)]
      .filter((code) => code !== 0x0a)
      .map((code) => String.fromCharCode(code))
      .join("");
    const bidi = "\u061c\u200e\u200f\u2028\u2029\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069\u206a\u206b\u206c\u206d\u206e\u206f";
    const sanitized = stripTerminalControls(`before${controls}${bidi}after`);
    initTheme("dark", false);
    const selector = new ExtensionSelectorComponent(sanitized, ["Open", "Decline"], () => {}, () => {});
    const rendered = selector.render(120).join("\n");
    const plainRendered = stripTerminalControls(rendered);

    expect(sanitized).toBe("beforeafter");
    expect(plainRendered).toContain("beforeafter");
    expect(plainRendered).not.toMatch(/[\x00-\x09\x0B-\x1F\x7F-\x9F\u061C\u200E\u200F\u2028-\u202E\u2066-\u206F]/u);
  });

  it("rejects control-bearing and oversized URLs instead of rewriting them", async () => {
    const ui = { select: vi.fn(), notify: vi.fn() };
    const makeUrlRequest = (url: string) => formRequest({
      mode: "url", message: "Authorize", elicitationId: "unsafe", url,
    });

    await expect(handleElicitationRequest(
      { serverName: "demo", ui: ui as any }, makeUrlRequest("https://example.com/\u001bpath"),
    )).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(handleElicitationRequest(
      { serverName: "demo", ui: ui as any }, makeUrlRequest(`https://example.com/${"x".repeat(4096)}`),
    )).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    expect(ui.select).not.toHaveBeenCalled();
  });

  it("rejects oversized forms before showing or queueing UI", async () => {
    const ui = { select: vi.fn(), input: vi.fn(), notify: vi.fn() };
    const properties = Object.fromEntries(Array.from({ length: 101 }, (_, index) => [
      `field${index}`, { type: "string" as const },
    ]));
    const client = { setRequestHandler: vi.fn() };
    registerElicitationHandler(client as any, { serverName: "demo", ui: ui as any, coordinator: new ElicitationCoordinator() });
    const handler = client.setRequestHandler.mock.calls[0][1];

    await expect(Promise.resolve().then(() => handler(formRequest({
      mode: "form", message: "Too large", requestedSchema: { type: "object", properties },
    }), { signal: new AbortController().signal }))).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    expect(ui.select).not.toHaveBeenCalled();
  });

  it("rejects credential-bearing URLs and URL mode outside local TUI", async () => {
    const ui = { select: vi.fn(), notify: vi.fn() };
    const credentialRequest = formRequest({
      mode: "url",
      message: "Authorize",
      elicitationId: "credentials",
      url: "https://user:secret@example.com/authorize",
    });
    await expect(handleElicitationRequest({ serverName: "demo", ui: ui as any }, credentialRequest))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(handleElicitationRequest({ serverName: "demo", ui: ui as any, allowUrl: false }, credentialRequest))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    expect(ui.select).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("lets optional scalar and array properties be explicitly omitted", async () => {
    const ui = {
      select: vi.fn()
        .mockResolvedValueOnce("Continue")
        .mockResolvedValueOnce("Omit")
        .mockResolvedValueOnce("Omit")
        .mockResolvedValueOnce("Submit"),
      input: vi.fn(),
      notify: vi.fn(),
    };
    const result = await handleElicitationRequest(
      { serverName: "demo", ui: ui as any },
      formRequest({
        mode: "form",
        message: "Optional values",
        requestedSchema: {
          type: "object",
          properties: {
            note: { type: "string", default: "suggested" },
            tags: { type: "array", items: { type: "string", enum: ["one"] }, default: ["one"] },
          },
        },
      }),
    );
    expect(result).toEqual({ action: "accept", content: {} });
    expect(ui.input).not.toHaveBeenCalled();
  });

  it("lets every supported optional field kind be omitted", async () => {
    const ui = {
      select: vi.fn()
        .mockResolvedValueOnce("Continue")
        .mockResolvedValueOnce("Omit")
        .mockResolvedValueOnce("Omit")
        .mockResolvedValueOnce("Omit")
        .mockResolvedValueOnce("Omit")
        .mockResolvedValueOnce("Omit")
        .mockResolvedValueOnce("Submit"),
      input: vi.fn(),
      notify: vi.fn(),
    };
    const result = await handleElicitationRequest(
      { serverName: "demo", ui: ui as any },
      formRequest({
        mode: "form",
        message: "Optional values",
        requestedSchema: {
          type: "object",
          properties: {
            text: { type: "string" },
            choice: { type: "string", enum: ["one"] },
            enabled: { type: "boolean" },
            count: { type: "integer" },
            tags: { type: "array", items: { type: "string", enum: ["one"] } },
          },
        },
      }),
    );

    expect(result).toEqual({ action: "accept", content: {} });
    expect(ui.input).not.toHaveBeenCalled();
  });

  it("returns InvalidParams for semantic schema errors before showing UI", async () => {
    const ui = { select: vi.fn(), notify: vi.fn() };
    const missingProperty = handleElicitationRequest(
      { serverName: "demo", ui: ui as any },
      formRequest({
        mode: "form",
        message: "Bad schema",
        requestedSchema: { type: "object", properties: {}, required: ["missing"] },
      } as any),
    );
    await expect(missingProperty).rejects.toEqual(expect.objectContaining({ code: ErrorCode.InvalidParams }));

    const impossibleRange = handleElicitationRequest(
      { serverName: "demo", ui: ui as any },
      formRequest({
        mode: "form",
        message: "Bad range",
        requestedSchema: {
          type: "object",
          properties: { count: { type: "integer", minimum: 10, maximum: 1 } },
          required: ["count"],
        },
      }),
    );
    await expect(impossibleRange).rejects.toMatchObject({ code: ErrorCode.InvalidParams });

    const invalidDefault = handleElicitationRequest(
      { serverName: "demo", ui: ui as any },
      formRequest({
        mode: "form",
        message: "Bad default",
        requestedSchema: {
          type: "object",
          properties: { choice: { type: "string", enum: ["yes"], default: "no" } },
        },
      } as any),
    );
    await expect(invalidDefault).rejects.toBeInstanceOf(McpError);
    await expect(invalidDefault).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    expect(ui.select).not.toHaveBeenCalled();
  });

  it("serializes semantic schema failures as -32602 through the real MCP SDK", async () => {
    const client = new Client(
      { name: "elicitation-test-client", version: "1.0.0" },
      { capabilities: { elicitation: { form: {} } } },
    );
    registerElicitationHandler(client, {
      serverName: "test", ui: { select: vi.fn(), input: vi.fn(), notify: vi.fn() } as any,
    });
    const server = new Server(
      { name: "elicitation-test-server", version: "1.0.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      await expect(server.elicitInput({
        mode: "form",
        message: "Bad schema",
        requestedSchema: { type: "object", properties: {}, required: ["missing"] },
      } as any)).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });

  it("registers URL completion state before launching", async () => {
    let reserved = false;
    mocks.open.mockImplementationOnce(async () => {
      expect(reserved).toBe(true);
    });
    const reserve = vi.fn(() => { reserved = true; });
    const release = vi.fn();
    const ui = { select: vi.fn(async () => "Open"), notify: vi.fn() };
    await handleElicitationRequest(
      { serverName: "demo", ui: ui as any, reserveUrlElicitation: reserve, releaseUrlElicitation: release },
      formRequest({ mode: "url", message: "Open", elicitationId: "race", url: "https://example.com/" }),
    );
    expect(reserve).toHaveBeenCalledWith("race");
    expect(release).not.toHaveBeenCalled();
  });

  it("removes an aborted queued elicitation immediately and bounds queue growth", async () => {
    const coordinator = new ElicitationCoordinator(1, 2);
    let release!: () => void;
    const active = coordinator.run(() => new Promise<void>((resolve) => { release = resolve; }), { serverName: "one" });
    const controller = new AbortController();
    const queuedOperation = vi.fn(async () => undefined);
    const queued = coordinator.run(queuedOperation, { serverName: "two", signal: controller.signal });
    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    expect(queuedOperation).not.toHaveBeenCalled();
    expect(coordinator.pendingCount).toBe(1);

    const overflow = coordinator.run(async () => undefined, { serverName: "two" });
    await expect(coordinator.run(async () => undefined, { serverName: "three" }))
      .rejects.toMatchObject({ code: ErrorCode.InternalError });
    release();
    await active;
    await overflow;
  });

  it("drains active and queued elicitations on shutdown", async () => {
    const coordinator = new ElicitationCoordinator();
    const active = coordinator.run((signal) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }), { serverName: "one" });
    const queued = coordinator.run(async () => undefined, { serverName: "two" });
    coordinator.close("shutdown");
    await expect(active).rejects.toThrow("shutdown");
    await expect(queued).rejects.toThrow("shutdown");
    expect(coordinator.pendingCount).toBe(0);
  });

  it("maps stock Pi URL decline and dismissal choices to MCP actions", async () => {
    const request = formRequest({
      mode: "url",
      message: "Authorize",
      elicitationId: "elicit_123",
      url: "https://example.com/authorize",
    });

    await expect(
      handleElicitationRequest(
        { serverName: "demo", ui: { select: vi.fn(async () => "Decline") } as any },
        request,
      ),
    ).resolves.toEqual({ action: "decline" });
    await expect(
      handleElicitationRequest(
        { serverName: "demo", ui: { select: vi.fn(async () => undefined) } as any },
        request,
      ),
    ).resolves.toEqual({ action: "cancel" });
    expect(mocks.open).not.toHaveBeenCalled();
  });
});
