import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UrlElicitationRequiredError } from "@modelcontextprotocol/sdk/types.js";
import { McpServerManager } from "../server-manager.ts";
import { homedir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({
  clients: [] as any[],
  transports: [] as any[],
  open: vi.fn(async () => undefined),
}));

vi.mock("open", () => ({ default: mocks.open }));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn().mockImplementation(function (this: any, info: unknown, options: unknown) {
    this.info = info;
    this.options = options;
    this.setRequestHandler = vi.fn();
    this.setNotificationHandler = vi.fn();
    this.connect = vi.fn(async () => undefined);
    this.listTools = vi.fn(async () => ({ tools: [] }));
    this.listResources = vi.fn(async () => ({ resources: [] }));
    this.close = vi.fn(async () => undefined);
    mocks.clients.push(this);
  }),
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn().mockImplementation(function (this: any, options: unknown) {
    this.options = options;
    this.close = vi.fn(async () => undefined);
    mocks.transports.push(this);
  }),
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: vi.fn(),
}));

vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: vi.fn(),
}));

vi.mock("../npx-resolver.ts", () => ({
  resolveNpxBinary: vi.fn(async () => null),
}));

describe("McpServerManager sampling", () => {
  const originalMcpTestCwd = process.env.MCP_TEST_CWD;

  beforeEach(() => {
    mocks.clients.length = 0;
    mocks.transports.length = 0;
    mocks.open.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (originalMcpTestCwd === undefined) {
      delete process.env.MCP_TEST_CWD;
    } else {
      process.env.MCP_TEST_CWD = originalMcpTestCwd;
    }
  });

  it("advertises sampling and registers the handler before connecting", async () => {
    const manager = new McpServerManager();
    manager.setSamplingConfig({
      autoApprove: true,
      modelRegistry: {} as any,
      getCurrentModel: () => undefined,
      getSignal: () => undefined,
    });

    await manager.connect("demo", { command: "node", args: ["server.js"] });

    const client = mocks.clients[0];
    expect(client.options).toEqual({ capabilities: { sampling: {} } });
    expect(client.setRequestHandler).toHaveBeenCalledTimes(1);
    expect(client.setRequestHandler.mock.invocationCallOrder[0]).toBeLessThan(
      client.connect.mock.invocationCallOrder[0],
    );
  });

  it("advertises elicitation capabilities and registers the handler before connecting", async () => {
    const manager = new McpServerManager();
    manager.setElicitationConfig({
      ui: {} as any,
    });

    await manager.connect("demo", { command: "node", args: ["server.js"] });

    const client = mocks.clients[0];
    expect(client.options).toEqual({
      capabilities: {
        elicitation: {
          form: {},
          url: {},
        },
      },
    });
    expect(client.setRequestHandler).toHaveBeenCalledTimes(1);
    expect(client.setRequestHandler.mock.invocationCallOrder[0]).toBeLessThan(
      client.connect.mock.invocationCallOrder[0],
    );
  });

  it("advertises form-only elicitation when URL navigation is unavailable", async () => {
    const manager = new McpServerManager();
    manager.setElicitationConfig({ ui: {} as any, allowUrl: false });
    await manager.connect("rpc", { command: "node", args: ["server.js"] });

    expect(mocks.clients[0].options).toEqual({ capabilities: { elicitation: { form: {} } } });
  });

  it("rejects malformed or empty URL-required error payloads", async () => {
    const manager = new McpServerManager();
    manager.setElicitationConfig({ ui: { select: vi.fn(), notify: vi.fn() } as any });

    await expect(manager.handleUrlElicitationRequired("demo", new UrlElicitationRequiredError([])))
      .rejects.toMatchObject({ code: -32602 });
    await expect(manager.handleUrlElicitationRequired("demo", new UrlElicitationRequiredError([{
      mode: "url", message: 42, elicitationId: "bad", url: "https://example.com/",
    } as any]))).rejects.toMatchObject({ code: -32602 });
  });

  it("handles URL-required errors and only reports known completion notifications once", async () => {
    const manager = new McpServerManager();
    const ui = { select: vi.fn(async () => "Open"), notify: vi.fn() };
    manager.setElicitationConfig({ ui: ui as any });
    await manager.connect("demo", { command: "node", args: ["server.js"] });

    const error = new UrlElicitationRequiredError([{
      mode: "url",
      message: "Connect account",
      elicitationId: "connect-1",
      url: "https://example.com/connect",
    }]);
    await expect(manager.handleUrlElicitationRequired("demo", error)).resolves.toBe("accept");
    expect(mocks.open).toHaveBeenCalledWith("https://example.com/connect");

    const client = mocks.clients[0];
    const completionCall = client.setNotificationHandler.mock.calls.find(
      ([schema]: any[]) => schema.shape?.method?.value === "notifications/elicitation/complete",
    );
    expect(completionCall).toBeDefined();
    const completionHandler = completionCall![1];
    completionHandler({ params: { elicitationId: "connect-1" } });
    completionHandler({ params: { elicitationId: "connect-1" } });
    completionHandler({ params: { elicitationId: "unknown" } });

    expect(ui.notify).toHaveBeenCalledWith(
      "MCP browser interaction for demo completed. You can retry the tool now.",
      "info",
    );
    expect(ui.notify).toHaveBeenCalledTimes(2); // browser opened + one known completion
  });

  it("tracks completion before browser launch and rejects duplicate active IDs", async () => {
    const manager = new McpServerManager();
    const ui = { select: vi.fn(async () => "Open"), notify: vi.fn() };
    manager.setElicitationConfig({ ui: ui as any });
    await manager.connect("demo", { command: "node", args: ["server.js"] });
    const client = mocks.clients[0];
    const completionHandler = client.setNotificationHandler.mock.calls.find(
      ([schema]: any[]) => schema.shape?.method?.value === "notifications/elicitation/complete",
    )![1];
    mocks.open.mockImplementationOnce(async () => completionHandler({ params: { elicitationId: "race" } }));
    const makeError = () => new UrlElicitationRequiredError([{
      mode: "url", message: "Connect", elicitationId: "race", url: "https://example.com/connect",
    }]);

    await expect(manager.handleUrlElicitationRequired("demo", makeError())).resolves.toBe("accept");
    expect(ui.notify).toHaveBeenCalledWith(
      "MCP browser interaction for demo completed. You can retry the tool now.", "info",
    );

    await expect(manager.handleUrlElicitationRequired("demo", makeError())).resolves.toBe("accept");
    await expect(manager.handleUrlElicitationRequired("demo", makeError()))
      .rejects.toMatchObject({ code: -32602 });
    expect(ui.select).toHaveBeenCalledTimes(2);
  });

  it("keeps opaque URL completion identities isolated across servers", () => {
    const manager = new McpServerManager() as any;
    manager.reservePendingUrlElicitation("a", "b\0c");
    manager.reservePendingUrlElicitation("a\0b", "c");

    expect(manager.pendingUrlElicitations.size).toBe(2);
  });

  it("reports URL completion capacity exhaustion without evicting active IDs", async () => {
    const manager = new McpServerManager();
    const ui = { select: vi.fn(async () => "Open"), notify: vi.fn() };
    manager.setElicitationConfig({ ui: ui as any });
    await manager.connect("demo", { command: "node", args: ["server.js"] });
    const pending = (manager as any).pendingUrlElicitations as Map<string, { acceptedAt: number; serverName: string }>;
    for (let index = 0; index < 256; index++) pending.set(`demo-${index}`, { acceptedAt: Date.now(), serverName: "demo" });
    const firstKey = pending.keys().next().value;
    const error = new UrlElicitationRequiredError([{
      mode: "url", message: "Connect", elicitationId: "overflow", url: "https://example.com/connect",
    }]);

    await expect(manager.handleUrlElicitationRequired("demo", error)).rejects.toMatchObject({ code: -32603 });
    expect(pending.has(firstKey)).toBe(true);
  });

  it("advertises sampling and elicitation together", async () => {
    const manager = new McpServerManager();
    manager.setSamplingConfig({
      autoApprove: true,
      modelRegistry: {} as any,
      getCurrentModel: () => undefined,
      getSignal: () => undefined,
    });
    manager.setElicitationConfig({
      ui: {} as any,
    });

    await manager.connect("demo", { command: "node", args: ["server.js"] });

    expect(mocks.clients[0].options).toEqual({
      capabilities: {
        sampling: {},
        elicitation: {
          form: {},
          url: {},
        },
      },
    });
    expect(mocks.clients[0].setRequestHandler).toHaveBeenCalledTimes(2);
  });

  it("does not advertise sampling when no sampling config is set", async () => {
    const manager = new McpServerManager();

    await manager.connect("demo", { command: "node", args: ["server.js"] });

    const client = mocks.clients[0];
    expect(client.options).toBeUndefined();
    expect(client.setRequestHandler).not.toHaveBeenCalled();
  });

  it("expands environment variables and tilde in stdio cwd", async () => {
    process.env.MCP_TEST_CWD = "/tmp/pi-mcp-cwd";

    const envManager = new McpServerManager();
    await envManager.connect("env-cwd", {
      command: "node",
      args: ["server.js"],
      cwd: "${MCP_TEST_CWD}/nested",
    });

    const homeManager = new McpServerManager();
    await homeManager.connect("home-cwd", {
      command: "node",
      args: ["server.js"],
      cwd: "~/nested",
    });

    expect(mocks.transports[0].options).toMatchObject({ cwd: "/tmp/pi-mcp-cwd/nested" });
    expect(mocks.transports[1].options).toMatchObject({ cwd: join(homedir(), "nested") });
  });
});
