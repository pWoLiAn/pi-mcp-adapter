import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { McpExtensionState } from "./state.ts";
import { Type } from "typebox";
import { loadMcpConfig } from "./config.ts";
import { flushMetadataCache, initializeMcp, updateStatusBar, getFailureAgeSeconds, updateMetadataCache, lazyConnect } from "./init.ts";
import { loadMetadataCache } from "./metadata-cache.ts";
import { executeCall, executeConnect, executeDescribe, executeList, executeSearch, executeStatus } from "./proxy-modes.ts";
import { getConfigPathFromArgv, truncateAtWord } from "./utils.ts";
import { renderMcpProxyToolCall, renderMcpToolResult } from "./tool-result-renderer.ts";
import { getMcpDiscoverySummary, getServerProvenance, writeDirectToolsConfig } from "./config.ts";
import { buildToolMetadata } from "./tool-metadata.ts";

export default function mcpAdapter(pi: ExtensionAPI) {
  let state: McpExtensionState | null = null;
  let initPromise: Promise<McpExtensionState> | null = null;
  let lifecycleGeneration = 0;

  async function shutdownState(currentState: McpExtensionState | null, reason: string): Promise<void> {
    if (!currentState) return;

    let flushError: unknown;
    try {
      flushMetadataCache(currentState);
    } catch (error) {
      flushError = error;
    }

    try {
      await currentState.lifecycle.gracefulShutdown();
    } catch (error) {
      if (flushError) {
        console.error("MCP: graceful shutdown failed after metadata flush error", error);
      } else {
        throw error;
      }
    }

    if (flushError) {
      throw flushError;
    }
  }

  const earlyConfigPath = getConfigPathFromArgv();
  const earlyConfig = loadMcpConfig(earlyConfigPath);

  pi.registerFlag("mcp-config", {
    description: "Path to MCP config file",
    type: "string",
  });

  const getPiTools = () => pi.getAllTools();

  pi.on("session_start", async (_event, ctx) => {
    const generation = ++lifecycleGeneration;
    const previousState = state;
    state = null;
    initPromise = null;

    try {
      await shutdownState(previousState, "session_restart");
    } catch (error) {
      console.error("MCP: failed to shut down previous session state", error);
    }

    if (generation !== lifecycleGeneration) {
      return;
    }

    const promise = initializeMcp(pi, ctx);
    initPromise = promise;

    promise.then(async (nextState) => {
      if (generation !== lifecycleGeneration || initPromise !== promise) {
        try {
          await shutdownState(nextState, "stale_session_start");
        } catch (error) {
          console.error("MCP: failed to clean stale session state", error);
        }
        return;
      }

      state = nextState;
      updateStatusBar(nextState);
      initPromise = null;
    }).catch(err => {
      if (generation !== lifecycleGeneration) {
        return;
      }
      if (initPromise !== promise && initPromise !== null) {
        return;
      }
      console.error("MCP initialization failed:", err);
      initPromise = null;
    });
  });

  pi.on("session_shutdown", async () => {
    ++lifecycleGeneration;
    const currentState = state;
    state = null;
    initPromise = null;

    try {
      await shutdownState(currentState, "session_shutdown");
    } catch (error) {
      console.error("MCP: session shutdown cleanup failed", error);
    }
  });

  pi.registerCommand("mcp", {
    description: "Show MCP server status",
    handler: async (args, ctx) => {
      if (!state && initPromise) {
        try {
          state = await initPromise;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (ctx.hasUI) ctx.ui.notify(`MCP initialization failed: ${message}`, "error");
          return;
        }
      }
      if (!state) {
        if (ctx.hasUI) ctx.ui.notify("MCP not initialized", "error");
        return;
      }

      const parts = args?.trim()?.split(/\s+/) ?? [];
      const subcommand = parts[0] ?? "";
      const targetServer = parts[1];

      switch (subcommand) {
        case "reconnect":
          await reconnectServers(state, ctx, targetServer);
          break;
        case "tools":
          await showTools(state, ctx);
          break;
        case "status":
        case "":
        default:
          if (ctx.hasUI) {
            await openMcpPanel(state, pi, ctx, earlyConfigPath);
          } else {
            await showStatus(state, ctx);
          }
          break;
      }
    },
  });

  (pi.registerTool as (tool: unknown) => unknown)({
    name: "mcp",
    label: "MCP",
    description: buildProxyDescription(earlyConfig),
    promptSnippet: "MCP gateway - connect to MCP servers and call their tools",
    renderCall: renderMcpProxyToolCall,
    parameters: Type.Object({
      tool: Type.Optional(Type.String({ description: "Tool name to call (e.g., 'xcodebuild_list_sims')" })),
      args: Type.Optional(Type.String({ description: "Arguments as JSON string (e.g., '{\"key\": \"value\"}')" })),
      connect: Type.Optional(Type.String({ description: "Server name to connect (lazy connect + metadata refresh)" })),
      describe: Type.Optional(Type.String({ description: "Tool name to describe (shows parameters)" })),
      search: Type.Optional(Type.String({ description: "Search tools by name/description" })),
      regex: Type.Optional(Type.Boolean({ description: "Treat search as regex (default: substring match)" })),
      includeSchemas: Type.Optional(Type.Boolean({ description: "Include parameter schemas in search results (default: true)" })),
      server: Type.Optional(Type.String({ description: "Filter to specific server (also disambiguates tool calls)" })),
    }),
    renderResult: renderMcpToolResult,
    async execute(_toolCallId, params: {
      tool?: string;
      args?: string;
      connect?: string;
      describe?: string;
      search?: string;
      regex?: boolean;
      includeSchemas?: boolean;
      server?: string;
    }, _signal, _onUpdate, _ctx) {
      let parsedArgs: Record<string, unknown> | undefined;
      if (params.args) {
        try {
          parsedArgs = JSON.parse(params.args);
          if (typeof parsedArgs !== "object" || parsedArgs === null || Array.isArray(parsedArgs)) {
            const gotType = Array.isArray(parsedArgs) ? "array" : parsedArgs === null ? "null" : typeof parsedArgs;
            throw new Error(`Invalid args: expected a JSON object, got ${gotType}`);
          }
        } catch (error) {
          if (error instanceof SyntaxError) {
            throw new Error(`Invalid args JSON: ${error.message}`, { cause: error });
          }
          throw error;
        }
      }

      if (!state && initPromise) {
        try {
          state = await initPromise;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            content: [{ type: "text" as const, text: `MCP initialization failed: ${message}` }],
            details: { error: "init_failed", message },
          };
        }
      }
      if (!state) {
        return {
          content: [{ type: "text" as const, text: "MCP not initialized" }],
          details: { error: "not_initialized" },
        };
      }

      if (params.tool) {
        return executeCall(state, params.tool, parsedArgs, params.server, getPiTools);
      }
      if (params.connect) {
        return executeConnect(state, params.connect);
      }
      if (params.describe) {
        return executeDescribe(state, params.describe);
      }
      if (params.search) {
        return executeSearch(state, params.search, params.regex, params.server, params.includeSchemas);
      }
      if (params.server) {
        return executeList(state, params.server);
      }
      return executeStatus(state);
    },
  });
}

function buildProxyDescription(config: ReturnType<typeof loadMcpConfig>): string {
  const serverNames = Object.keys(config.mcpServers);
  if (serverNames.length === 0) {
    return "MCP gateway - connect to MCP servers and call their tools.\n\nNo servers configured yet.";
  }
  const serverList = serverNames.map(n => `- ${n}`).join("\n");
  return `MCP gateway - connect to MCP servers and call their tools.\n\nConfigured servers:\n${serverList}\n\nUsage:\n  mcp({})                              → Show server status\n  mcp({ server: "name" })               → List tools from server\n  mcp({ search: "query" })              → Search MCP tools by name/description\n  mcp({ describe: "tool_name" })        → Show tool details and parameters\n  mcp({ connect: "server-name" })       → Connect to a server and refresh metadata\n  mcp({ tool: "name", args: '{"key": "value"}' })    → Call a tool (args is JSON string)`;
}

async function showStatus(state: McpExtensionState, ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return;

  const lines: string[] = ["MCP Server Status:", ""];

  for (const name of Object.keys(state.config.mcpServers)) {
    const connection = state.manager.getConnection(name);
    const metadata = state.toolMetadata.get(name);
    const toolCount = metadata?.length ?? 0;
    const failedAgo = getFailureAgeSeconds(state, name);
    let status = "not connected";
    let statusIcon = "○";
    let failed = false;

    if (connection?.status === "connected") {
      status = "connected";
      statusIcon = "✓";
    } else if (connection?.status === "needs-auth") {
      status = "needs auth";
      statusIcon = "⚠";
    } else if (failedAgo !== null) {
      status = `failed ${failedAgo}s ago`;
      statusIcon = "✗";
      failed = true;
    } else if (metadata !== undefined) {
      status = "cached";
    }

    const toolSuffix = failed ? "" : ` (${toolCount} tools${status === "cached" ? ", cached" : ""})`;
    lines.push(`${statusIcon} ${name}: ${status}${toolSuffix}`);
  }

  if (Object.keys(state.config.mcpServers).length === 0) {
    lines.push("No MCP servers configured");
  }

  ctx.ui.notify(lines.join("\n"), "info");
}

async function showTools(state: McpExtensionState, ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return;

  const allTools = [...state.toolMetadata.values()].flat().map(m => m.name);

  if (allTools.length === 0) {
    ctx.ui.notify("No MCP tools available", "info");
    return;
  }

  const lines = [
    "MCP Tools:",
    "",
    ...allTools.map(t => `  ${t}`),
    "",
    `Total: ${allTools.length} tools`,
  ];

  ctx.ui.notify(lines.join("\n"), "info");
}

async function reconnectServers(
  state: McpExtensionState,
  ctx: ExtensionContext,
  targetServer?: string
): Promise<void> {
  if (targetServer && !state.config.mcpServers[targetServer]) {
    if (ctx.hasUI) {
      ctx.ui.notify(`Server "${targetServer}" not found in config`, "error");
    }
    return;
  }

  const entries = targetServer
    ? [[targetServer, state.config.mcpServers[targetServer]] as [string, (typeof state.config.mcpServers)[string]]]
    : Object.entries(state.config.mcpServers);

  const prefix = state.config.settings?.toolPrefix ?? "server";

  for (const [name, definition] of entries) {
    try {
      await state.manager.close(name);

      const connection = await state.manager.connect(name, definition);
      if (connection.status === "needs-auth") {
        if (ctx.hasUI) {
          ctx.ui.notify(`MCP: ${name} requires authentication.`, "warning");
        }
        continue;
      }

      const { metadata, failedTools } = buildToolMetadata(connection.tools, connection.resources, definition, name, prefix);
      state.toolMetadata.set(name, metadata);
      updateMetadataCache(state, name);
      state.failureTracker.delete(name);

      if (ctx.hasUI) {
        ctx.ui.notify(
          `MCP: Reconnected to ${name} (${connection.tools.length} tools, ${connection.resources.length} resources)`,
          "info"
        );
        if (failedTools.length > 0) {
          ctx.ui.notify(`MCP: ${name} - ${failedTools.length} tools skipped`, "warning");
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.failureTracker.set(name, Date.now());
      if (ctx.hasUI) {
        ctx.ui.notify(`MCP: Failed to reconnect to ${name}: ${message}`, "error");
      }
    }
  }

  updateStatusBar(state);
}

interface PanelFlowResult {
  configChanged: boolean;
}

async function openMcpPanel(
  state: McpExtensionState,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  configOverridePath?: string,
): Promise<PanelFlowResult> {
  if (!ctx.hasUI) return { configChanged: false };

  const config = state.config;
  const cache = loadMetadataCache();
  const configPath = pi.getFlag("mcp-config") as string | undefined ?? configOverridePath;
  const provenanceMap = getServerProvenance(configPath, ctx.cwd);

  const { createMcpPanel } = await import("./mcp-panel.ts");
  let configChanged = false;

  const callbacks = {
    reconnect: (serverName: string) => lazyConnect(state, serverName),
    canAuthenticate: (_serverName: string) => false,
    authenticate: async (_serverName: string) => ({ ok: false, message: "OAuth not supported in this build" }),
    getConnectionStatus: (serverName: string) => {
      const connection = state.manager.getConnection(serverName);
      if (connection?.status === "needs-auth") return "needs-auth" as const;
      if (connection?.status === "connected") return "connected" as const;
      if (getFailureAgeSeconds(state, serverName) !== null) return "failed" as const;
      return "idle" as const;
    },
    refreshCacheAfterReconnect: (serverName: string) => {
      const freshCache = loadMetadataCache();
      return freshCache?.servers?.[serverName] ?? null;
    },
  };

  // Build a notice about shared config if applicable
  let noticeLines: string[] = [];
  try {
    const discovery = getMcpDiscoverySummary(configPath, ctx.cwd);
    const sharedSources = discovery.sources.filter((source) => source.kind === "shared" && source.serverCount > 0);
    if (discovery.hasSharedServers && sharedSources.length > 0) {
      const sourceList = sharedSources.map((source) => source.path).join(", ");
      noticeLines = [
        `Using standard MCP config from ${sourceList}.`,
        "Pi only writes compatibility imports and adapter-specific overrides into Pi-owned files when needed.",
      ];
    }
  } catch {
    // Ignore discovery errors
  }

  await new Promise<void>((resolve) => {
    ctx.ui.custom(
      (tui, _theme, keybindings, done) => {
        return createMcpPanel(config, cache, provenanceMap, callbacks, tui, (result) => {
          if (!result.cancelled && result.changes.size > 0) {
            writeDirectToolsConfig(result.changes, provenanceMap, config);
            configChanged = true;
            ctx.ui.notify("Direct tools updated. Pi will reload after this panel closes.", "info");
          }
          done(undefined);
          resolve();
        }, { noticeLines, keybindings });
      },
      { overlay: true, overlayOptions: { anchor: "center", width: 82 } },
    );
  });

  return { configChanged };
}
