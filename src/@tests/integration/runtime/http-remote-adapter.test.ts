import { assert, assertEquals, assertRejects } from '@std/assert'
import { generateRSAKeys } from '@zanix/helpers'
import { createJWT } from '@zanix/auth'
import { InternalError } from '@zanix/errors'
import { ZanixRedisConnector } from '@zanix/datamaster'
import { defineZanixApp } from 'modules/manifest/mod.ts'
import { ControlPlaneRegistry } from 'modules/runtime/control-plane/mod.ts'
import { HttpRemoteAdapter, OPERATIONS_PATH_SEGMENT } from 'modules/runtime/http-remote-adapter.ts'

console.info = () => {}
console.error = () => {}
console.warn = () => {}

// `@AuthTokenValidation({type: 'api'})`'s guard checks a token revocation blocklist via the
// 'cache' core PROVIDER + 'kvLocal' core CONNECTOR slots — neither is registered unless
// `@zanix/datamaster/core` has been imported. `REDIS_URI` must already be set before that import
// evaluates (it gates whether the real `cache:redis` connector gets registered at module-load
// time) — a static `import` would be hoisted above this `Deno.env.set`, so a dynamic one is used
// instead, deliberately sequenced after it.
Deno.env.set('REDIS_URI', 'redis://localhost:6379')
await import('@zanix/datamaster/core')

const CALLER_APP = 'http-adapter-caller'

// Real Redis connector for the Control Plane Registry — no mocking.
const connector = new ZanixRedisConnector()
const registry = new ControlPlaneRegistry(connector)
const adapter = new HttpRemoteAdapter(registry)

/**
 * Brings up ONE real Zanix App (`appName`), serving real HTTP on `port`, with two operations:
 * `echo` (returns its payload wrapped) and `slow` (waits past any reasonable test timeout) — real
 * enough to exercise `HttpRemoteAdapter`'s full round trip (Control Plane lookup, service-token
 * exchange, `@AuthTokenValidation`-protected dispatch, real HTTP), not a stub.
 *
 * Each call uses ITS OWN `appName`/port, deliberately — reusing the same Application name (and/or
 * port) across two separate `.serve()`/`.stop()` cycles in the SAME process produced a real
 * `ECONNREFUSED` on the second call in practice, unrelated to anything this test is actually meant
 * to verify (some `@zanix/server`/`ProgramModule` state tied to the Application name or listener
 * outlives `stop()` — out of scope to chase down here; a fresh identity per call sidesteps it).
 */
async function withServedTarget(
  appName: string,
  port: number,
  fn: () => Promise<void>,
): Promise<void> {
  const target = defineZanixApp({
    name: appName,
    routes: false,
    operations: {
      echo: (payload: unknown) => Promise.resolve({ echoed: payload }),
      slow: (payload: unknown) =>
        new Promise((resolve) => setTimeout(() => resolve(payload), 2000)),
      secretother: {
        handler: () =>
          Promise.resolve({
            reached: 'should never be reachable by CALLER_APP',
          }),
        allowedCallers: ['someone-else'],
      },
      secretmine: {
        handler: () => Promise.resolve({ reached: true }),
        allowedCallers: [CALLER_APP],
      },
    },
  })

  const handle = await target.serve({ server: { rest: { port } } })
  await new Promise((resolve) => setTimeout(resolve, 300))

  try {
    await registry.registerInstance(appName, 'instance-1', {
      prefix: `/${appName}`,
      endpoint: `http://localhost:${port}/api`,
    })
    await fn()
  } finally {
    await registry.deregisterInstance(appName, 'instance-1')
    await handle.stop()
  }
}

Deno.test(
  'HttpRemoteAdapter: real HTTP round trip — service-token exchange + @AuthTokenValidation-protected dispatch, real Redis Control Plane lookup',
  async () => {
    const serviceKeys = await generateRSAKeys()
    const appKeys = await generateRSAKeys()
    Deno.env.set(`JWK_PRI_${CALLER_APP}`, btoa(serviceKeys.privateKey))
    Deno.env.set(`JWK_PUB_${CALLER_APP}`, btoa(serviceKeys.publicKey))
    Deno.env.set('JWK_PRI', btoa(appKeys.privateKey))
    Deno.env.set('JWK_PUB', btoa(appKeys.publicKey))

    const targetApp = 'http-adapter-target-echo'

    try {
      await withServedTarget(targetApp, 4720, async () => {
        const result = await adapter.dispatch(CALLER_APP, targetApp, 'echo', {
          text: 'hi',
        }, {
          timeoutMs: 3000,
        })

        assertEquals(result, { echoed: { text: 'hi' } })
      })
    } finally {
      Deno.env.delete(`JWK_PRI_${CALLER_APP}`)
      Deno.env.delete(`JWK_PUB_${CALLER_APP}`)
      Deno.env.delete('JWK_PRI')
      Deno.env.delete('JWK_PUB')
    }
  },
)

Deno.test(
  'HttpRemoteAdapter: a REMOTE call to an operation whose allowedCallers excludes the caller ' +
    'is denied — REMOTE_CALL_FAILED with HTTP 403, the handler never runs',
  async () => {
    const serviceKeys = await generateRSAKeys()
    const appKeys = await generateRSAKeys()
    Deno.env.set(`JWK_PRI_${CALLER_APP}`, btoa(serviceKeys.privateKey))
    Deno.env.set(`JWK_PUB_${CALLER_APP}`, btoa(serviceKeys.publicKey))
    Deno.env.set('JWK_PRI', btoa(appKeys.privateKey))
    Deno.env.set('JWK_PUB', btoa(appKeys.publicKey))

    const targetApp = 'http-adapter-target-scoped-deny'

    try {
      await withServedTarget(targetApp, 4722, async () => {
        const error = await assertRejects(
          () =>
            adapter.dispatch(CALLER_APP, targetApp, 'secretother', {}, {
              timeoutMs: 3000,
            }),
          InternalError,
        )

        assertEquals((error as InternalError).code, 'REMOTE_CALL_FAILED')
        assertEquals((error as InternalError).meta?.status, 403)
      })
    } finally {
      Deno.env.delete(`JWK_PRI_${CALLER_APP}`)
      Deno.env.delete(`JWK_PUB_${CALLER_APP}`)
      Deno.env.delete('JWK_PRI')
      Deno.env.delete('JWK_PUB')
    }
  },
)

Deno.test(
  'HttpRemoteAdapter: a REMOTE call to an operation whose allowedCallers includes the caller ' +
    'succeeds normally',
  async () => {
    const serviceKeys = await generateRSAKeys()
    const appKeys = await generateRSAKeys()
    Deno.env.set(`JWK_PRI_${CALLER_APP}`, btoa(serviceKeys.privateKey))
    Deno.env.set(`JWK_PUB_${CALLER_APP}`, btoa(serviceKeys.publicKey))
    Deno.env.set('JWK_PRI', btoa(appKeys.privateKey))
    Deno.env.set('JWK_PUB', btoa(appKeys.publicKey))

    const targetApp = 'http-adapter-target-scoped-allow'

    try {
      await withServedTarget(targetApp, 4723, async () => {
        const result = await adapter.dispatch(
          CALLER_APP,
          targetApp,
          'secretmine',
          {},
          {
            timeoutMs: 3000,
          },
        )

        assertEquals(result, { reached: true })
      })
    } finally {
      Deno.env.delete(`JWK_PRI_${CALLER_APP}`)
      Deno.env.delete(`JWK_PUB_${CALLER_APP}`)
      Deno.env.delete('JWK_PRI')
      Deno.env.delete('JWK_PUB')
    }
  },
)

Deno.test(
  'HttpRemoteAdapter: dispatching an operation the target never declared surfaces REMOTE_CALL_FAILED (target-side UNKNOWN_OPERATION)',
  async () => {
    const serviceKeys = await generateRSAKeys()
    const appKeys = await generateRSAKeys()
    Deno.env.set(`JWK_PRI_${CALLER_APP}`, btoa(serviceKeys.privateKey))
    Deno.env.set(`JWK_PUB_${CALLER_APP}`, btoa(serviceKeys.publicKey))
    Deno.env.set('JWK_PRI', btoa(appKeys.privateKey))
    Deno.env.set('JWK_PUB', btoa(appKeys.publicKey))

    const targetApp = 'http-adapter-target-unknown-op'

    try {
      await withServedTarget(targetApp, 4724, async () => {
        const error = await assertRejects(
          () =>
            adapter.dispatch(CALLER_APP, targetApp, 'doesNotExist', {}, {
              timeoutMs: 3000,
            }),
          InternalError,
        )

        assertEquals((error as InternalError).code, 'REMOTE_CALL_FAILED')
      })
    } finally {
      Deno.env.delete(`JWK_PRI_${CALLER_APP}`)
      Deno.env.delete(`JWK_PUB_${CALLER_APP}`)
      Deno.env.delete('JWK_PRI')
      Deno.env.delete('JWK_PUB')
    }
  },
)

Deno.test(
  'HttpRemoteAdapter: a target with no live instance in the Control Plane throws REMOTE_APP_UNREACHABLE',
  async () => {
    const error = await assertRejects(
      () =>
        adapter.dispatch(
          CALLER_APP,
          'http-adapter-never-registered',
          'echo',
          {},
          {
            timeoutMs: 1000,
          },
        ),
      InternalError,
    )

    assertEquals((error as InternalError).code, 'REMOTE_APP_UNREACHABLE')
  },
)

Deno.test(
  'HttpRemoteAdapter: a call that exceeds timeoutMs throws REMOTE_CALL_TIMEOUT',
  async () => {
    const serviceKeys = await generateRSAKeys()
    const appKeys = await generateRSAKeys()
    Deno.env.set(`JWK_PRI_${CALLER_APP}`, btoa(serviceKeys.privateKey))
    Deno.env.set(`JWK_PUB_${CALLER_APP}`, btoa(serviceKeys.publicKey))
    Deno.env.set('JWK_PRI', btoa(appKeys.privateKey))
    Deno.env.set('JWK_PUB', btoa(appKeys.publicKey))

    const targetApp = 'http-adapter-target-slow'

    try {
      await withServedTarget(targetApp, 4721, async () => {
        const error = await assertRejects(
          () =>
            adapter.dispatch(CALLER_APP, targetApp, 'slow', {}, {
              timeoutMs: 150,
            }),
          InternalError,
        )

        assertEquals((error as InternalError).code, 'REMOTE_CALL_TIMEOUT')
      })
    } finally {
      Deno.env.delete(`JWK_PRI_${CALLER_APP}`)
      Deno.env.delete(`JWK_PUB_${CALLER_APP}`)
      Deno.env.delete('JWK_PRI')
      Deno.env.delete('JWK_PUB')
    }
  },
)

Deno.test(
  "HttpRemoteAdapter (raw HTTP, bypassing the adapter's own exchange): a validly-signed " +
    "'type: api' token with NO `sub` claim at all is denied for an ACL-scoped operation — " +
    "callerAppName resolves to undefined, `?? ''` never accidentally matches a real " +
    'allowedCallers entry — real RSA signature, real HTTP',
  async () => {
    // Regression for `remote-dispatch-route.ts`'s `dispatch()`:
    // `const callerAppName = (ctx.locals.session ?? ctx.session)?.subject as string | undefined`
    // then `isCallerAllowed(local.allowedCallers, callerAppName ?? '')`. This is genuinely
    // reachable, not defensive-only dead code: `@AuthTokenValidation({type: 'api'})` never
    // requires a `sub` claim to be present (see `@zanix/auth`'s own `verifyJWT` — `sub` is only
    // checked when an EXPECTED value is passed, which this route never does, and no
    // `x-znx-api-id`-style client-subject header/cookie is sent by a real caller either) — only
    // signature/`iss`/`exp`/`aud` are enforced. Every token minted through the intended flow
    // (`exchangeServiceCredential` → `createAppToken`) always sets `subject`, but `@AuthTokenValidation`
    // itself accepts ANY signature-valid `type: 'api'` token regardless of how it was minted — so a
    // token that's real (signed with this same process's own `JWK_PRI`, matching `JWK_PUB`) but
    // simply never carried a `sub` claim is a real, reachable shape reaching `dispatch()`, not a
    // hypothetical.
    const appKeys = await generateRSAKeys()
    Deno.env.set('JWK_PRI', btoa(appKeys.privateKey))
    Deno.env.set('JWK_PUB', btoa(appKeys.publicKey))

    const targetApp = 'http-adapter-target-no-subject'
    const port = 4725

    try {
      await withServedTarget(targetApp, port, async () => {
        // Signed directly with the SAME key `createAppToken` uses for every `type: 'api'` token
        // this process mints (`JWK_PRI`) — a real signature, deliberately built without going
        // through `exchangeServiceCredential`/`createAppToken` (both always set `sub`), so `sub`
        // is absent from the payload entirely. `rateLimit` IS set (unlike `sub`) — deliberately,
        // so this exercises ONLY the `sub`-less branch inside `dispatch()`, not
        // `jwtValidationGuard`'s OWN unrelated `rateLimitGuard` 401 (wrapped as a same-shaped 403
        // "You do not have access to this resource" by `@zanix/server`'s guard-error handling) —
        // confirmed by hand that omitting `rateLimit` here produces that DIFFERENT 403 instead,
        // one that never even reaches `dispatch()`'s body at all (a real trap: both look like a
        // passing "403" assertion, only one of them actually exercises the branch under test).
        const noSubjectToken = await createJWT({ rateLimit: 100 }, appKeys.privateKey, {
          algorithm: 'RS256',
          expiration: '5m',
        })

        const response = await fetch(
          `http://localhost:${port}/api/${OPERATIONS_PATH_SEGMENT}/${targetApp}/secretmine`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'X-Znx-Authorization': `Bearer ${noSubjectToken}`,
            },
            body: '{}',
          },
        )
        assertEquals(response.status, 403)
        const body = await response.json()
        // Proves this is `dispatch()`'s OWN `isCallerAllowed` rejection (real `callerAppName`
        // undefined, stringified as "undefined" in the message), not some other, differently-caused
        // 403 that happens to share the same status code.
        assert(
          typeof body.message === 'string' && body.message.includes('"undefined"'),
          `expected dispatch()'s own callerAppName-undefined rejection, got: ${
            JSON.stringify(body)
          }`,
        )
      })
    } finally {
      Deno.env.delete('JWK_PRI')
      Deno.env.delete('JWK_PUB')
    }
  },
)

// Keep this at the end to ensure the Redis connection (socket) closes properly.
Deno.test('close the shared Redis connection', () => {
  connector['close']()
})
