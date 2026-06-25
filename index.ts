import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { McpExtensionState } from "./state.ts";
import { Type } from "typebox";
import { loadMcpConfig } from "./config.ts";
import { flushMetadataCache, initializeMcp, updateStatusBar, getFailureAgeSeconds, updateMetadataCache, lazyConnect } from "./init.ts";
import { executeCall, executeConnect, executeDescribe, executeList, executeSearch, executeStatus } from "./proxy-modes.ts";
import { getConfigPathFromArgv, truncateAtWord } from "./utils.ts";
import { renderMcpProxyToolCall, renderMcpToolResult } from "./tool-result-renderer.ts";
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
