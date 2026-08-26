import type { IncomingMessage, ServerResponse } from 'node:http'
import https from 'node:https'
import { AUTH_HEADERS } from '@zanix/server'
import { lazyFunction, lazyValue } from '@zanix/helpers'
import { getLocalOperation, isCallerAllowed } from './operation-registry.ts'
import { OPERATIONS_PATH_SEGMENT, SERVICE_TOKEN_PATH_SEGMENT } from './http-remote-adapter.ts'
import { AUTH_SPECIFIER } from '../lazy/specifiers.ts'

/**
 * Lazily resolves `@zanix/auth`'s own exports this module calls — never importing that package
 * until this listener is actually started AND a real request reaches one of these (see
 * `http-remote-adapter.ts`'s own doc for why the specifier is a deliberately non-literal,
 * fully-qualified `jsr:` string, and for why the type parameters below are synthetic, narrow
 * signatures rather than a real `typeof import('@zanix/auth')`).
 */
const getDefaultAuthIssuer = lazyValue<string>(AUTH_SPECIFIER, 'DEFAULT_AUTH_ISSUER')
const getSecretByToken = lazyFunction<(token: string, type?: 'user' | 'api') => string>(
  AUTH_SPECIFIER,
  'getSecretByToken',
)
const verifyJWT = lazyFunction<
  (
    token: string,
    secret: string,
    options?: { algorithm?: string; iss?: string },
  ) => { sub?: string }
>(AUTH_SPECIFIER, 'verifyJWT')
const exchangeServiceCredential = lazyFunction<(assertion: string) => unknown>(
  AUTH_SPECIFIER,
  'exchangeServiceCredential',
)

/**
 * Dedicated mTLS listener for the `/__zanix-ops/...` dispatch surface ONLY — the one way to
 * actually close the INCOMING half of mTLS, since `Deno.serve()`/`Deno.listenTls()`
 * have no mechanism to require/verify a client certificate (see `HttpRemoteAdapterTlsOptions`'s own
 * doc). Built on Deno's `node:https` compatibility layer, confirmed by running it end-to-end
 * against a real client certificate (rejected with none, accepted a valid one, `authorized: true`,
 * real peer certificate subject readable) — genuinely different from `Deno.serve()`, not a retry of
 * the same gap.
 *
 * Deliberately narrow: this does NOT replace `@zanix/server`'s `webServerManager`/`Deno.serve()` for
 * anything else — an app's normal `routes` keep being served exactly as before. Only the two
 * `/__zanix-ops/${appName}/...` endpoints (`registerRemoteDispatchRoutes`'s own Deno.serve-based
 * versions) get a second, mTLS-enforcing way to reach the SAME underlying logic
 * (`getLocalOperation`/`exchangeServiceCredential`) — a caller picks one transport or the other by
 * which `endpoint` it was given, never both for the same call.
 */
export interface MtlsDispatchOptions {
  /** Port to listen on for mTLS-verified dispatch requests. */
  port: number
  /** Hostname to bind — defaults to every interface (`'0.0.0.0'`), matching `Deno.serve()`'s own
   * default elsewhere in this package. */
  hostname?: string
  /** This instance's own server certificate chain, PEM. */
  cert: string
  /** This instance's own private key, matching `cert`, PEM. */
  key: string
  /** Trusted CA certificate(s), PEM — a connecting client's certificate must chain to one of
   * these, or the TLS handshake itself is rejected before any request is ever read. */
  ca: string[]
}

/** A running {@linkcode startMtlsDispatchServer} instance. */
export interface MtlsDispatchServer {
  /** The port this listener is bound to — echoes `options.port`. */
  readonly port: number
  /** Stops listening, closing any still-open connections. */
  close(): Promise<void>
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = []
    req.on('data', (chunk: Uint8Array) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(text)
}

/** Verifies a presented `X-Znx-Authorization: Bearer <token>` the exact same way
 * `@zanix/auth`'s own `jwtValidationGuard({type: 'api'})` does (`getSecretByToken` +
 * `verifyJWT` with `algorithm: 'RS256'`/`iss: DEFAULT_AUTH_ISSUER`) — reusing those primitives
 * directly rather than the full guard, which is built around `@zanix/server`'s `HandlerContext`
 * (rate limiting, blocklist, cookies) that has no natural translation over a raw `node:https`
 * socket. The mTLS handshake itself is this listener's primary gate; this closes the same
 * service-identity check the regular (non-mTLS) dispatch route also enforces.
 * @returns The verified token's own `sub` claim — the calling app's identity, used by
 * `handleRequest` for the same `isCallerAllowed` check the HTTP dispatch route enforces. */
async function verifyServiceToken(req: IncomingMessage): Promise<string | undefined> {
  const header = req.headers[AUTH_HEADERS.api.toLowerCase()]
  const value = Array.isArray(header) ? header[0] : header
  const token = value?.startsWith('Bearer ') ? value.slice(7).trim() : undefined
  if (!token) {
    throw new Error(`${AUTH_HEADERS.api} token is missing or invalid.`)
  }

  // `@zanix/auth` is never imported until one of the lazy wrappers above is actually called —
  // this listener is never started at all unless a host explicitly passes
  // `RemoteInstanceOptions.mtls`.
  const secret = await getSecretByToken(token, 'api')
  const payload = await verifyJWT(token, atob(secret), {
    algorithm: 'RS256',
    iss: await getDefaultAuthIssuer(),
  })

  return payload.sub
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'https://mtls-dispatch.internal')
  const [segment, appName, action] = url.pathname.split('/').filter(Boolean)

  if (
    req.method !== 'POST' || segment !== OPERATIONS_PATH_SEGMENT || !appName ||
    !action
  ) {
    sendJson(res, 404, { message: 'Not found.' })
    return
  }

  const rawBody = await readBody(req)
  const payload = rawBody ? JSON.parse(rawBody) : undefined

  if (action === SERVICE_TOKEN_PATH_SEGMENT) {
    try {
      sendJson(res, 200, await exchangeServiceCredential(payload?.assertion))
    } catch (error) {
      sendJson(res, 403, { message: (error as Error).message })
    }
    return
  }

  let callerAppName: string | undefined
  try {
    callerAppName = await verifyServiceToken(req)
  } catch (error) {
    sendJson(res, 403, { message: (error as Error).message })
    return
  }

  const local = getLocalOperation(appName, action)
  if (!local) {
    sendJson(res, 400, {
      message: `Zanix App "${appName}" has no operation named "${action}".`,
    })
    return
  }

  if (!isCallerAllowed(local.allowedCallers, callerAppName ?? '')) {
    sendJson(res, 403, {
      message: `Zanix App "${callerAppName}" is not allowed to invoke "${appName}"'s ` +
        `operation "${action}".`,
    })
    return
  }

  try {
    sendJson(res, 200, await local.handler(payload, local.ctx))
  } catch (error) {
    sendJson(res, 500, { message: (error as Error).message })
  }
}

/** Starts the mTLS dispatch listener — see this module's own doc for exactly what it does and
 * doesn't replace.
 * @param options See {@linkcode MtlsDispatchOptions}. */
export function startMtlsDispatchServer(
  options: MtlsDispatchOptions,
): MtlsDispatchServer {
  const server = https.createServer(
    {
      cert: options.cert,
      key: options.key,
      ca: options.ca,
      requestCert: true,
      rejectUnauthorized: true,
    },
    (req, res) => {
      handleRequest(req, res).catch((error) => {
        sendJson(res, 500, { message: (error as Error).message })
      })
    },
  )

  server.listen(options.port, options.hostname ?? '0.0.0.0')

  return {
    port: options.port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}
