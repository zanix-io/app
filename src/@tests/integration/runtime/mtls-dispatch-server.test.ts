import { assert, assertEquals, assertRejects } from '@std/assert'
import { generateRSAKeys, getTemporaryFolder } from '@zanix/helpers'
import { createServiceAssertion } from '@zanix/auth'
import { InternalError } from '@zanix/errors'
import { ZanixRedisConnector } from '@zanix/datamaster'
import { normalize } from 'modules/manifest/normalize.ts'
import { ControlPlaneRegistry } from 'modules/runtime/control-plane/mod.ts'
import {
  HttpRemoteAdapter,
  OPERATIONS_PATH_SEGMENT,
  SERVICE_TOKEN_PATH_SEGMENT,
} from 'modules/runtime/http-remote-adapter.ts'
import { registerOperations } from 'modules/runtime/operation-registry.ts'
import { startMtlsDispatchServer } from 'modules/runtime/mtls-dispatch-server.ts'
import { generateMtlsTestCertChain } from './mtls-test-certs.ts'

console.info = () => {}
console.error = () => {}
console.warn = () => {}

// `@AuthTokenValidation`-style token verification here goes through `@zanix/auth`'s own
// `getSecretByToken`/`verifyJWT` directly (see `mtls-dispatch-server.ts`) — real RSA keys, no
// mocking, same convention as `http-remote-adapter.test.ts`.
const AUTH_KEYS = await generateRSAKeys()
Deno.env.set('JWK_PRI', btoa(AUTH_KEYS.privateKey))
Deno.env.set('JWK_PUB', btoa(AUTH_KEYS.publicKey))

const CALLER_APP = 'mtls-dispatch-caller'
const CALLER_KEYS = await generateRSAKeys()
Deno.env.set(`JWK_PUB_${CALLER_APP}`, btoa(CALLER_KEYS.publicKey))
// `HttpRemoteAdapter`'s own `createServiceAuthClient` resolves this automatically (unlike the
// direct `createServiceAssertion` calls above, which pass `privateKey` explicitly) — needed only
// by the two `HttpRemoteAdapter`-based tests near the end of this file.
Deno.env.set(`JWK_PRI_${CALLER_APP}`, btoa(CALLER_KEYS.privateKey))

const TARGET_APP = 'mtls-dispatch-target'
const targetDef = normalize({
  name: TARGET_APP,
  operations: {
    echo: (payload: unknown) => Promise.resolve({ echoed: payload }),
  },
})
registerOperations(targetDef, new Map())

const certsDir = getTemporaryFolder(import.meta.url) +
  '/mtls-dispatch-server-certs'
const certs = await generateMtlsTestCertChain(certsDir)

// `DENO_CERT` makes this whole process additionally trust our throwaway test CA when VERIFYING a
// server certificate (on top of, never instead of, Deno's normal trust store — confirmed by
// direct testing) — needed because `HttpRemoteAdapter`'s own service-token exchange goes through
// `@zanix/auth`'s `createServiceAuthClient` → `RestClient` → plain `fetch()`, which has no
// `caCerts` option of its own the way `Deno.createHttpClient` does; this is the one process-wide
// way to make that same call trust our self-signed server certificate. Must be set before the
// first `fetch()`/TLS handshake in this process — confirmed to still work if set here, dynamically,
// as long as it's before that first call.
Deno.env.set('DENO_CERT', `${certsDir}/ca.pem`)

const PORT = 8643
const BASE_URL = `https://localhost:${PORT}/${OPERATIONS_PATH_SEGMENT}/${TARGET_APP}`

const server = startMtlsDispatchServer({
  port: PORT,
  cert: certs.serverCert,
  key: certs.serverKey,
  ca: [certs.ca],
})

// Real Redis connector — no mocking, same pattern as the rest of this suite's integration tests.
const connector = new ZanixRedisConnector()
const registry = new ControlPlaneRegistry(connector)
await registry.registerInstance(TARGET_APP, 'instance-1', {
  prefix: TARGET_APP,
  endpoint: `https://localhost:${PORT}`,
})

async function assertionFor(
  serviceId: string,
  privateKey: string,
): Promise<string> {
  return await createServiceAssertion({
    serviceId,
    privateKey: btoa(privateKey),
  })
}

Deno.test(
  'startMtlsDispatchServer: rejects a connection with no client certificate at the TLS layer',
  async () => {
    const noCertClient = Deno.createHttpClient({ caCerts: [certs.ca] })
    try {
      await assertRejects(() =>
        fetch(`${BASE_URL}/${SERVICE_TOKEN_PATH_SEGMENT}`, {
          method: 'POST',
          client: noCertClient,
          body: '{}',
          headers: { 'content-type': 'application/json' },
        })
      )
    } finally {
      noCertClient.close()
    }
  },
)

Deno.test(
  'startMtlsDispatchServer: with a valid client certificate but no bearer token, an operation call is rejected with 403',
  async () => {
    const client = Deno.createHttpClient({
      cert: certs.clientCert,
      key: certs.clientKey,
      caCerts: [certs.ca],
    })
    try {
      const response = await fetch(`${BASE_URL}/echo`, {
        method: 'POST',
        client,
        body: JSON.stringify({ hi: 1 }),
        headers: { 'content-type': 'application/json' },
      })
      assertEquals(response.status, 403)
      await response.body?.cancel()
    } finally {
      client.close()
    }
  },
)

Deno.test(
  'startMtlsDispatchServer: with a valid client certificate but a garbage bearer token, an operation call is rejected with 403',
  async () => {
    const client = Deno.createHttpClient({
      cert: certs.clientCert,
      key: certs.clientKey,
      caCerts: [certs.ca],
    })
    try {
      const response = await fetch(`${BASE_URL}/echo`, {
        method: 'POST',
        client,
        body: JSON.stringify({ hi: 1 }),
        headers: {
          'content-type': 'application/json',
          'X-Znx-Authorization': 'Bearer not-a-real-jwt',
        },
      })
      assertEquals(response.status, 403)
      await response.body?.cancel()
    } finally {
      client.close()
    }
  },
)

Deno.test(
  'startMtlsDispatchServer: service-token exchange mints a real access token for a valid assertion',
  async () => {
    const client = Deno.createHttpClient({
      cert: certs.clientCert,
      key: certs.clientKey,
      caCerts: [certs.ca],
    })
    try {
      const assertion = await assertionFor(CALLER_APP, CALLER_KEYS.privateKey)
      const response = await fetch(
        `${BASE_URL}/${SERVICE_TOKEN_PATH_SEGMENT}`,
        {
          method: 'POST',
          client,
          body: JSON.stringify({ assertion }),
          headers: { 'content-type': 'application/json' },
        },
      )
      assertEquals(response.status, 200)
      const body = await response.json()
      assertEquals(body.serviceId, CALLER_APP)
      assert(
        typeof body.accessToken === 'string' && body.accessToken.length > 0,
      )
    } finally {
      client.close()
    }
  },
)

Deno.test(
  'startMtlsDispatchServer: an operation name the target never registered returns 400',
  async () => {
    const client = Deno.createHttpClient({
      cert: certs.clientCert,
      key: certs.clientKey,
      caCerts: [certs.ca],
    })
    try {
      const assertion = await assertionFor(CALLER_APP, CALLER_KEYS.privateKey)
      const tokenResponse = await fetch(
        `${BASE_URL}/${SERVICE_TOKEN_PATH_SEGMENT}`,
        {
          method: 'POST',
          client,
          body: JSON.stringify({ assertion }),
          headers: { 'content-type': 'application/json' },
        },
      )
      const { accessToken } = await tokenResponse.json()

      const response = await fetch(`${BASE_URL}/doesNotExist`, {
        method: 'POST',
        client,
        body: '{}',
        headers: {
          'content-type': 'application/json',
          'X-Znx-Authorization': `Bearer ${accessToken}`,
        },
      })
      assertEquals(response.status, 400)
      await response.body?.cancel()
    } finally {
      client.close()
    }
  },
)

Deno.test(
  'startMtlsDispatchServer: real end-to-end round trip through HttpRemoteAdapter — client cert + service-token exchange + operation dispatch, all real',
  async () => {
    const adapter = new HttpRemoteAdapter(registry, {
      cert: certs.clientCert,
      key: certs.clientKey,
      caCerts: [certs.ca],
    })
    try {
      const result = await adapter.dispatch(CALLER_APP, TARGET_APP, 'echo', {
        text: 'hi',
      }, {
        timeoutMs: 3000,
      })
      assertEquals(result, { echoed: { text: 'hi' } })
    } finally {
      adapter.close()
    }
  },
)

Deno.test(
  'startMtlsDispatchServer: HttpRemoteAdapter with no client certificate fails the call (REMOTE_CALL_FAILED)',
  async () => {
    const adapter = new HttpRemoteAdapter(registry)
    const error = await assertRejects(
      () =>
        adapter.dispatch(CALLER_APP, TARGET_APP, 'echo', { text: 'hi' }, {
          timeoutMs: 3000,
        }),
      InternalError,
    )
    assertEquals((error as InternalError).code, 'REMOTE_CALL_FAILED')
  },
)

Deno.test(
  'startMtlsDispatchServer: a path missing the app name/action segments returns 404',
  async () => {
    const client = Deno.createHttpClient({
      cert: certs.clientCert,
      key: certs.clientKey,
      caCerts: [certs.ca],
    })
    try {
      const response = await fetch(
        `https://localhost:${PORT}/${OPERATIONS_PATH_SEGMENT}`,
        {
          method: 'POST',
          client,
          body: '{}',
          headers: { 'content-type': 'application/json' },
        },
      )
      assertEquals(response.status, 404)
      await response.body?.cancel()
    } finally {
      client.close()
    }
  },
)

Deno.test(
  'startMtlsDispatchServer: a GET request to the dispatch surface returns 404 (only POST is served)',
  async () => {
    const client = Deno.createHttpClient({
      cert: certs.clientCert,
      key: certs.clientKey,
      caCerts: [certs.ca],
    })
    try {
      const response = await fetch(`${BASE_URL}/echo`, {
        method: 'GET',
        client,
      })
      assertEquals(response.status, 404)
      await response.body?.cancel()
    } finally {
      client.close()
    }
  },
)

Deno.test(
  'startMtlsDispatchServer: service-token exchange with a garbage assertion returns 403',
  async () => {
    const client = Deno.createHttpClient({
      cert: certs.clientCert,
      key: certs.clientKey,
      caCerts: [certs.ca],
    })
    try {
      const response = await fetch(
        `${BASE_URL}/${SERVICE_TOKEN_PATH_SEGMENT}`,
        {
          method: 'POST',
          client,
          body: JSON.stringify({ assertion: 'not-a-real-assertion' }),
          headers: { 'content-type': 'application/json' },
        },
      )
      assertEquals(response.status, 403)
      await response.body?.cancel()
    } finally {
      client.close()
    }
  },
)

Deno.test(
  'startMtlsDispatchServer: a completely empty request body (no assertion at all) is treated the same as a missing assertion — 403',
  async () => {
    const client = Deno.createHttpClient({
      cert: certs.clientCert,
      key: certs.clientKey,
      caCerts: [certs.ca],
    })
    try {
      const response = await fetch(
        `${BASE_URL}/${SERVICE_TOKEN_PATH_SEGMENT}`,
        {
          method: 'POST',
          client,
          body: '',
          headers: { 'content-type': 'application/json' },
        },
      )
      assertEquals(response.status, 403)
      await response.body?.cancel()
    } finally {
      client.close()
    }
  },
)

Deno.test(
  "startMtlsDispatchServer: the target operation's own handler throwing surfaces as 500",
  async () => {
    const explodingDef = normalize({
      name: TARGET_APP,
      operations: {
        explode: () => {
          throw new Error('handler blew up')
        },
      },
    })
    registerOperations(explodingDef, new Map())

    const client = Deno.createHttpClient({
      cert: certs.clientCert,
      key: certs.clientKey,
      caCerts: [certs.ca],
    })
    try {
      const assertion = await assertionFor(CALLER_APP, CALLER_KEYS.privateKey)
      const tokenResponse = await fetch(
        `${BASE_URL}/${SERVICE_TOKEN_PATH_SEGMENT}`,
        {
          method: 'POST',
          client,
          body: JSON.stringify({ assertion }),
          headers: { 'content-type': 'application/json' },
        },
      )
      const { accessToken } = await tokenResponse.json()

      const response = await fetch(`${BASE_URL}/explode`, {
        method: 'POST',
        client,
        body: '{}',
        headers: {
          'content-type': 'application/json',
          'X-Znx-Authorization': `Bearer ${accessToken}`,
        },
      })
      assertEquals(response.status, 500)
      await response.body?.cancel()
    } finally {
      client.close()
    }
  },
)

Deno.test(
  'startMtlsDispatchServer: a malformed JSON body is caught by the top-level handler and surfaces as 500',
  async () => {
    const client = Deno.createHttpClient({
      cert: certs.clientCert,
      key: certs.clientKey,
      caCerts: [certs.ca],
    })
    try {
      const response = await fetch(
        `${BASE_URL}/${SERVICE_TOKEN_PATH_SEGMENT}`,
        {
          method: 'POST',
          client,
          body: '{not valid json',
          headers: { 'content-type': 'application/json' },
        },
      )
      assertEquals(response.status, 500)
      await response.body?.cancel()
    } finally {
      client.close()
    }
  },
)

Deno.test(
  'startMtlsDispatchServer: an operation restricted to a different allowedCallers entry is rejected with 403, same as the HTTP dispatch route',
  async () => {
    const restrictedDef = normalize({
      name: TARGET_APP,
      operations: {
        restricted: {
          handler: () => Promise.resolve({ ok: true }),
          allowedCallers: ['someone-else'],
        },
      },
    })
    registerOperations(restrictedDef, new Map())

    const client = Deno.createHttpClient({
      cert: certs.clientCert,
      key: certs.clientKey,
      caCerts: [certs.ca],
    })
    try {
      const assertion = await assertionFor(CALLER_APP, CALLER_KEYS.privateKey)
      const tokenResponse = await fetch(
        `${BASE_URL}/${SERVICE_TOKEN_PATH_SEGMENT}`,
        {
          method: 'POST',
          client,
          body: JSON.stringify({ assertion }),
          headers: { 'content-type': 'application/json' },
        },
      )
      const { accessToken } = await tokenResponse.json()

      const response = await fetch(`${BASE_URL}/restricted`, {
        method: 'POST',
        client,
        body: '{}',
        headers: {
          'content-type': 'application/json',
          'X-Znx-Authorization': `Bearer ${accessToken}`,
        },
      })
      assertEquals(response.status, 403)
      await response.body?.cancel()
    } finally {
      client.close()
    }
  },
)

Deno.test(
  'startMtlsDispatchServer: an operation whose allowedCallers includes the caller still dispatches normally',
  async () => {
    const allowedDef = normalize({
      name: TARGET_APP,
      operations: {
        allowed: {
          handler: () => Promise.resolve({ ok: true }),
          allowedCallers: [CALLER_APP],
        },
      },
    })
    registerOperations(allowedDef, new Map())

    const client = Deno.createHttpClient({
      cert: certs.clientCert,
      key: certs.clientKey,
      caCerts: [certs.ca],
    })
    try {
      const assertion = await assertionFor(CALLER_APP, CALLER_KEYS.privateKey)
      const tokenResponse = await fetch(
        `${BASE_URL}/${SERVICE_TOKEN_PATH_SEGMENT}`,
        {
          method: 'POST',
          client,
          body: JSON.stringify({ assertion }),
          headers: { 'content-type': 'application/json' },
        },
      )
      const { accessToken } = await tokenResponse.json()

      const response = await fetch(`${BASE_URL}/allowed`, {
        method: 'POST',
        client,
        body: '{}',
        headers: {
          'content-type': 'application/json',
          'X-Znx-Authorization': `Bearer ${accessToken}`,
        },
      })
      assertEquals(response.status, 200)
      assertEquals(await response.json(), { ok: true })
    } finally {
      client.close()
    }
  },
)

// Keep these at the end — tears down the mTLS listener, the Control Plane registration, and the
// shared Redis connection, in that order.
Deno.test('close the mTLS dispatch server and deregister the target instance', async () => {
  await registry.deregisterInstance(TARGET_APP, 'instance-1')
  await server.close()
})

Deno.test('close the shared Redis connection', () => {
  connector['close']()
  Deno.env.delete('JWK_PRI')
  Deno.env.delete('JWK_PUB')
  Deno.env.delete(`JWK_PUB_${CALLER_APP}`)
  Deno.env.delete(`JWK_PRI_${CALLER_APP}`)
  Deno.env.delete('DENO_CERT')
})
