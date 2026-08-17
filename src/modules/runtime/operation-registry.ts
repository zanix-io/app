import type {
  McpToolDeclaration,
  NormalizedAppDefinition,
  OperationHandler,
  RuntimeContext,
} from 'typings/manifest.ts'
import { createRemoteCaller, type RemoteCallerFactory } from './remote-caller.ts'
import { buildRuntimeContext } from './build-runtime-context.ts'
import { buildSandboxedHandler } from './sandbox-operation.ts'

/** What {@linkcode getLocalOperation} resolves to — a registered operation's handler, paired with
 * the `RuntimeContext` it was registered with (the owning app's own resources/config). */
export interface RegisteredOperation {
  /** The handler exactly as declared in the app's manifest `operations`. */
  handler: OperationHandler
  /** The owning app's own `{resource, config, remote}` — never the caller's. */
  ctx: RuntimeContext
  /** `null` = no ACL declared (public — every caller allowed); otherwise the list of Zanix App
   * names allowed to invoke this operation (see {@link isCallerAllowed}). */
  allowedCallers: string[] | null
  /** `null` = not exposed as an MCP tool; otherwise what {@linkcode listMcpTools} surfaces for it
   * (see {@link McpToolDeclaration}). */
  mcp: McpToolDeclaration | null
}

/** One entry {@linkcode listMcpTools} surfaces — an MCP-exposed operation, ready to translate
 * into that protocol's own `Tool` shape (`{name, description, inputSchema}`). */
export interface McpToolEntry {
  /** The owning app's own name. */
  appName: string
  /** The operation's own name, within `appName`. */
  operationName: string
  /** `${appName}.${operationName}` — the flat, globally-unique name an MCP client sees and sends
   * back in `tools/call`. A single dot, never a colon (`operationRegistry`'s own internal key
   * separator), since MCP tool names are conventionally dot/underscore-separated identifiers, not
   * an implementation detail an agent should need to know about. */
  name: string
  /** Verbatim from {@link McpToolDeclaration.description}. */
  description: string
  /** Verbatim from {@link McpToolDeclaration.inputSchema}, or `{ type: 'object' }` if the
   * declaration omitted one. */
  inputSchema: Record<string, unknown>
}

/**
 * Whether `callerAppName` may invoke an operation whose manifest declared `allowedCallers` —
 * `null` (no ACL declared at all) or an explicit `'*'` member both mean public; otherwise
 * `callerAppName` itself must be listed. The one place this check happens, reused identically by
 * both dispatch paths (`createRemoteCaller`'s local branch and `remote-dispatch-route.ts`'s HTTP
 * one) — see {@link OperationDeclaration}'s own doc for why this is opt-in, not secure-by-default.
 */
export function isCallerAllowed(
  allowedCallers: string[] | null,
  callerAppName: string,
): boolean {
  if (allowedCallers === null) return true
  return allowedCallers.includes('*') || allowedCallers.includes(callerAppName)
}

/**
 * Module-level, process-wide `${appName}:${operationName} -> {handler, ctx}` map — the only thing
 * that makes an EMBEDDED `ctx.remote(name).call(...)` truly zero-network/zero-serialization:
 * a call that finds its target here never touches HTTP, the
 * Control Plane, or any adapter. Same pattern `register-jobs.ts`'s own `namespacedJobOrigins`
 * already uses for process-wide, populate-once-read-many state.
 */
const operationRegistry = new Map<string, RegisteredOperation>()

/**
 * Registers every operation in `def.operations`, so this app becomes reachable via
 * `ctx.remote(def.name).call(operationName, ...)` from ANY app active in this same process
 * (regardless of `def`'s own `runtime.mode`, once that field exists) — a no-op if `def.operations`
 * is empty.
 *
 * @param def The app whose operations are being registered — expected to already be inside the
 * `ProgramModule.defineApplication(def.name, ...)` scope that owns this app's composition.
 * @param resources The shared `Map<`${appName}:${slot}`, instance>` from `resolveResources()` —
 * each operation's own `ctx` reads from this, same as `onStart`/`onStop`.
 * @param remoteCaller See `buildRuntimeContext`'s own doc — an operation can itself call
 * `ctx.remote(otherApp)`, same as `onStart`/`onStop` can.
 *
 * A `sandbox`-declared operation registers a WRAPPED handler
 * built by `buildSandboxedHandler` instead of its (nonexistent) inline one — every other caller of
 * `getLocalOperation` sees the exact same `RegisteredOperation` shape either way, unaware the real
 * work happens inside a dedicated, permission-restricted Worker.
 */
export function registerOperations(
  def: NormalizedAppDefinition,
  resources: Map<string, unknown>,
  remoteCaller: RemoteCallerFactory = createRemoteCaller(),
): void {
  if (!Object.keys(def.operations).length) return

  const ctx = buildRuntimeContext(def, resources, remoteCaller)
  for (
    const [operationName, { handler, sandbox, allowedCallers, mcp }] of Object
      .entries(
        def.operations,
      )
  ) {
    const resolvedHandler = sandbox
      ? buildSandboxedHandler(def.name, operationName, sandbox)
      // `handler` is only `null` when `sandbox` is set (normalize()'s own invariant) — never both.
      : handler as OperationHandler
    operationRegistry.set(
      `${def.name}:${operationName}`,
      { handler: resolvedHandler, ctx, allowedCallers, mcp },
    )
  }
}

/** Resolves `appName`'s `operationName` to its registered handler/ctx, or `undefined` if no app
 * currently active in THIS process ever registered it (either `appName` isn't running here at
 * all, or it is but never declared that operation). */
export function getLocalOperation(
  appName: string,
  operationName: string,
): RegisteredOperation | undefined {
  return operationRegistry.get(`${appName}:${operationName}`)
}

/**
 * Every currently-registered operation that opted into MCP exposure (`mcp` declared, not `null`)
 * — what an aggregated MCP server's own `tools/list` response is built from. Recomputed fresh on
 * every call — cheap (a single pass over an in-memory
 * map) and always reflects whichever apps are ACTUALLY active in this process right now, hot
 * install/uninstall included, never a snapshot that could go stale.
 */
export function listMcpTools(): McpToolEntry[] {
  const tools: McpToolEntry[] = []

  for (const [qualifiedKey, operation] of operationRegistry) {
    if (!operation.mcp) continue

    const separatorIndex = qualifiedKey.indexOf(':')
    const appName = qualifiedKey.slice(0, separatorIndex)
    const operationName = qualifiedKey.slice(separatorIndex + 1)

    tools.push({
      appName,
      operationName,
      name: `${appName}.${operationName}`,
      description: operation.mcp.description,
      inputSchema: operation.mcp.inputSchema ?? { type: 'object' },
    })
  }

  return tools
}
