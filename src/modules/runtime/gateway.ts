import type { PreHandler } from '@zanix/server'
import type { RemoteDeploymentTarget } from 'typings/deployment.ts'
import type { ControlPlaneRegistry } from './control-plane/mod.ts'
import { RoundRobinPicker } from './round-robin.ts'

/** Options for {@linkcode createGatewayPreHandler}. */
export interface GatewayOptions {
  /** App names THIS process already runs locally — never proxied for, no matter what the Control
   * Plane says for that same name. Pass the same names this process itself activated (e.g.
   * `defs.map(d => d.name)`, the same `defs` given to `activateApps`) — omit for a process that
   * runs no local apps of its own, a dedicated Gateway with nothing to protect. */
  localAppNames?: Iterable<string>
  /**
   * The app to proxy to when NEITHER a local route NOR a first-path-segment name match — the
   * "whole-domain" case (`routes: {prefix: ''}`, e.g. a `@zanix/space` SSR app): a page path like
   * `/products/1` carries no segment identifying which app owns it, so first-segment resolution
   * can never find it. Only ONE default makes sense behind a given Gateway — two whole-domain
   * apps sharing an origin would collide over the same URL space regardless of what resolves
   * them, so this isn't a limitation specific to this mechanism. Never consulted for a name also
   * present in `localAppNames` (this process would already serve it directly, faster, with no
   * network hop).
   */
  defaultRemoteApp?: string
}

async function proxyTo(
  appName: string,
  target: RemoteDeploymentTarget,
  roundRobin: RoundRobinPicker,
  request: Request,
  url: URL,
): Promise<Response> {
  const endpoint = roundRobin.pick(appName, target.endpoints)

  try {
    return await fetch(`${endpoint}${url.pathname}${url.search}`, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      ...(request.body ? { duplex: 'half' } : {}),
    } as RequestInit)
  } catch (error) {
    return new Response(
      JSON.stringify({
        message: `Bad Gateway: a registered remote target is unreachable.`,
        cause: (error as Error).message,
      }),
      { status: 502, headers: { 'content-type': 'application/json' } },
    )
  }
}

/**
 * Builds the Gateway as a `@zanix/server` `PreHandler` — the
 * piece that routes PUBLIC/external traffic to a `remote` app, closing the gap `ctx.remote()`
 * deliberately left open (that's APP-TO-APP calling; nothing before this routed a real inbound
 * HTTP request to a remote app's own endpoints).
 *
 * `PreHandler` (`@zanix/server`) is the exact extension point this needed — the SAME mechanism
 * `@zanix/space`'s own dev server already uses to intercept a request before route matching, on
 * the same origin, without replacing the dispatcher entirely. Returning `undefined` falls through
 * to this process's own normal routing UNCHANGED — so `undefined` here on every request that isn't
 * a remote app's own traffic (the overwhelming majority) costs nothing beyond one or two
 * `Set.has()` checks and, when those miss, whatever `registry.getDeploymentTarget` itself costs.
 *
 * **Two resolution strategies, tried in order, never a full reverse-prefix index**:
 *
 * 1. **By name** — the request path's own first segment, looked up DIRECTLY in the Control Plane
 *    Registry (`registry.getDeploymentTarget(candidateAppName)`). Works because Zanix's own
 *    dominant convention is `routesPrefix ?? name` (an app's mount prefix defaults to its own bare
 *    `name` — confirmed throughout this package: `remote-lifecycle.ts`'s own `entry.prefix`,
 *    `ctx.remote()`'s dispatch path). An app whose OWN served routes sit behind an ADDITIONAL
 *    prefix in front of its name (e.g. a REST server's default `/api` global prefix) or an
 *    explicit custom `routes: {prefix: 'custom'}` isn't discoverable this way — configure that
 *    target's own server with no extra global prefix ahead of its name, or reach for
 *    `defaultRemoteApp` instead if it's the only remote app behind this Gateway.
 * 2. **By default** — {@linkcode GatewayOptions.defaultRemoteApp}, tried only once strategy 1
 *    found nothing. This is what a whole-domain app (`routes: {prefix: ''}`) needs, since its own
 *    paths carry no app-identifying segment at all.
 *
 * **Never shadows a LOCALLY-mounted app**: {@linkcode GatewayOptions.localAppNames} is checked
 * before EITHER strategy above — a name in that set always falls through to this process's own
 * routing, regardless of what the shared Control Plane says for that same name.
 *
 * **A genuine reverse proxy, not a redirect**: forwards method/headers/body as-is (streamed, never
 * buffered) to one of the resolved target's live `endpoints` — round-robin per resolved app name
 * (`RoundRobinPicker`, the same mechanism `HttpRemoteAdapter.dispatch` already uses) — and returns
 * whatever `Response` comes back, unmodified. A failed proxy attempt (target unreachable) responds
 * `502` directly — this function never throws, since a `PreHandler` rejecting isn't a contract
 * `@zanix/server` documents as safely handled.
 *
 * @param registry Where a resolved app name's live endpoints are looked up.
 * @param options See {@linkcode GatewayOptions}.
 */
export function createGatewayPreHandler(
  registry: ControlPlaneRegistry,
  options: GatewayOptions = {},
): PreHandler {
  const local = new Set(options.localAppNames ?? [])
  const defaultRemoteApp = options.defaultRemoteApp
  const roundRobin = new RoundRobinPicker()

  return async (request) => {
    const url = new URL(request.url)
    const [candidateAppName] = url.pathname.split('/').filter(Boolean)

    if (candidateAppName && !local.has(candidateAppName)) {
      const target = await registry.getDeploymentTarget(candidateAppName)
      if (target) {
        return await proxyTo(
          candidateAppName,
          target,
          roundRobin,
          request,
          url,
        )
      }
    }

    if (defaultRemoteApp && !local.has(defaultRemoteApp)) {
      const target = await registry.getDeploymentTarget(defaultRemoteApp)
      if (target) {
        return await proxyTo(
          defaultRemoteApp,
          target,
          roundRobin,
          request,
          url,
        )
      }
    }

    return undefined
  }
}
