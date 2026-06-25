import type { AgentToolResult, ToolInfo } from "@earendil-works/pi-coding-agent";
import { checkSync } from "recheck";
import type { McpExtensionState } from "./state.ts";
import type { ToolMetadata, McpContent } from "./types.ts";
import { getServerPrefix } from "./types.ts";
import { lazyConnect, updateServerMetadata, updateMetadataCache, getFailureAgeSeconds, updateStatusBar } from "./init.ts";
import { buildToolMetadata, getToolNames, findToolByName, formatSchema } from "./tool-metadata.ts";
import { transformMcpContent } from "./tool-registrar.ts";
import { formatAuthRequiredMessage, truncateAtWord } from "./utils.ts";

type ProxyToolResult = AgentToolResult<Record<string, unknown>>;

const MAX_REGEX_SEARCH_QUERY_LENGTH = 256;
const REGEX_SAFETY_CHECK_PARAMS = {
  attackTimeout: 50,
  incubationTimeout: 50,
  timeout: 250,
} as const;

function getAuthRequiredMessage(
  state: McpExtensionState,
  serverName: string,
  defaultMessage = `Server "${serverName}" requires authentication. Contact the server administrator.`,
): string {
  return formatAuthRequiredMessage(state.config, serverName, defaultMessage);
}

export function executeStatus(state: McpExtensionState): ProxyToolResult {
  const servers: Array<{ name: string; status: string; toolCount: number; failedAgo: number | null }> = [];

  for (const name of Object.keys(state.config.mcpServers)) {
    const connection = state.manager.getConnection(name);
    const metadata = state.toolMetadata.get(name);
    const toolCount = metadata?.length ?? 0;
    const failedAgo = getFailureAgeSeconds(state, name);
    let status = "not connected";
    if (connection?.status === "connected") {
      status = "connected";
    } else if (connection?.status === "needs-auth") {
      status = "needs-auth";
    } else if (failedAgo !== null) {
      status = "failed";
    } else if (metadata !== undefined) {
      status = "cached";
    }

    servers.push({ name, status, toolCount, failedAgo });
  }

  const totalTools = servers.reduce((sum, s) => sum + s.toolCount, 0);
  const connectedCount = servers.filter(s => s.status === "connected").length;

  let text = `MCP: ${connectedCount}/${servers.length} servers, ${totalTools} tools\n\n`;
  for (const server of servers) {
    if (server.status === "connected") {
      text += `✓ ${server.name} (${server.toolCount} tools)\n`;
      continue;
    }
    if (server.status === "needs-auth") {
      text += `⚠ ${server.name} (needs auth)\n`;
      continue;
    }
    if (server.status === "cached") {
      text += `○ ${server.name} (${server.toolCount} tools, cached)\n`;
      continue;
    }
    if (server.status === "failed") {
      text += `✗ ${server.name} (failed ${server.failedAgo ?? 0}s ago)\n`;
      continue;
    }
    text += `○ ${server.name} (not connected)\n`;
  }

  if (servers.length > 0) {
    text += `\nmcp({ server: "name" }) to list tools, mcp({ search: "..." }) to search`;
  }

  return {
    content: [{ type: "text" as const, text: text.trim() }],
    details: { mode: "status", servers, totalTools, connectedCount },
  };
}

export function executeDescribe(state: McpExtensionState, toolName: string): ProxyToolResult {
  let serverName: string | undefined;
  let toolMeta: ToolMetadata | undefined;

  for (const [server, metadata] of state.toolMetadata.entries()) {
    const found = findToolByName(metadata, toolName);
    if (found) {
      serverName = server;
      toolMeta = found;
      break;
    }
  }

  if (!serverName || !toolMeta) {
    return {
      content: [{ type: "text" as const, text: `Tool "${toolName}" not found. Use mcp({ search: "..." }) to search.` }],
      details: { mode: "describe", error: "tool_not_found", requestedTool: toolName },
    };
  }

  let text = `${toolMeta.name}\n`;
  text += `Server: ${serverName}\n`;
  if (toolMeta.resourceUri) {
    text += `Type: Resource (reads from ${toolMeta.resourceUri})\n`;
  }
  text += `\n${toolMeta.description || "(no description)"}\n`;

  if (toolMeta.inputSchema && !toolMeta.resourceUri) {
    text += `\nParameters:\n${formatSchema(toolMeta.inputSchema)}`;
  } else if (toolMeta.resourceUri) {
    text += `\nNo parameters required (resource tool).`;
  } else {
    text += `\nNo parameters defined.`;
  }

  return {
    content: [{ type: "text" as const, text: text.trim() }],
    details: { mode: "describe", tool: toolMeta, server: serverName },
  };
}

export function executeSearch(
  state: McpExtensionState,
  query: string,
  regex?: boolean,
  server?: string,
  includeSchemas?: boolean,
): ProxyToolResult {
  const showSchemas = includeSchemas !== false;

  const matches: Array<{ server: string; tool: ToolMetadata }> = [];

  let pattern: RegExp;
  try {
    if (regex) {
      if (query.length > MAX_REGEX_SEARCH_QUERY_LENGTH) {
        return {
          content: [{ type: "text" as const, text: `Regex query is too long; maximum length is ${MAX_REGEX_SEARCH_QUERY_LENGTH} characters.` }],
          details: { mode: "search", error: "query_too_long", query, maxLength: MAX_REGEX_SEARCH_QUERY_LENGTH },
        };
      }

      pattern = new RegExp(query, "i");
      let safety;
      try {
        safety = checkSync(query, "i", REGEX_SAFETY_CHECK_PARAMS);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: "Regex query rejected because safety analysis failed." }],
          details: { mode: "search", error: "unsafe_pattern", query, reason: message },
        };
      }
      if (safety.status !== "safe") {
        return {
          content: [{ type: "text" as const, text: `Regex query rejected as unsafe (${safety.status}).` }],
          details: { mode: "search", error: "unsafe_pattern", query, safetyStatus: safety.status },
        };
      }
    } else {
      const terms = query.trim().split(/\s+/).filter(t => t.length > 0);
      if (terms.length === 0) {
        return {
          content: [{ type: "text" as const, text: "Search query cannot be empty" }],
          details: { mode: "search", error: "empty_query" },
        };
      }
      const escaped = terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      pattern = new RegExp(escaped.join("|"), "i");
    }
  } catch {
    return {
      content: [{ type: "text" as const, text: `Invalid regex: ${query}` }],
      details: { mode: "search", error: "invalid_pattern", query },
    };
  }

  for (const [serverName, metadata] of state.toolMetadata.entries()) {
    if (server && serverName !== server) continue;
    for (const tool of metadata) {
      if (pattern.test(tool.name) || pattern.test(tool.description)) {
        matches.push({
          server: serverName,
          tool,
        });
      }
    }
  }

  const totalCount = matches.length;

  if (totalCount === 0) {
    const msg = server
      ? `No tools matching "${query}" in "${server}"`
      : `No tools matching "${query}"`;
    return {
      content: [{ type: "text" as const, text: msg }],
      details: { mode: "search", matches: [], count: 0, query },
    };
  }

  let text = `Found ${totalCount} tool${totalCount === 1 ? "" : "s"} matching "${query}":\n\n`;

  for (const match of matches) {
    if (showSchemas) {
      text += `${match.tool.name}\n`;
      text += `  ${match.tool.description || "(no description)"}\n`;
      if (match.tool.inputSchema && !match.tool.resourceUri) {
        text += `\n  Parameters:\n${formatSchema(match.tool.inputSchema, "    ")}\n`;
      } else if (match.tool.resourceUri) {
        text += `  No parameters (resource tool).\n`;
      }
      text += "\n";
    } else {
      text += `- ${match.tool.name}`;
      if (match.tool.description) {
        text += ` - ${truncateAtWord(match.tool.description, 50)}`;
      }
      text += "\n";
    }
  }

  return {
    content: [{ type: "text" as const, text: text.trim() }],
    details: {
      mode: "search",
      matches: matches.map(m => ({ server: m.server, tool: m.tool.name })),
      count: totalCount,
      query,
    },
  };
}

export function executeList(state: McpExtensionState, server: string): ProxyToolResult {
  if (!state.config.mcpServers[server]) {
    return {
      content: [{ type: "text" as const, text: `Server "${server}" not found. Use mcp({}) to see available servers.` }],
      details: { mode: "list", server, tools: [], count: 0, error: "not_found" },
    };
  }

  const metadata = state.toolMetadata.get(server);
  const toolNames = metadata?.map(m => m.name) ?? [];
  const connection = state.manager.getConnection(server);

  if (toolNames.length === 0) {
    if (connection?.status === "connected") {
      return {
        content: [{ type: "text" as const, text: `Server "${server}" has no tools.` }],
        details: { mode: "list", server, tools: [], count: 0 },
      };
    }
    if (metadata !== undefined) {
      return {
        content: [{ type: "text" as const, text: `Server "${server}" has no cached tools (not connected).` }],
        details: { mode: "list", server, tools: [], count: 0, cached: true },
      };
    }
    return {
      content: [{ type: "text" as const, text: `Server "${server}" is configured but not connected. Use mcp({ connect: "${server}" }) or /mcp reconnect ${server} to retry.` }],
      details: { mode: "list", server, tools: [], count: 0, error: "not_connected" },
    };
  }

  const cachedNote = connection?.status === "connected" ? "" : " (not connected, cached)";
  let text = `${server} (${toolNames.length} tools${cachedNote}):\n\n`;

  const descMap = new Map<string, string>();
  if (metadata) {
    for (const m of metadata) {
      descMap.set(m.name, m.description);
    }
  }

  for (const tool of toolNames) {
    const desc = descMap.get(tool) ?? "";
    const truncated = truncateAtWord(desc, 50);
    text += `- ${tool}`;
    if (truncated) text += ` - ${truncated}`;
    text += "\n";
  }

  return {
    content: [{ type: "text" as const, text: text.trim() }],
    details: { mode: "list", server, tools: toolNames, count: toolNames.length },
  };
}

export async function executeConnect(state: McpExtensionState, serverName: string): Promise<ProxyToolResult> {
  const definition = state.config.mcpServers[serverName];
  if (!definition) {
    return {
      content: [{ type: "text" as const, text: `Server "${serverName}" not found. Use mcp({}) to see available servers.` }],
      details: { mode: "connect", error: "not_found", server: serverName },
    };
  }

  try {
    if (state.ui) {
      state.ui.setStatus("mcp", state.ui.theme.fg("muted", "🔌:") + state.ui.theme.fg("accent", `connecting ${serverName}`));
    }
    const connection = await state.manager.connect(serverName, definition);
    if (connection.status === "needs-auth") {
      const message = getAuthRequiredMessage(state, serverName);
      return {
        content: [{ type: "text" as const, text: message }],
        details: { mode: "connect", error: "auth_required", server: serverName, message },
      };
    }
    const prefix = state.config.settings?.toolPrefix ?? "server";
    const { metadata } = buildToolMetadata(connection.tools, connection.resources, definition, serverName, prefix);
    state.toolMetadata.set(serverName, metadata);
    updateMetadataCache(state, serverName);
    state.failureTracker.delete(serverName);
    updateStatusBar(state);
    return executeList(state, serverName);
  } catch (error) {
    state.failureTracker.set(serverName, Date.now());
    updateStatusBar(state);
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text" as const, text: `Failed to connect to "${serverName}": ${message}` }],
      details: { mode: "connect", error: "connect_failed", server: serverName, message },
    };
  }
}

export async function executeCall(
  state: McpExtensionState,
  toolName: string,
  args?: Record<string, unknown>,
  serverOverride?: string,
  getPiTools?: () => ToolInfo[],
): Promise<ProxyToolResult> {
  let serverName: string | undefined = serverOverride;
  let toolMeta: ToolMetadata | undefined;
  const prefixMode = state.config.settings?.toolPrefix ?? "server";

  if (serverName && !state.config.mcpServers[serverName]) {
    return {
      content: [{ type: "text" as const, text: `Server "${serverName}" not found. Use mcp({}) to see available servers.` }],
      details: { mode: "call", error: "server_not_found", server: serverName },
    };
  }

  if (serverName) {
    toolMeta = findToolByName(state.toolMetadata.get(serverName), toolName);
  } else {
    for (const [server, metadata] of state.toolMetadata.entries()) {
      const found = findToolByName(metadata, toolName);
      if (found) {
        serverName = server;
        toolMeta = found;
        break;
      }
    }
  }

  if (serverName && !toolMeta) {
    const connected = await lazyConnect(state, serverName);
    if (connected) {
      toolMeta = findToolByName(state.toolMetadata.get(serverName), toolName);
    } else {
      const needsAuthConnection = state.manager.getConnection(serverName);
      if (needsAuthConnection?.status === "needs-auth") {
        const message = getAuthRequiredMessage(state, serverName);
        return {
          content: [{ type: "text" as const, text: message }],
          details: { mode: "call", error: "auth_required", server: serverName, message },
        };
      }

      if (!toolMeta) {
        const failedAgo = getFailureAgeSeconds(state, serverName);
        if (failedAgo !== null) {
          return {
            content: [{ type: "text" as const, text: `Server "${serverName}" not available (last failed ${failedAgo}s ago)` }],
            details: { mode: "call", error: "server_backoff", server: serverName },
          };
        }
      }
    }
  }

  let prefixMatchedServer: string | undefined;

  if (!serverName && !toolMeta && prefixMode !== "none") {
    const candidates = Object.keys(state.config.mcpServers)
      .map(name => ({ name, prefix: getServerPrefix(name, prefixMode) }))
      .filter(c => c.prefix && toolName.startsWith(c.prefix + "_"))
      .sort((a, b) => b.prefix.length - a.prefix.length);

    for (const { name: configuredServer } of candidates) {
      const existingConnection = state.manager.getConnection(configuredServer);
      const failedAgo = getFailureAgeSeconds(state, configuredServer);
      if (failedAgo !== null && existingConnection?.status !== "needs-auth") continue;

      const connected = await lazyConnect(state, configuredServer);
      if (!connected) {
        if (state.manager.getConnection(configuredServer)?.status === "needs-auth") {
          const message = getAuthRequiredMessage(state, configuredServer);
          return {
            content: [{ type: "text" as const, text: message }],
            details: { mode: "call", error: "auth_required", server: configuredServer, message },
          };
        }
        continue;
      }
      if (!prefixMatchedServer) prefixMatchedServer = configuredServer;
      toolMeta = findToolByName(state.toolMetadata.get(configuredServer), toolName);
      if (toolMeta) {
        serverName = configuredServer;
        break;
      }
    }
  }

  if (!serverName || !toolMeta) {
    const nativeTool = !serverOverride
      ? getPiTools?.().find((tool) => tool.name === toolName && tool.name !== "mcp")
      : undefined;
    if (nativeTool) {
      return {
        content: [{ type: "text" as const, text: `"${toolName}" is a native Pi tool. Call ${toolName} directly instead of using mcp({ tool: "${toolName}" }).` }],
        details: { mode: "call", error: "native_tool", requestedTool: toolName },
      };
    }

    const hintServer = serverName ?? prefixMatchedServer;
    const available = hintServer ? getToolNames(state, hintServer) : [];
    let msg = `Tool "${toolName}" not found.`;
    if (available.length > 0) {
      msg += ` Server "${hintServer}" has: ${available.join(", ")}`;
    } else {
      msg += ` Use mcp({ search: "..." }) to search.`;
    }
    return {
      content: [{ type: "text" as const, text: msg }],
      details: { mode: "call", error: "tool_not_found", requestedTool: toolName, hintServer },
    };
  }

  let connection = state.manager.getConnection(serverName);
  if (connection?.status === "needs-auth") {
    const message = getAuthRequiredMessage(state, serverName);
    return {
      content: [{ type: "text" as const, text: message }],
      details: { mode: "call", error: "auth_required", server: serverName, message },
    };
  }
  if (!connection || connection.status !== "connected") {
    const failedAgo = getFailureAgeSeconds(state, serverName);
    if (failedAgo !== null) {
      return {
        content: [{ type: "text" as const, text: `Server "${serverName}" not available (last failed ${failedAgo}s ago)` }],
        details: { mode: "call", error: "server_backoff", server: serverName },
      };
    }

    const definition = state.config.mcpServers[serverName];
    if (!definition) {
      return {
        content: [{ type: "text" as const, text: `Server "${serverName}" not connected` }],
        details: { mode: "call", error: "server_not_connected", server: serverName },
      };
    }

    try {
      if (state.ui) {
        state.ui.setStatus("mcp", state.ui.theme.fg("muted", "🔌:") + state.ui.theme.fg("accent", `connecting ${serverName}`));
      }
      connection = await state.manager.connect(serverName, definition);
      if (connection.status === "needs-auth") {
        const message = getAuthRequiredMessage(state, serverName);
        return {
          content: [{ type: "text" as const, text: message }],
          details: { mode: "call", error: "auth_required", server: serverName, message },
        };
      }
      state.failureTracker.delete(serverName);
      updateServerMetadata(state, serverName);
      updateMetadataCache(state, serverName);
      updateStatusBar(state);
      toolMeta = findToolByName(state.toolMetadata.get(serverName), toolName);
      if (!toolMeta) {
        const available = getToolNames(state, serverName);
        const hint = available.length > 0
          ? `Available tools on "${serverName}": ${available.join(", ")}`
          : `Server "${serverName}" has no tools.`;
        return {
          content: [{ type: "text" as const, text: `Tool "${toolName}" not found on "${serverName}" after reconnect. ${hint}` }],
          details: { mode: "call", error: "tool_not_found_after_reconnect", requestedTool: toolName },
        };
      }
    } catch (error) {
      state.failureTracker.set(serverName, Date.now());
      updateStatusBar(state);
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: `Failed to connect to "${serverName}": ${message}` }],
        details: { mode: "call", error: "connect_failed", message },
      };
    }
  }

  try {
    state.manager.touch(serverName);
    state.manager.incrementInFlight(serverName);

    if (toolMeta.resourceUri) {
      const result = await connection.client.readResource({ uri: toolMeta.resourceUri });
      const content = (result.contents ?? []).map(c => ({
        type: "text" as const,
        text: "text" in c ? c.text : ("blob" in c ? `[Binary data: ${(c as { mimeType?: string }).mimeType ?? "unknown"}]` : JSON.stringify(c)),
      }));
      return {
        content: content.length > 0 ? content : [{ type: "text" as const, text: "(empty resource)" }],
        details: { mode: "call", resourceUri: toolMeta.resourceUri, server: serverName },
      };
    }

    const result = await connection.client.callTool({
      name: toolMeta.originalName,
      arguments: args ?? {},
    }, undefined, { timeout: (state.config.mcpServers[serverName]?.timeout ?? 60) * 1000 });

    const mcpContent = (result.content ?? []) as McpContent[];
    const content = transformMcpContent(mcpContent);

    if (result.isError) {
      const errorText = content
        .filter((c) => c.type === "text")
        .map((c) => (c as { text: string }).text)
        .join("\n") || "Tool execution failed";

      let errorWithSchema = `Error: ${errorText}`;
      if (toolMeta.inputSchema) {
        errorWithSchema += `\n\nExpected parameters:\n${formatSchema(toolMeta.inputSchema)}`;
      }

      return {
        content: [{ type: "text" as const, text: errorWithSchema }],
        details: { mode: "call", error: "tool_error", mcpResult: result },
      };
    }

    return {
      content: content.length > 0 ? content : [{ type: "text" as const, text: "(empty result)" }],
      details: { mode: "call", mcpResult: result, server: serverName, tool: toolMeta.originalName },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    let errorWithSchema = `Failed to call tool: ${message}`;
    if (toolMeta.inputSchema) {
      errorWithSchema += `\n\nExpected parameters:\n${formatSchema(toolMeta.inputSchema)}`;
    }

    return {
      content: [{ type: "text" as const, text: errorWithSchema }],
      details: { mode: "call", error: "call_failed", message },
    };
  } finally {
    state.manager.decrementInFlight(serverName);
    state.manager.touch(serverName);
  }
}
