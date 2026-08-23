import {
  Controller,
  type HandlerContext,
  type HandlerResponse,
  Post,
  ProgramModule,
  ZanixController,
} from '@zanix/server'
import { AuthTokenValidation, exchangeServiceCredential } from '@zanix/auth'
import { handleMcpRequest, type JsonRpcRequest } from './mcp-server.ts'
import { ServiceTokenExchangeRTO } from './rtos/service-token.rto.ts'

/** The fixed Application identity + path segment for the aggregated MCP endpoint — a dedicated
 * Application (like `@zanix/admin`'s own), never namespaced under any one app's own mount prefix,
 * since it aggregates tools across EVERY active app, not just one. */
const MCP_APPLICATION = '__zanix-mcp'

/** Set once {@link registerMcpServer} has actually registered its routes — guards against a
 * second call throwing a route-collision error (`RouteContainer.defineRoute` is append-only;
 * registering the exact same path/Application twice is a real conflict, not a harmless no-op). */
let registered = false

/**
 * Opts this process into serving ONE aggregated MCP (Model Context Protocol) endpoint: every
 * currently-active app's `mcp`-declared operations
 * (`operation-registry.ts`'s {@linkcode listMcpTools}), exposed to a SINGLE connecting AI agent,
 * rather than one MCP server per app.
 *
 * Explicit opt-in, like `@zanix/app/core`'s own side-effect-import pattern — a process that never
 * calls this pays zero cost (no route registered, `operation-registry.ts`'s `mcp` bookkeeping
 * itself is already free either way). Idempotent: a second call is a no-op, so a host is never
 * forced to track "did I already call this" itself (e.g. across a hot install that re-runs its
 * own composition sequence).
 *
 * - `POST /__zanix-mcp/service-token` — `@zanix/auth`'s own `exchangeServiceCredential`, wired in
 *   as-is, the exact same mechanism a remote Zanix App already uses (v5, "Remote App Protocol") —
 *   an MCP client (an agent) authenticates as its OWN `serviceId` (e.g. `agent:claude-desktop`),
 *   configured via the operator's own `JWK_PUB_<serviceId>`/`SERVICE_PERMISSIONS_<serviceId>` env
 *   vars, same trust boundary as any other service-to-service caller.
 * - `POST /__zanix-mcp` — protected by `@AuthTokenValidation({type: 'api'})` (validates the token
 *   itself), then delegates the JSON-RPC body to `handleMcpRequest`, passing the token's `sub`
 *   claim as `callerAppName` — `allowedCallers` (v7.1) is checked against THAT identity for every
 *   `tools/call`, reusing the exact same app-to-app permission mechanism, unmodified.
 *
 * Deliberately a SINGLE, non-streaming JSON response per request (`Content-Type: application/json`
 * — spec-legal per the Streamable HTTP transport, which lets a server choose either that or an SSE
 * stream) — no `Mcp-Session-Id` session management, no SSE, no `resources`/`prompts`/`logging`
 * capabilities, no `MCP-Protocol-Version` header enforcement. Real, documented scope boundaries
 * (see the package README's own "Agent/MCP composability" section) for a first, useful-but-partial
 * implementation — not a full-spec MCP server.
 */
export async function registerMcpServer(): Promise<void> {
  if (registered) return
  registered = true

  await ProgramModule.defineApplication(MCP_APPLICATION, () => {
    @Controller({ prefix: '__zanix-mcp' })
    class _McpController extends ZanixController {
      @Post('service-token', { Body: ServiceTokenExchangeRTO })
      public async exchange(
        ctx: HandlerContext<{ body: ServiceTokenExchangeRTO }>,
      ): Promise<HandlerResponse> {
        const credential = await exchangeServiceCredential(
          ctx.payload.body.assertion,
        )
        return credential as unknown as HandlerResponse
      }

      @Post('')
      @AuthTokenValidation({ type: 'api' })
      public async handle(ctx: HandlerContext): Promise<HandlerResponse> {
        const callerAppName = (ctx.locals.session ?? ctx.session)?.subject as
          | string
          | undefined
        const response = await handleMcpRequest(
          ctx.payload.body as JsonRpcRequest,
          callerAppName ?? '',
        )
        // A notification (e.g. `notifications/initialized`) gets no JSON-RPC response — the
        // Streamable HTTP transport spec calls for HTTP 202 with no body in that case. There's no
        // `HandlerResponse` shape for "202, empty" in this framework's own handler contract, so an
        // empty object is returned instead — still a 200, but with no JSON-RPC payload, which is
        // the part an MCP client actually cares about (it never expects a response body for a
        // notification it sent).
        return (response ?? {}) as HandlerResponse
      }
    }

    void _McpController
  })
}
