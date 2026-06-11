import { beforeEach, describe, expect, it, vi } from "vitest";
import { initializeMcp, isLocalTuiExecution } from "../init.ts";

const mocks = vi.hoisted(() => ({
  loadMcpConfig: vi.fn(),
  managers: [] as any[],
}));

vi.mock("../config.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config.ts")>()),
  loadMcpConfig: mocks.loadMcpConfig,
}));

vi.mock("../server-manager.ts", () => ({
  McpServerManager: vi.fn().mockImplementation(function (this: any) {
    this.setSamplingConfig = vi.fn();
    this.setElicitationConfig = vi.fn();
    this.getConnection = vi.fn();
    this.connect = vi.fn();
    mocks.managers.push(this);
  }),
}));

describe("initializeMcp elicitation config", () => {
  beforeEach(() => {
    mocks.managers.length = 0;
    mocks.loadMcpConfig.mockReturnValue({ mcpServers: {}, settings: {} });
  });

  it("enables elicitation with the stock Pi UI context", async () => {
    const ui = { select: vi.fn(), input: vi.fn(), notify: vi.fn() };

    await initializeMcp({ getFlag: vi.fn() } as any, {
      cwd: "/tmp/project",
      hasUI: true,
      mode: "tui",
      ui,
      modelRegistry: {},
    } as any);

    expect(mocks.managers[0].setElicitationConfig).toHaveBeenCalledWith({
      ui,
      allowUrl: true,
    });
  });

  it("keeps form elicitation but disables backend URL navigation in RPC mode", async () => {
    const ui = { select: vi.fn(), input: vi.fn(), notify: vi.fn() };
    await initializeMcp({ getFlag: vi.fn() } as any, {
      cwd: "/tmp/project",
      hasUI: true,
      mode: "rpc",
      ui,
      modelRegistry: {},
    } as any);

    expect(mocks.managers[0].setElicitationConfig).toHaveBeenCalledWith({ ui, allowUrl: false });
  });

  it("detects RPC from the real CLI arguments when Pi omits ctx.mode", () => {
    expect(isLocalTuiExecution({ hasUI: true } as any, ["node", "pi", "--mode", "rpc"], true)).toBe(false);
    expect(isLocalTuiExecution({ hasUI: true } as any, ["node", "pi", "--mode=rpc"], true)).toBe(false);
    expect(isLocalTuiExecution({ hasUI: true } as any, ["node", "pi"], true)).toBe(true);
    expect(isLocalTuiExecution({ hasUI: true } as any, ["node", "pi"], false)).toBe(false);
  });

  it("does not enable elicitation without UI or when disabled in settings", async () => {
    await initializeMcp({ getFlag: vi.fn() } as any, {
      cwd: "/tmp/project",
      hasUI: false,
      modelRegistry: {},
    } as any);
    expect(mocks.managers[0].setElicitationConfig).not.toHaveBeenCalled();

    mocks.loadMcpConfig.mockReturnValue({ mcpServers: {}, settings: { elicitation: false } });
    await initializeMcp({ getFlag: vi.fn() } as any, {
      cwd: "/tmp/project",
      hasUI: true,
      ui: { select: vi.fn(), input: vi.fn(), notify: vi.fn() },
      modelRegistry: {},
    } as any);
    expect(mocks.managers[1].setElicitationConfig).not.toHaveBeenCalled();
  });
});
