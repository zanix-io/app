import type { NormalizedAppDefinition } from 'typings/manifest.ts'
import {
  Controller,
  type HandlerContext,
  type HandlerResponse,
  Post,
  ZanixController,
  type ZanixGenericDecorator,
} from '@zanix/server'
import { HttpError, InternalError } from '@zanix/errors'
import { getLocalOperation, isCallerAllowed } from './operation-registry.ts'
import { OPERATIONS_PATH_SEGMENT, SERVICE_TOKEN_PATH_SEGMENT } from './http-remote-adapter.ts'
import { ServiceTokenExchangeRTO } from './rtos/service-token.rto.ts'
import { AUTH_SPECIFIER } from '../lazy/specifiers.ts'

/**
 * Narrow, hand-declared shape for exactly the two `@zanix/auth` exports this module calls —
 * deliberately NOT `typeof import('@zanix/auth')`. See `http-remote-adapter.ts`'s own doc for the
 * confirmed-real `zanix space build` regression a whole-module type alias causes.
 *
 * This file keeps the raw `await import(specifier) as AuthExports` shape (below, inside
 * {@linkcode registerRemoteDispatchRoutes}) rather than `@zanix/helpers`'s `lazyFunction` — a
 * genuine case the generic helper doesn't fit, not left this way merely for consistency with
 * `register-jobs.ts`'s own `AsyncmqExports`: `AuthTokenValidation` is applied as a real class
 * DECORATOR (`@AuthTokenValidation({...})`), which needs the actual decorator function
 * SYNCHRONOUSLY, at class-declaration time — `lazyFunction`'s wrapper always returns a `Promise`
 * (it has to `await import()` internally on every call), which a decorator position can never
 * accept. Resolving the whole module once via a real `await import()`, before the class is
 * declared, then using both exports synchronously, is the only way this specific shape works.
 */
interface AuthExports {
  AuthTokenValidation: (
    options?: { type?: 'user' | 'api' | ('user' | 'api')[] },
  ) => ZanixGenericDecorator
  exchangeServiceCredential: (assertion: string) => Promise<unknown>
}

/**
 * Registers the two routes an app needs to be callable over HTTP by `HttpRemoteAdapter` — a
 * no-op if `def.operations` is empty (an app with no operations is never remotely callable, and
 * pays zero cost for this: no controller/route registered at all).
 *
 * `@Controller`'s `prefix` bakes `def.name` DIRECTLY into the path (`__zanix-ops/${def.name}`),
 * deliberately independent of `registerApplicationMount`/the app's own `routesPrefix` — same
 * pattern `@zanix/admin`'s own `createTriggersController` already uses for a decorator-time prefix
 * that depends on a runtime value. Two reasons this matters: (1) `operations` must never collide
 * between apps even when `routes: false` (no mount prefix registered at all — two unmounted apps'
 * ops routes would otherwise land on the exact same bare path); (2) it keeps the dispatch path
 * fully self-describing from the caller's side, independent of whatever mounting choice the target
 * app's own public routes made. Registering the class (evaluating the decorator) is itself what
 * adds the route — nothing further needs to be done with the returned class.
 *
 * - `POST /__zanix-ops/${def.name}/service-token` — `@zanix/auth`'s own
 *   `exchangeServiceCredential`, wired in AS-IS: verifies a caller's
 *   self-signed assertion and mints a real access token. No app-specific logic here at all — the
 *   trust boundary (which callers are allowed to obtain a token) is entirely the operator's own
 *   `JWK_PUB_<serviceId>`/`SERVICE_PERMISSIONS_<serviceId>` env var configuration, same as any
 *   other consumer of this function.
 * - `POST /__zanix-ops/${def.name}/:operationName` — protected by `@AuthTokenValidation({type:
 *   'api'})`, the exact decorator that already protects any other Zanix endpoint today (validates
 *   the token itself: signature, issuer, expiry, blocklist — NOT per-operation scoping, that's a
 *   separate concern below). Once past that, the resolved operation's own `allowedCallers` (see
 *   {@link OperationDeclaration}) is checked against the token's `sub` claim (the calling app's
 *   identity, promoted to `ctx.session`/`ctx.locals.session` by the guard) — `undefined`
 *   (no ACL declared) means public, matching this endpoint's original all-callers-allowed
 *   behavior. Dispatches to the exact same `RuntimeContext`-bound handler `ctx.remote()` uses for
 *   an in-process call — an operation's own code never distinguishes the two paths.
 *
 * `@zanix/auth` itself is reached through a DELIBERATELY non-literal `import()` specifier
 * (assigned to a local variable first, never `import('@zanix/auth')` inline) — Deno's module
 * graph builder (and, transitively, the Vite/Rolldown dependency scan that walks it during
 * `zanix space build`) only follows a dynamic import whose argument is a string literal it can
 * analyze statically; routing it through a variable keeps `@zanix/auth` out of that graph
 * entirely for any app that declares no `operations` at all — checked BEFORE the import, not
 * after, same as this function's own early return always worked.
 *
 * @param def The already-normalized app being registered — expected to already be inside the
 * `ProgramModule.defineApplication(def.name, ...)` scope `registerApp` opened.
 */
export async function registerRemoteDispatchRoutes(
  def: NormalizedAppDefinition,
): Promise<void> {
  if (!Object.keys(def.operations).length) return

  const appName = def.name
  const specifier = AUTH_SPECIFIER
  const { AuthTokenValidation, exchangeServiceCredential } = await import(specifier) as AuthExports

  @Controller({ prefix: `${OPERATIONS_PATH_SEGMENT}/${appName}` })
  class _RemoteDispatchController extends ZanixController {
    @Post(SERVICE_TOKEN_PATH_SEGMENT, { Body: ServiceTokenExchangeRTO })
    public async exchange(
      ctx: HandlerContext<{ body: ServiceTokenExchangeRTO }>,
    ): Promise<HandlerResponse> {
      const credential = await exchangeServiceCredential(
        ctx.payload.body.assertion,
      )
      return credential as unknown as HandlerResponse
    }

    @Post(':operationName')
    @AuthTokenValidation({ type: 'api' })
    public async dispatch(ctx: HandlerContext): Promise<HandlerResponse> {
      // `@zanix/server`'s router used to lowercase a route param's NAME (not just matching), so a
      // `:operationName` pattern only ever produced the key `operationname` — fixed at the source
      // (`RouteContainer`/`routeProcessor` now preserve param-name casing); this reads the
      // corrected, camelCase key.
      const operationName = ctx.payload.params.operationName as string
      const local = getLocalOperation(appName, operationName)
      if (!local) {
        throw new InternalError(
          `Zanix App "${appName}" has no operation named "${operationName}".`,
          {
            code: 'UNKNOWN_OPERATION',
            meta: { source: 'zanix', appName, operationName },
          },
        )
      }

      const callerAppName = (ctx.locals.session ?? ctx.session)?.subject as
        | string
        | undefined
      if (!isCallerAllowed(local.allowedCallers, callerAppName ?? '')) {
        throw new HttpError('FORBIDDEN', {
          message: `Zanix App "${callerAppName}" is not allowed to invoke "${appName}"'s ` +
            `operation "${operationName}".`,
          meta: {
            source: 'zanix',
            appName,
            operationName,
            callerAppName,
            requestId: ctx.id,
          },
        })
      }

      const result = await local.handler(ctx.payload.body, local.ctx)
      return result as HandlerResponse
    }
  }

  void _RemoteDispatchController
}
