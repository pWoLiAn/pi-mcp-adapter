import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveNpx: vi.fn(),
  clients: [] as any[],
  transports: [] as any[],
  connectBehavior: vi.fn(async () => undefined),
  httpTransports: [] as any[],
}));

vi.mock("../npx-resolver.ts", () => ({ resolveNpxBinary: mocks.resolveNpx }));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn().mockImplementation(function (this: any) {
    this.connect = vi.fn(() => mocks.connectBehavior());
    this.close = vi.fn(async () => undefined);
    this.listTools = vi.fn(async () => ({ tools: [] }));
    this.listResources = vi.fn(async () => ({ resources: [] }));
    this.setNotificationHandler = vi.fn();
    this.setRequestHandler = vi.fn();
    mocks.clients.push(this);
  }),
}));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn().mockImplementation(function (this: any) {
    this.close = vi.fn(async () => undefined);
    mocks.transports.push(this);
  }),
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: vi.fn().mockImplementation(function (this: any) {
    this.close = vi.fn(async () => undefined);
    mocks.httpTransports.push(this);
  }),
}));
vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: vi.fn().mockImplementation(function (this: any) { this.close = vi.fn(async () => undefined); }),
}));

import { McpServerManager } from "../server-manager.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("McpServerManager lifecycle", () => {
  beforeEach(() => {
    mocks.clients.length = 0;
    mocks.transports.length = 0;
    mocks.httpTransports.length = 0;
    mocks.resolveNpx.mockReset();
    mocks.connectBehavior.mockReset().mockResolvedValue(undefined);
  });

  it("cancels a connection before asynchronous transport preparation completes", async () => {
    const resolution = deferred<null>();
    mocks.resolveNpx.mockReturnValue(resolution.promise);
    const manager = new McpServerManager();

    const connecting = manager.connect("slow", { command: "npx", args: ["slow-server"] });
    const shutdown = manager.closeAll();
    resolution.resolve(null);

    await expect(connecting).rejects.toMatchObject({ name: "AbortError" });
    await shutdown;
    expect(mocks.transports).toHaveLength(0);
    expect(mocks.clients[0].close).toHaveBeenCalled();
  });

  it("cancels an HTTP capability probe during shutdown", async () => {
    const probing = deferred<void>();
    mocks.connectBehavior.mockReturnValueOnce(probing.promise);
    const manager = new McpServerManager();

    const connecting = manager.connect("http", { url: "https://example.com/mcp" });
    await vi.waitFor(() => expect(mocks.httpTransports).toHaveLength(1));
    const shutdown = manager.closeAll();

    await expect(connecting).rejects.toMatchObject({ name: "AbortError" });
    await shutdown;
    expect(mocks.httpTransports[0].close).toHaveBeenCalled();
    probing.resolve();
  });

  it("lets a cancelled caller stop waiting for a shared lazy connection", async () => {
    mocks.resolveNpx.mockResolvedValue(null);
    const connected = deferred<void>();
    mocks.connectBehavior.mockReturnValue(connected.promise);
    const manager = new McpServerManager();
    const controller = new AbortController();

    const pending = manager.connect("slow", { command: "node", args: ["server.js"] }, controller.signal);
    await vi.waitFor(() => expect(mocks.clients[0].connect).toHaveBeenCalled());
    controller.abort(new Error("tool cancelled"));
    await expect(pending).rejects.toThrow("tool cancelled");
    expect(mocks.clients[0].close).toHaveBeenCalled();
    expect(mocks.transports[0].close).toHaveBeenCalled();
    connected.resolve();
    await manager.closeAll();
  });
});
