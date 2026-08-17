import type { RemoteCallOptions } from 'typings/remote.ts'
import { createServiceAuthClient, type ServiceAuthHeaders } from '@zanix/auth'
import { InternalError } from '@zanix/errors'
import type { ControlPlaneRegistry } from './control-plane/mod.ts'
import { resolveControlPlaneProvider } from './control-plane/mod.ts'
import type { HttpRemoteDispatcher } from './remote-caller.ts'
import { generateTraceparent } from './trace-context.ts'
import { RoundRobinPicker } from './round-robin.ts'

/** Every operation this adapter exposes on a remote target lives under this path segment, followed
 * by the target app's own `name` — e.g. `/__zanix-ops/reviews/createReview` — independent of that
 * app's own `routes`/mount prefix (see `registerRemoteDispatchRoutes`'s own doc for why). */
export const OPERATIONS_PATH_SEGMENT = '__zanix-ops'

/** `${OPERATIONS_PATH_SEGMENT}/service-token`'s own sibling path — where `HttpRemoteAdapter`
 * exchanges its caller's self-signed assertion for a real access token
 * (`createServiceAuthClient`/`exchangeServiceCredential`, already in production for
 * `ZanixAdminHub`, reused as-is here). */
export const SERVICE_TOKEN_PATH_SEGMENT = 'service-token'

/** What `createServiceAuthClient` returns — kept as a named alias so `#authClients`'s `Map` type
 * doesn't have to spell out the full function signature inline. */
type ServiceAuthClient = (
  targetServiceId: string,
  exchangeUrl: string,
) => Promise<ServiceAuthHeaders>

/**
 * Client certificate this adapter presents on every outgoing call — Deno's native TLS support
 * used here to prevent a rogue process from announcing itself as, say, `'billing'` and stealing
 * real traffic meant for that app.
 *
 * **Verified against current stable Deno, not assumed**: presenting a client certificate here is
 * real and works (`Deno.createHttpClient({cert, key})`, confirmed end-to-end against an
 * independent mTLS-enforcing server). `Deno.serve()`/`Deno.listenTls()` themselves have NO
 * mechanism to REQUIRE or VERIFY an incoming client certificate (a genuinely open Deno platform
 * gap: {@link https://github.com/denoland/deno/issues/26825}, unresolved as of this writing) — a
 * `remote` app served through the regular `Deno.serve()`-based routes can't reject an uncertified
 * caller at the TLS layer. To reach a target that DOES enforce the incoming half of mTLS, point
 * this adapter's `endpoint` (via the Control Plane) at that target's dedicated mTLS listener
 * instead (`mtls-dispatch-server.ts`, started via `RemoteInstanceOptions.mtls` on the target's own
 * side) — confirmed working end-to-end (`node:https`'s `requestCert`/`rejectUnauthorized`, unlike
 * `Deno.serve()`, genuinely rejects an uncertified connection and exposes the peer certificate).
 * Either way, the application-layer service-token exchange
 * (`@AuthTokenValidation({type: 'api'})`) still gates access independently — this option adds
 * transport-layer identity on top of it, never a replacement for it.
 *
 * The certificate covers BOTH legs of a call against a real mTLS-enforcing target — the
 * service-token exchange (`createServiceAuthClient`, `@zanix/auth`) as well as the operation call
 * itself — not only the second one. `#authClientFor` passes this same `Deno.HttpClient` into
 * `createServiceAuthClient`'s own `httpClient` option (`@zanix/auth`, added alongside this feature)
 * precisely so the exchange call presents a certificate too: `requestCert`/`rejectUnauthorized` are
 * negotiated once, for the whole TLS connection, not per HTTP request — a target that enforces mTLS
 * rejects an uncertified exchange call exactly as it would an uncertified operation call.
 */
export interface HttpRemoteAdapterTlsOptions {
  /** This process's own client certificate chain, PEM. */
  cert: string
  /** This process's own private key, matching `cert`, PEM. */
  key: string
  /** Additional trusted CA certificates, PEM — needed when a target's server certificate isn't
   * signed by a CA Deno already trusts (e.g. an internal/self-signed CA). */
  caCerts?: string[]
}

/**
 * `HttpRemoteDispatcher` for real, cross-process calls — the v1 transport. Resolves the target's
 * live endpoints through
 * the Control Plane Registry, authenticates with `@zanix/auth`'s own
 * service-to-service mechanism (never a new one), propagates a W3C `traceparent`, and enforces
 * the caller's `timeoutMs` via `AbortSignal.timeout()`.
 *
 * One instance is meant to be shared across every app a process activates — it keeps its own
 * per-caller-app `createServiceAuthClient` cache (each client already caches its own per-target
 * tokens internally; this only avoids re-creating that cache on every single call).
 */
export class HttpRemoteAdapter implements HttpRemoteDispatcher {
  #registry: ControlPlaneRegistry
  #authClients = new Map<string, ServiceAuthClient>()
  #httpClient?: Deno.HttpClient
  #roundRobin = new RoundRobinPicker()

  /** Wraps the Control Plane Registry used to resolve a target app's live endpoints.
   * @param registry Where a target app's live endpoints are looked up — see `ControlPlaneRegistry`.
   * @param tls Presents a client certificate on every outgoing call — see
   * {@linkcode HttpRemoteAdapterTlsOptions}'s own doc for what this does and does NOT achieve.
   * Omit entirely for plain HTTP/TLS with no client certificate (the default). */
  constructor(
    registry: ControlPlaneRegistry,
    tls?: HttpRemoteAdapterTlsOptions,
  ) {
    this.#registry = registry
    this.#httpClient = tls && Deno.createHttpClient(tls)
  }

  /** Releases the TLS client connection pool, if `tls` was passed to the constructor — a no-op
   * otherwise. Never called automatically; the caller owns this instance's lifecycle. */
  public close(): void {
    this.#httpClient?.close()
  }

  /** The Registry this adapter resolves targets through — `announceRemoteInstance`
   * (`remote-lifecycle.ts`) reuses this SAME instance for registering/renewing/deregistering an
   * instance, so both sides of the Control Plane relationship share one Registry. */
  public get registry(): ControlPlaneRegistry {
    return this.#registry
  }

  #authClientFor(callerAppName: string): ServiceAuthClient {
    let client = this.#authClients.get(callerAppName)
    if (!client) {
      // Passing `this.#httpClient` here (rather than letting `createServiceAuthClient` build its
      // own plain `RestClient`) matters once `tls` is configured: without it, the service-token
      // exchange call — which happens BEFORE the operation call below — would present no client
      // certificate at all, and a genuinely mTLS-enforcing target (`mtls-dispatch-server.ts`,
      // `requestCert`/`rejectUnauthorized` apply to the whole TLS connection, not per-endpoint)
      // would reject it regardless of what the operation call itself presents afterward.
      client = createServiceAuthClient({
        serviceId: callerAppName,
        httpClient: this.#httpClient,
      })
      this.#authClients.set(callerAppName, client)
    }
    return client
  }

  /**
   * Resolves `targetAppName`'s live endpoint via the Control Plane, exchanges/reuses a service
   * token for `callerAppName`, then POSTs `payload` to it — see the class's own doc for the full
   * protocol.
   * @param callerAppName The identity to authenticate the outgoing call as.
   * @param targetAppName The app to reach.
   * @param operationName Which of `targetAppName`'s declared `operations` to invoke.
   * @param payload JSON-serializable data to send.
   * @param options See {@linkcode RemoteCallOptions}.
   * @throws {InternalError} `REMOTE_APP_UNREACHABLE` if `targetAppName` has no live instance;
   * `REMOTE_CALL_TIMEOUT` if `options.timeoutMs` elapses first; `REMOTE_CALL_FAILED` for any other
   * transport/HTTP failure.
   */
  public async dispatch(
    callerAppName: string,
    targetAppName: string,
    operationName: string,
    payload: unknown,
    options: RemoteCallOptions,
  ): Promise<unknown> {
    const target = await this.#registry.getDeploymentTarget(targetAppName)
    if (!target) {
      throw new InternalError(
        `Zanix App "${targetAppName}" is not currently discoverable — no live instance is ` +
          `registered in the Control Plane.`,
        {
          code: 'REMOTE_APP_UNREACHABLE',
          meta: {
            source: 'zanix',
            callerAppName,
            targetAppName,
            operationName,
          },
        },
      )
    }

    const endpoint = this.#roundRobin.pick(targetAppName, target.endpoints)
    const baseUrl = `${endpoint}/${OPERATIONS_PATH_SEGMENT}/${targetAppName}`
    const exchangeUrl = `${baseUrl}/${SERVICE_TOKEN_PATH_SEGMENT}`

    let authHeaders: ServiceAuthHeaders
    let response: Response
    try {
      // Both calls share the same try/catch — a failure exchanging a service token (e.g. a
      // genuinely mTLS-enforcing target rejecting a caller with no/invalid client certificate) is
      // just as much a transport/HTTP failure as the operation call itself failing, and this
      // class's own `@throws` contract below never distinguished between the two.
      authHeaders = await this.#authClientFor(callerAppName)(
        targetAppName,
        exchangeUrl,
      )
      response = await fetch(`${baseUrl}/${operationName}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          traceparent: generateTraceparent(),
          ...authHeaders,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(options.timeoutMs),
        ...(this.#httpClient ? { client: this.#httpClient } : {}),
      })
    } catch (error) {
      const isTimeout = error instanceof Error && error.name === 'TimeoutError'
      throw new InternalError(
        isTimeout
          ? `Remote call to "${targetAppName}.${operationName}" timed out after ` +
            `${options.timeoutMs}ms.`
          : `Remote call to "${targetAppName}.${operationName}" failed before a response was ` +
            `received.`,
        {
          code: isTimeout ? 'REMOTE_CALL_TIMEOUT' : 'REMOTE_CALL_FAILED',
          cause: error,
          meta: {
            source: 'zanix',
            callerAppName,
            targetAppName,
            operationName,
            endpoint,
          },
        },
      )
    }

    if (!response.ok) {
      throw new InternalError(
        `Remote call to "${targetAppName}.${operationName}" failed with HTTP ${response.status}.`,
        {
          code: 'REMOTE_CALL_FAILED',
          meta: {
            source: 'zanix',
            callerAppName,
            targetAppName,
            operationName,
            endpoint,
            status: response.status,
          },
        },
      )
    }

    return await response.json()
  }
}

/**
 * The default `HttpRemoteDispatcher` `activateApps()` falls back to when none is passed
 * explicitly — auto-detects the `'controlPlane'` core-provider slot (registered only if a host
 * imported `@zanix/app/core`; see that module's own doc) and, if present, builds an
 * `HttpRemoteAdapter` around its `ControlPlaneRegistry`. Returns `undefined`, never throws, when
 * the slot was never registered — the caller's own local-only fallback applies unchanged.
 */
export function resolveDefaultDispatcher(): HttpRemoteAdapter | undefined {
  const provider = resolveControlPlaneProvider()
  return provider && new HttpRemoteAdapter(provider.controlPlaneRegistry)
}
