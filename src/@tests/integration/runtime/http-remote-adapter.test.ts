import { assertEquals, assertRejects } from '@std/assert'
import { generateRSAKeys } from '@zanix/helpers'
import { InternalError } from '@zanix/errors'
import { ZanixRedisConnector } from '@zanix/datamaster'
import { defineZanixApp } from 'modules/manifest/mod.ts'
import { ControlPlaneRegistry } from 'modules/runtime/control-plane/mod.ts'
import { HttpRemoteAdapter } from 'modules/runtime/http-remote-adapter.ts'

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

// Keep this at the end to ensure the Redis connection (socket) closes properly.
Deno.test('close the shared Redis connection', () => {
  connector['close']()
})
