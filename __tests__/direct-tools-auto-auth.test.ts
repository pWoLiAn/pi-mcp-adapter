import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { runAgentLoop } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { UrlElicitationRequiredError } from "@modelcontextprotocol/sdk/types.js";
import { createDirectToolExecutor } from "../direct-tools.ts";

const mocks = vi.hoisted(() => ({
  lazyConnect: vi.fn(),
  getFailureAgeSeconds: vi.fn(),
  authenticate: vi.fn(),
  supportsOAuth: vi.fn(),
  maybeStartUiSession: vi.fn(),
}));

vi.mock("../init.ts", () => ({
  lazyConnect: mocks.lazyConnect,
  getFailureAgeSeconds: mocks.getFailureAgeSeconds,
}));

vi.mock("../mcp-auth-flow.ts", () => ({
  authenticate: mocks.authenticate,
  supportsOAuth: mocks.supportsOAuth,
}));

vi.mock("../ui-session.ts", () => ({ maybeStartUiSession: mocks.maybeStartUiSession }));

describe("direct tools auto auth", () => {
  beforeEach(() => {
    mocks.lazyConnect.mockReset();
    mocks.getFailureAgeSeconds.mockReset().mockReturnValue(null);
    mocks.authenticate.mockReset().mockResolvedValue("authenticated");
    mocks.supportsOAuth.mockReset().mockReturnValue(true);
    mocks.maybeStartUiSession.mockReset().mockResolvedValue(null);
  });

  it("stops waiting for initialization when the Pi tool is cancelled", async () => {
    const init = new Promise<any>(() => {});
    const controller = new AbortController();
    const executor = createDirectToolExecutor(() => null, () => init, {
      serverName: "demo", originalName: "search", prefixedName: "demo_search", description: "Search",
    });

    const pending = executor("id", {}, controller.signal, undefined, undefined as any);
    controller.abort(new Error("tool cancelled"));
    await expect(pending).rejects.toThrow("tool cancelled");
  });

  it("auto-authenticates and retries direct tool execution once", async () => {

    let connection: any = { status: "needs-auth" };
    const connected = {
      status: "connected",
      client: {
        callTool: vi.fn(async () => ({
          isError: false,
          content: [{ type: "text", text: "ok" }],
        })),
      },
    };

    mocks.lazyConnect
      .mockImplementationOnce(async () => false)
      .mockImplementationOnce(async () => {
        connection = connected;
        return true;
      });

    const state = {
      config: {
        settings: { autoAuth: true },
        mcpServers: {
          demo: { url: "https://api.example.com/mcp", auth: "oauth" },
        },
      },
      manager: {
        close: vi.fn(async () => {
          connection = undefined;
        }),
        getConnection: vi.fn(() => connection),
        touch: vi.fn(),
        incrementInFlight: vi.fn(),
        decrementInFlight: vi.fn(),
      },
      failureTracker: new Map(),
      ui: { setStatus: vi.fn() },
      completedUiSessions: [],
    } as any;

    const executor = createDirectToolExecutor(
      () => state,
      () => null,
      {
        serverName: "demo",
        originalName: "search",
        prefixedName: "demo_search",
        description: "Search",
      },
    );

    const signal = new AbortController().signal;
    const result = await executor("id", { q: "hello" }, signal, () => {}, undefined as any);

    expect(connected.client.callTool).toHaveBeenCalledWith(
      { name: "search", arguments: { q: "hello" }, _meta: undefined },
      undefined,
      { signal },
    );
    expect(mocks.authenticate).toHaveBeenCalledWith(
      "demo",
      "https://api.example.com/mcp",
      state.config.mcpServers.demo,
    );
    expect(state.manager.close).toHaveBeenCalledWith("demo");
    expect(result.content[0].text).toContain("ok");
  });

  it("throws after URL-required flow so Pi records the original tool as an error", async () => {
    const error = new UrlElicitationRequiredError([{
      mode: "url",
      message: "Connect account",
      elicitationId: "connect-1",
      url: "https://example.com/connect",
    }]);
    const connection = {
      status: "connected",
      client: { callTool: vi.fn(async () => { throw error; }) },
    };
    const manager = {
      getConnection: vi.fn(() => connection),
      handleUrlElicitationRequired: vi.fn(async () => "accept"),
      touch: vi.fn(),
      incrementInFlight: vi.fn(),
      decrementInFlight: vi.fn(),
    };
    const state = {
      config: { settings: {}, mcpServers: { demo: { command: "demo" } } },
      manager,
      failureTracker: new Map(),
      completedUiSessions: [],
    } as any;
    mocks.lazyConnect.mockResolvedValue(true);
    const executor = createDirectToolExecutor(() => state, () => null, {
      serverName: "demo",
      originalName: "search",
      prefixedName: "demo_search",
      description: "Search",
    });
    const signal = new AbortController().signal;

    await expect(executor("id", {}, signal, undefined, undefined as any)).rejects.toThrow(
      "original MCP tool did not run",
    );

    expect(manager.handleUrlElicitationRequired).toHaveBeenCalledWith("demo", error, signal);
  });

  it("produces isError: true through Pi's actual runner after URL-required flow", async () => {
    const urlError = new UrlElicitationRequiredError([{
      mode: "url", message: "Connect", elicitationId: "runner", url: "https://example.com/connect",
    }]);
    const connection = { status: "connected", client: { callTool: vi.fn().mockRejectedValue(urlError) } };
    const state = {
      config: { settings: {}, mcpServers: { demo: { command: "demo" } } },
      manager: {
        getConnection: vi.fn(() => connection), handleUrlElicitationRequired: vi.fn(async () => "accept"),
        touch: vi.fn(), incrementInFlight: vi.fn(), decrementInFlight: vi.fn(),
      },
      failureTracker: new Map(), completedUiSessions: [],
    } as any;
    mocks.lazyConnect.mockResolvedValue(true);
    const executor = createDirectToolExecutor(() => state, () => null, {
      serverName: "demo", originalName: "search", prefixedName: "demo_search", description: "Search",
    });
    const assistant = (content: any[], stopReason: "toolUse" | "stop") => ({
      role: "assistant", content, stopReason, api: "test", provider: "test", model: "test",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      timestamp: Date.now(),
    });
    let turn = 0;
    const streamFn = vi.fn(async () => {
      const stream = createAssistantMessageEventStream();
      stream.end(turn++ === 0
        ? assistant([{ type: "toolCall", id: "call-1", name: "demo_search", arguments: {} }], "toolUse") as any
        : assistant([{ type: "text", text: "done" }], "stop") as any);
      return stream;
    });
    const events: any[] = [];

    await runAgentLoop(
      [{ role: "user", content: "run it", timestamp: Date.now() } as any],
      {
        systemPrompt: "test", messages: [], tools: [{
          name: "demo_search", description: "Search", parameters: Type.Object({}), execute: executor as any,
        }],
      },
      { model: { provider: "test" } as any, convertToLlm: (messages) => messages as any },
      (event) => { events.push(event); },
      undefined,
      streamFn as any,
    );

    const ended = events.find((event) => event.type === "tool_execution_end");
    expect(ended).toMatchObject({ toolName: "demo_search", isError: true });
    expect(ended.result.content[0].text).toContain("original MCP tool did not run");
  });

  it("throws for MCP isError results instead of returning a successful Pi value", async () => {
    const connection = {
      status: "connected",
      client: { callTool: vi.fn(async () => ({ isError: true, content: [{ type: "text", text: "denied" }] })) },
    };
    const state = {
      config: { settings: {}, mcpServers: { demo: { command: "demo" } } },
      manager: {
        getConnection: vi.fn(() => connection), touch: vi.fn(), incrementInFlight: vi.fn(), decrementInFlight: vi.fn(),
      },
      failureTracker: new Map(), completedUiSessions: [],
    } as any;
    mocks.lazyConnect.mockResolvedValue(true);
    const executor = createDirectToolExecutor(() => state, () => null, {
      serverName: "demo", originalName: "search", prefixedName: "demo_search", description: "Search",
    });

    await expect(executor("id", {}, undefined, undefined, undefined as any)).rejects.toThrow(/denied/);
  });

  it("settles an MCP UI exactly once for an error result", async () => {
    const runtime = {
      requestMeta: undefined,
      reused: false,
      sendToolResult: vi.fn(),
      sendToolCancelled: vi.fn(),
      close: vi.fn(),
    };
    mocks.maybeStartUiSession.mockResolvedValue(runtime);
    const connection = {
      status: "connected",
      client: { callTool: vi.fn(async () => ({ isError: true, content: [{ type: "text", text: "denied" }] })) },
    };
    const state = {
      config: { settings: {}, mcpServers: { demo: { command: "demo" } } },
      manager: {
        getConnection: vi.fn(() => connection), touch: vi.fn(), incrementInFlight: vi.fn(), decrementInFlight: vi.fn(),
      },
      failureTracker: new Map(), completedUiSessions: [],
    } as any;
    mocks.lazyConnect.mockResolvedValue(true);
    const executor = createDirectToolExecutor(() => state, () => null, {
      serverName: "demo", originalName: "search", prefixedName: "demo_search", description: "Search",
      uiResourceUri: "ui://demo/app",
    });

    await expect(executor("id", {}, undefined, undefined, undefined as any)).rejects.toThrow("denied");
    expect(runtime.sendToolResult).toHaveBeenCalledTimes(1);
    expect(runtime.sendToolCancelled).not.toHaveBeenCalled();
  });

  it("fails fast in non-ui context for browser-based OAuth", async () => {

    const state = {
      config: {
        settings: { autoAuth: true },
        mcpServers: {
          demo: { url: "https://api.example.com/mcp", auth: "oauth" },
        },
      },
      manager: {
        close: vi.fn(async () => {}),
        getConnection: vi.fn(() => ({ status: "needs-auth" })),
        touch: vi.fn(),
        incrementInFlight: vi.fn(),
        decrementInFlight: vi.fn(),
      },
      failureTracker: new Map(),
      ui: undefined,
      completedUiSessions: [],
    } as any;

    mocks.lazyConnect.mockResolvedValue(false);

    const executor = createDirectToolExecutor(
      () => state,
      () => null,
      {
        serverName: "demo",
        originalName: "search",
        prefixedName: "demo_search",
        description: "Search",
      },
    );

    await expect(executor("id", {}, undefined as any, () => {}, undefined as any))
      .rejects.toThrow(/\/mcp-auth demo.*interactive session/s);

    expect(mocks.authenticate).not.toHaveBeenCalled();
  });

  it("uses custom authRequiredMessage in non-ui direct tool auth failures", async () => {

    const state = {
      config: {
        settings: {
          autoAuth: true,
          authRequiredMessage: "Reconnect ${server} from the host app.",
        },
        mcpServers: {
          demo: { url: "https://api.example.com/mcp", auth: "oauth" },
        },
      },
      manager: {
        close: vi.fn(async () => {}),
        getConnection: vi.fn(() => ({ status: "needs-auth" })),
        touch: vi.fn(),
        incrementInFlight: vi.fn(),
        decrementInFlight: vi.fn(),
      },
      failureTracker: new Map(),
      ui: undefined,
      completedUiSessions: [],
    } as any;

    mocks.lazyConnect.mockResolvedValue(false);

    const executor = createDirectToolExecutor(
      () => state,
      () => null,
      {
        serverName: "demo",
        originalName: "search",
        prefixedName: "demo_search",
        description: "Search",
      },
    );

    await expect(executor("id", {}, undefined as any, () => {}, undefined as any))
      .rejects.toThrow("Reconnect demo from the host app.");

    expect(mocks.authenticate).not.toHaveBeenCalled();
  });
});
