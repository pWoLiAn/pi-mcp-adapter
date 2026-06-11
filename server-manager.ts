import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  ElicitationCompleteNotificationSchema,
  ErrorCode,
  McpError,
  type ReadResourceResult,
  type UrlElicitationRequiredError,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  McpTool,
  McpResource,
  ServerDefinition,
  ServerStreamResultPatchNotification,
  Transport,
} from "./types.ts";
import { serverStreamResultPatchNotificationSchema } from "./types.ts";
import { resolveNpxBinary } from "./npx-resolver.ts";
import { logger } from "./logger.ts";
import { McpOAuthProvider } from "./mcp-oauth-provider.ts";
import { extractOAuthConfig, supportsOAuth } from "./mcp-auth-flow.ts";
import { registerSamplingHandler, type ServerSamplingConfig } from "./sampling-handler.ts";
import {
  ElicitationCoordinator,
  handleElicitationRequest,
  registerElicitationHandler,
  type ServerElicitationConfig,
} from "./elicitation-handler.ts";
import { interpolateEnvRecord, resolveBearerToken, resolveConfigPath, waitForAbortSignal } from "./utils.ts";

interface ServerConnection {
  client: Client;
  transport?: Transport;
  definition: ServerDefinition;
  tools: McpTool[];
  resources: McpResource[];
  lastUsedAt: number;
  inFlight: number;
  status: "connected" | "closed" | "needs-auth";
}

type UiStreamListener = (serverName: string, notification: ServerStreamResultPatchNotification["params"]) => void;

export class McpServerManager {
  private connections = new Map<string, ServerConnection>();
  private connectPromises = new Map<string, Promise<ServerConnection>>();
  private pendingConnections = new Map<string, {
    client: Client;
    transport?: Transport;
    controller: AbortController;
    waiters: number;
  }>();
  private uiStreamListeners = new Map<string, UiStreamListener>();
  private samplingConfig: ServerSamplingConfig | undefined;
  private elicitationConfig: ServerElicitationConfig | undefined;
  private elicitationCoordinator = new ElicitationCoordinator();
  private pendingUrlElicitations = new Map<string, { acceptedAt: number; serverName: string }>();
  private shuttingDown = false;
  private static readonly MAX_PENDING_URL_ELICITATIONS = 256;
  private static readonly URL_ELICITATION_TTL_MS = 30 * 60 * 1000;

  setSamplingConfig(config: ServerSamplingConfig | undefined): void {
    this.samplingConfig = config;
  }

  setElicitationConfig(config: ServerElicitationConfig | undefined): void {
    this.elicitationConfig = config;
  }
  
  async connect(name: string, definition: ServerDefinition, signal?: AbortSignal): Promise<ServerConnection> {
    if (this.shuttingDown) throw new Error("MCP server manager is shutting down");
    if (signal?.aborted) throw abortError(signal.reason);

    const inProgress = this.connectPromises.get(name);
    if (inProgress) return this.waitForConnection(name, inProgress, signal);

    const existing = this.connections.get(name);
    if (existing?.status === "connected") {
      existing.lastUsedAt = Date.now();
      return existing;
    }

    const created = this.createConnection(name, definition);
    let managed!: Promise<ServerConnection>;
    managed = created.then((connection) => {
      if (this.shuttingDown) throw abortError("MCP server manager shut down during connection");
      this.connections.set(name, connection);
      return connection;
    }).finally(() => {
      if (this.connectPromises.get(name) === managed) this.connectPromises.delete(name);
    });
    this.connectPromises.set(name, managed);
    // A caller may stop waiting while the shared attempt continues.
    void managed.catch(() => {});
    return this.waitForConnection(name, managed, signal);
  }

  private async waitForConnection(
    name: string,
    promise: Promise<ServerConnection>,
    signal?: AbortSignal,
  ): Promise<ServerConnection> {
    const attempt = this.pendingConnections.get(name);
    if (attempt) attempt.waiters += 1;
    try {
      return await waitForAbortSignal(promise, signal);
    } catch (error) {
      if (signal?.aborted && attempt && attempt.waiters === 1 && this.pendingConnections.get(name) === attempt) {
        attempt.controller.abort(abortError(signal.reason));
        await Promise.all([
          attempt.client.close().catch(() => {}),
          attempt.transport?.close().catch(() => {}),
        ]);
      }
      throw error;
    } finally {
      if (attempt) attempt.waiters = Math.max(0, attempt.waiters - 1);
    }
  }
  
  private async createConnection(
    name: string,
    definition: ServerDefinition
  ): Promise<ServerConnection> {
    const client = this.createClient(name);
    this.attachAdapterNotificationHandlers(name, client);
    const controller = new AbortController();
    const attempt = { client, controller, waiters: 0 } as {
      client: Client;
      transport?: Transport;
      controller: AbortController;
      waiters: number;
    };
    this.pendingConnections.set(name, attempt);

    let transport: Transport | undefined;

    try {
      if (definition.command) {
      let command = definition.command;
      let args = definition.args ?? [];

      if (command === "npx" || command === "npm") {
        const resolved = await waitForAbortSignal(resolveNpxBinary(command, args), controller.signal);
        if (resolved) {
          command = resolved.isJs ? "node" : resolved.binPath;
          args = resolved.isJs ? [resolved.binPath, ...resolved.extraArgs] : resolved.extraArgs;
          logger.debug(`${name} resolved to ${resolved.binPath} (skipping npm parent)`);
        }
      }

      transport = new StdioClientTransport({
        command,
        args,
        env: resolveEnv(definition.env),
        cwd: resolveConfigPath(definition.cwd),
        stderr: definition.debug ? "inherit" : "ignore",
      });
    } else if (definition.url) {
      // HTTP transport with fallback
      transport = await this.createHttpTransport(definition, name, controller.signal);
    } else {
      throw new Error(`Server ${name} has no command or url`);
    }

      attempt.transport = transport;
      controller.signal.throwIfAborted();
      await waitForAbortSignal(client.connect(transport), controller.signal);
      if (this.shuttingDown) throw abortError("MCP server manager shut down during connection");

      // Discover tools and resources
      const [tools, resources] = await waitForAbortSignal(Promise.all([
        this.fetchAllTools(client),
        this.fetchAllResources(client),
      ]), controller.signal);
      
      return {
        client,
        transport,
        definition,
        tools,
        resources,
        lastUsedAt: Date.now(),
        inFlight: 0,
        status: "connected",
      };
    } catch (error) {
      // Check for UnauthorizedError - server requires OAuth
      if (error instanceof UnauthorizedError && supportsOAuth(definition)) {
        // Clean up both client and transport before reporting needs-auth.
        await client.close().catch(() => {});
        await transport?.close().catch(() => {});

        return {
          client,
          transport,
          definition,
          tools: [],
          resources: [],
          lastUsedAt: Date.now(),
          inFlight: 0,
          status: "needs-auth",
        };
      }
      
      // Clean up both client and transport on any error
      await client.close().catch(() => {});
      await transport?.close().catch(() => {});
      throw error;
    } finally {
      const pending = this.pendingConnections.get(name);
      if (pending?.client === client) this.pendingConnections.delete(name);
    }
  }
  
  private buildClientCapabilities() {
    return {
      ...(this.samplingConfig ? { sampling: {} } : {}),
      ...(this.elicitationConfig
        ? {
            elicitation: {
              form: {},
              ...(this.elicitationConfig.allowUrl !== false ? { url: {} } : {}),
            },
          }
        : {}),
    };
  }

  private createClient(serverName: string): Client {
    const capabilities = this.buildClientCapabilities();
    const client = new Client(
      { name: `pi-mcp-${serverName}`, version: "1.0.0" },
      Object.keys(capabilities).length > 0 ? { capabilities } : undefined,
    );
    if (this.samplingConfig) {
      registerSamplingHandler(client, { ...this.samplingConfig, serverName });
    }
    if (this.elicitationConfig) {
      registerElicitationHandler(client, {
        ...this.elicitationConfig,
        serverName,
        coordinator: this.elicitationCoordinator,
        validateUrlElicitation: (elicitationId) => {
          this.assertCanReserveUrlElicitation(serverName, elicitationId);
        },
        reserveUrlElicitation: (elicitationId) => {
          this.reservePendingUrlElicitation(serverName, elicitationId);
        },
        releaseUrlElicitation: (elicitationId) => {
          this.pendingUrlElicitations.delete(elicitationKey(serverName, elicitationId));
        },
      });
    }
    return client;
  }

  async handleUrlElicitationRequired(
    serverName: string,
    error: UrlElicitationRequiredError,
    signal?: AbortSignal,
  ): Promise<"accept" | "decline" | "cancel"> {
    if (!this.elicitationConfig || this.elicitationConfig.allowUrl === false) return "cancel";

    const elicitations = error.elicitations;
    if (!Array.isArray(elicitations) || elicitations.length === 0 || elicitations.length > 8 || elicitations.some((params) =>
      params?.mode !== "url"
      || typeof params.message !== "string"
      || typeof params.elicitationId !== "string"
      || typeof params.url !== "string")) {
      throw new McpError(ErrorCode.InvalidParams, "Malformed URL-required elicitation payload");
    }

    for (const params of elicitations) {
      const result = await this.elicitationCoordinator.run(
        (coordinatorSignal) => handleElicitationRequest({
          ...this.elicitationConfig!,
          serverName,
          coordinator: this.elicitationCoordinator,
          validateUrlElicitation: (elicitationId) => {
            this.assertCanReserveUrlElicitation(serverName, elicitationId);
          },
          reserveUrlElicitation: (elicitationId) => {
            this.reservePendingUrlElicitation(serverName, elicitationId);
          },
          releaseUrlElicitation: (elicitationId) => {
            this.pendingUrlElicitations.delete(elicitationKey(serverName, elicitationId));
          },
        }, { method: "elicitation/create", params }, coordinatorSignal),
        { serverName, signal },
      );
      if (result.action !== "accept") return result.action;
    }
    return "accept";
  }

  private assertCanReserveUrlElicitation(serverName: string, elicitationId: string): void {
    this.expirePendingUrlElicitations();
    const key = elicitationKey(serverName, elicitationId);
    if (this.pendingUrlElicitations.has(key)) {
      throw new McpError(ErrorCode.InvalidParams, `Duplicate active URL elicitation ID from ${serverName}`);
    }
    if (this.pendingUrlElicitations.size >= McpServerManager.MAX_PENDING_URL_ELICITATIONS) {
      throw new McpError(ErrorCode.InternalError, "Too many pending URL elicitations; try again after an existing interaction completes");
    }
  }

  private reservePendingUrlElicitation(serverName: string, elicitationId: string): void {
    this.assertCanReserveUrlElicitation(serverName, elicitationId);
    this.pendingUrlElicitations.set(elicitationKey(serverName, elicitationId), {
      acceptedAt: Date.now(),
      serverName,
    });
  }

  private expirePendingUrlElicitations(now = Date.now()): void {
    for (const [key, entry] of this.pendingUrlElicitations) {
      if (now - entry.acceptedAt >= McpServerManager.URL_ELICITATION_TTL_MS) {
        this.pendingUrlElicitations.delete(key);
      }
    }
  }

  private async createHttpTransport(
    definition: ServerDefinition,
    serverName: string,
    signal: AbortSignal,
  ): Promise<Transport> {
    const url = new URL(definition.url!);
    
    // Build headers first (including any bearer token)
    const headers = resolveHeaders(definition.headers) ?? {};
    
    // For bearer auth, add the token to headers BEFORE creating requestInit
    if (definition.auth === "bearer") {
      const token = resolveBearerToken(definition);
      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
      }
    }
    
    // Create request init with headers (Authorization now included for bearer auth)
    const requestInit = Object.keys(headers).length > 0 ? { headers } : undefined;
    
    // For OAuth servers, create an auth provider
    let authProvider: McpOAuthProvider | undefined;
    if (supportsOAuth(definition)) {
      const oauthConfig = extractOAuthConfig(definition);
      authProvider = new McpOAuthProvider(
        serverName,
        definition.url!,
        oauthConfig,
        {
          onRedirect: async (_authUrl) => {
            // URL is captured by startAuth, no need to log
          },
        }
      );
    }
    
    // Try StreamableHTTP first (modern MCP servers)
    const streamableTransport = new StreamableHTTPClientTransport(url, { 
      requestInit,
      authProvider,
    });
    
    try {
      // Create a test client to verify the transport works
      const testClient = new Client({ name: "pi-mcp-probe", version: "2.1.2" });
      await waitForAbortSignal(testClient.connect(streamableTransport), signal);
      await testClient.close().catch(() => {});
      // Close probe transport before creating fresh one
      await streamableTransport.close().catch(() => {});
      
      // StreamableHTTP works - create fresh transport for actual use
      return new StreamableHTTPClientTransport(url, { requestInit, authProvider });
    } catch (error) {
      // StreamableHTTP failed, close and try SSE fallback
      await streamableTransport.close().catch(() => {});
      signal.throwIfAborted();

      // If this was an UnauthorizedError, don't try SSE - the server needs auth
      if (error instanceof UnauthorizedError) {
        throw error;
      }
      
      // SSE is the legacy transport
      return new SSEClientTransport(url, { requestInit, authProvider });
    }
  }
  
  private async fetchAllTools(client: Client): Promise<McpTool[]> {
    const allTools: McpTool[] = [];
    let cursor: string | undefined;
    
    do {
      const result = await client.listTools(cursor ? { cursor } : undefined);
      allTools.push(...(result.tools ?? []));
      cursor = result.nextCursor;
    } while (cursor);
    
    return allTools;
  }
  
  private async fetchAllResources(client: Client): Promise<McpResource[]> {
    try {
      const allResources: McpResource[] = [];
      let cursor: string | undefined;
      
      do {
        const result = await client.listResources(cursor ? { cursor } : undefined);
        allResources.push(...(result.resources ?? []));
        cursor = result.nextCursor;
      } while (cursor);
      
      return allResources;
    } catch {
      // Server may not support resources
      return [];
    }
  }

  private attachAdapterNotificationHandlers(serverName: string, client: Client): void {
    if (this.elicitationConfig) {
      client.setNotificationHandler(ElicitationCompleteNotificationSchema, (notification) => {
        const { elicitationId } = notification.params;
        const key = elicitationKey(serverName, elicitationId);
        this.expirePendingUrlElicitations();
        if (!this.pendingUrlElicitations.delete(key)) return;
        this.elicitationConfig?.ui.notify(
          `MCP browser interaction for ${serverName} completed. You can retry the tool now.`,
          "info",
        );
      });
    }
    client.setNotificationHandler(serverStreamResultPatchNotificationSchema, (notification) => {
      const listener = this.uiStreamListeners.get(notification.params.streamToken);
      if (!listener) return;
      listener(serverName, notification.params);
    });
  }

  registerUiStreamListener(streamToken: string, listener: UiStreamListener): void {
    this.uiStreamListeners.set(streamToken, listener);
  }

  removeUiStreamListener(streamToken: string): void {
    this.uiStreamListeners.delete(streamToken);
  }

  async readResource(name: string, uri: string, signal?: AbortSignal): Promise<ReadResourceResult> {
    const connection = this.connections.get(name);
    if (!connection || connection.status !== "connected") {
      throw new Error(`Server "${name}" is not connected`);
    }

    try {
      this.touch(name);
      this.incrementInFlight(name);
      return await connection.client.readResource({ uri }, { signal });
    } finally {
      this.decrementInFlight(name);
      this.touch(name);
    }
  }
  
  async close(name: string): Promise<void> {
    this.elicitationCoordinator.cancelServer(name);
    const pending = this.pendingConnections.get(name);
    if (pending) {
      pending.controller.abort(abortError(`MCP server ${name} closed during connection`));
      await Promise.all([
        pending.client.close().catch(() => {}),
        pending.transport?.close().catch(() => {}),
      ]);
    }
    const connecting = this.connectPromises.get(name);
    if (connecting) await connecting.catch(() => {});

    const connection = this.connections.get(name);
    if (!connection) return;
    
    // Delete from map BEFORE async cleanup to prevent a race where a
    // concurrent connect() creates a new connection that our deferred
    // delete() would then remove, orphaning the new server process.
    connection.status = "closed";
    this.connections.delete(name);
    for (const [key, entry] of this.pendingUrlElicitations) {
      if (entry.serverName === name) this.pendingUrlElicitations.delete(key);
    }
    await connection.client.close().catch(() => {});
    await connection.transport?.close().catch(() => {});
  }
  
  async closeAll(): Promise<void> {
    this.shuttingDown = true;
    this.elicitationCoordinator.close();
    this.pendingUrlElicitations.clear();
    const names = new Set([...this.connections.keys(), ...this.pendingConnections.keys(), ...this.connectPromises.keys()]);
    await Promise.all([...names].map(name => this.close(name)));
    await Promise.allSettled([...this.connectPromises.values()]);
  }
  
  getConnection(name: string): ServerConnection | undefined {
    return this.connections.get(name);
  }
  
  getAllConnections(): Map<string, ServerConnection> {
    return new Map(this.connections);
  }

  touch(name: string): void {
    const connection = this.connections.get(name);
    if (connection) {
      connection.lastUsedAt = Date.now();
    }
  }

  incrementInFlight(name: string): void {
    const connection = this.connections.get(name);
    if (connection) {
      connection.inFlight = (connection.inFlight ?? 0) + 1;
    }
  }

  decrementInFlight(name: string): void {
    const connection = this.connections.get(name);
    if (connection && connection.inFlight) {
      connection.inFlight--;
    }
  }

  isIdle(name: string, timeoutMs: number): boolean {
    const connection = this.connections.get(name);
    if (!connection || connection.status !== "connected") return false;
    if (connection.inFlight > 0) return false;
    return (Date.now() - connection.lastUsedAt) > timeoutMs;
  }
}

function elicitationKey(serverName: string, elicitationId: string): string {
  return JSON.stringify([serverName, elicitationId]);
}

function abortError(reason?: unknown): Error {
  if (reason instanceof Error && reason.name === "AbortError") return reason;
  const error = new Error(
    reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "Operation cancelled",
    reason instanceof Error ? { cause: reason } : undefined,
  );
  error.name = "AbortError";
  return error;
}



/**
 * Resolve environment variables with interpolation.
 */
function resolveEnv(env?: Record<string, string>): Record<string, string> {
  // Copy process.env, filtering out undefined values
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      resolved[key] = value;
    }
  }
  
  if (!env) return resolved;

  const overrides = interpolateEnvRecord(env);
  return overrides ? { ...resolved, ...overrides } : resolved;
}

/**
 * Resolve headers with environment variable interpolation.
 */
function resolveHeaders(headers?: Record<string, string>): Record<string, string> | undefined {
  return interpolateEnvRecord(headers);
}
