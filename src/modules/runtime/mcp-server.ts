import { getLocalOperation, isCallerAllowed, listMcpTools } from './operation-registry.ts'

/** The MCP protocol revision this server speaks — verified against the official spec
 * (modelcontextprotocol.io/specification/2025-06-18), not guessed. Per that spec's own version-
 * negotiation rule ("if the server supports the requested protocol version, respond with the
 * same version; otherwise respond with another it supports, SHOULD be its latest"): since this
 * server supports exactly one revision, it always advertises this one in `initialize`'s response,
 * regardless of what the client requested — spec-compliant either way. */
const MCP_PROTOCOL_VERSION = '2025-06-18'

/** Standard JSON-RPC 2.0 error codes this server actually uses. */
const METHOD_NOT_FOUND = -32601
const INVALID_PARAMS = -32602

/** One incoming JSON-RPC 2.0 message — a request (has `id`) or a notification (no `id`), per the
 * MCP spec's own lifecycle (`notifications/initialized` is sent as a notification). */
export interface JsonRpcRequest {
  /** Always the literal `'2.0'` — JSON-RPC 2.0 is the only version MCP uses. */
  jsonrpc: '2.0'
  /** Omitted for a notification (e.g. `notifications/initialized`) — present for a real request
   * this server must respond to. */
  id?: string | number | null
  /** e.g. `'initialize'`, `'tools/list'`, `'tools/call'`. */
  method: string
  /** Method-specific arguments — shape depends on `method` (see `handleMcpRequest`'s own doc). */
  params?: Record<string, unknown>
}

/** One outgoing JSON-RPC 2.0 message — always has EITHER `result` XOR `error`, never both. */
export interface JsonRpcResponse {
  /** Always the literal `'2.0'`. */
  jsonrpc: '2.0'
  /** Echoes the request's own `id`. */
  id: string | number | null
  /** Present on success — shape depends on which method this responds to. */
  result?: unknown
  /** Present on a PROTOCOL failure (unknown method, invalid params) — never for a tool-execution
   * failure, which is reported inside a successful `result` instead (see
   * {@linkcode handleMcpRequest}'s own doc on the distinction). */
  error?: { code: number; message: string; data?: unknown }
}

function result(id: string | number | null, value: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result: value }
}

function protocolError(
  id: string | number | null,
  code: number,
  message: string,
): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

/** A tool-execution failure (the tool exists, but denied access or threw) — reported INSIDE a
 * successful JSON-RPC result via `isError: true`, per the MCP spec's own distinction between
 * "Protocol Errors" (unknown tool, invalid arguments — a JSON-RPC `error`) and "Tool Execution
 * Errors" (access denied, the handler itself failing — `result.isError: true`). Never confuse the
 * two: an unknown tool name is a protocol error (this server can't even attempt the call); a
 * denied/failed call DID reach a real tool, so the RPC itself succeeded. */
function toolExecutionError(
  id: string | number | null,
  message: string,
): JsonRpcResponse {
  return result(id, {
    content: [{ type: 'text', text: message }],
    isError: true,
  })
}

/**
 * Handles ONE incoming MCP JSON-RPC message against every currently-registered
 * {@link McpToolDeclaration}-opted-in operation, across every active Zanix App in this process —
 * the single, process-wide way an AI agent discovers
 * and invokes tools, aggregated rather than one MCP endpoint per app.
 *
 * Implements the core operational flow (`initialize` → `notifications/initialized` →
 * `tools/list`/`tools/call`) verified against the official spec
 * (modelcontextprotocol.io/specification/2025-06-18) — deliberately NOT a full-spec
 * implementation: no `resources`/`prompts`/`logging` capabilities, no pagination (`tools/list`
 * always returns every tool in one page), no `listChanged` notifications when a hot install/
 * uninstall changes what's available (an agent must re-call `tools/list` itself to notice). Every
 * simplification here is a real, documented scope boundary — not a hidden gap.
 *
 * @param request One parsed JSON-RPC message (already deserialized from the transport — this
 * function has no transport/HTTP concerns of its own; see `registerMcpServer` for the HTTP side).
 * @param callerAppName The identity to check `allowedCallers` against for a `tools/call` — the
 * SAME mechanism app-to-app calls already use (v7.1): an MCP client authenticates via the exact
 * same service-token exchange a remote Zanix App would, so its own `serviceId` (e.g.
 * `agent:claude-desktop`) IS `callerAppName` here, checked identically to any other caller's.
 * @returns The JSON-RPC response to send back, or `null` for a notification (`id` omitted) — per
 * the Streamable HTTP transport spec, a notification gets HTTP 202 with no body, never a JSON-RPC
 * response.
 */
export async function handleMcpRequest(
  request: JsonRpcRequest,
  callerAppName: string,
): Promise<JsonRpcResponse | null> {
  const id = request.id ?? null

  switch (request.method) {
    case 'initialize':
      return result(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'zanix-apps-mcp', version: '1.0.0' },
      })

    // A notification — the client sends this after `initialize` to signal it's ready for normal
    // operation. No `id`, no response expected (see this function's own `@returns` doc).
    case 'notifications/initialized':
      return null

    case 'tools/list':
      return result(id, {
        tools: listMcpTools().map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      })

    case 'tools/call': {
      const name = request.params?.name
      if (typeof name !== 'string') {
        return protocolError(
          id,
          INVALID_PARAMS,
          '"tools/call" requires a string "name".',
        )
      }

      const separatorIndex = name.indexOf('.')
      const appName = separatorIndex === -1 ? '' : name.slice(0, separatorIndex)
      const operationName = separatorIndex === -1 ? '' : name.slice(separatorIndex + 1)
      const local = appName ? getLocalOperation(appName, operationName) : undefined

      if (!local || !local.mcp) {
        return protocolError(id, INVALID_PARAMS, `Unknown tool "${name}".`)
      }

      if (!isCallerAllowed(local.allowedCallers, callerAppName)) {
        return toolExecutionError(
          id,
          `Access denied: "${callerAppName}" is not allowed to invoke "${name}".`,
        )
      }

      try {
        const output = await local.handler(
          request.params?.arguments,
          local.ctx,
        )
        return result(id, {
          content: [{ type: 'text', text: JSON.stringify(output) }],
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return toolExecutionError(id, `Tool "${name}" failed: ${message}`)
      }
    }

    default:
      return protocolError(
        id,
        METHOD_NOT_FOUND,
        `Unknown method "${request.method}".`,
      )
  }
}
