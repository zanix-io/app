import { assert, assertEquals } from '@std/assert'
import { stub } from '@std/testing/mock'
import type { Logger } from '@zanix/logger'
import { normalize } from 'modules/manifest/normalize.ts'
import type { ControlPlaneRegistry } from 'modules/runtime/control-plane/mod.ts'
import { announceRemoteInstance } from 'modules/runtime/remote-lifecycle.ts'

// `announceRemoteInstance` only ever calls `registry.registerInstance`/`.deregisterInstance` —
// a plain object satisfying that shape stands in for a real `ControlPlaneRegistry` here, cheaper
// and more deterministic than real Redis + external error injection for exercising the two
// log-and-swallow failure paths below (a real Control Plane blip must never crash the process).
//
// The `@zanix/logger` default export is a Proxy that always dispatches to whatever instance is
// CURRENTLY assigned to the global `logger` (`self.logger`/`globalThis.logger`) at call time —
// this process can end up with more than one `Logger` instance/class if a locally-path-resolved
// dependency (e.g. `@zanix/auth`) pins a different `@zanix/utils` version than this package's own
// `deno.jsonc`. Reassigning the imported `logger.error` binding directly only patches the class
// THIS file resolved, which silently does nothing if `globalThis.logger` is a different instance
// by the time `remote-lifecycle.ts` calls it. Stubbing `globalThis.logger.error` instead targets
// whichever instance is actually live, regardless of how many `Logger` classes exist in-process.

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function currentGlobalLogger(): Logger {
  return (globalThis as unknown as { logger: Logger }).logger
}

Deno.test(
  'announceRemoteInstance: a heartbeat renewal failure is logged and swallowed — never an unhandled rejection',
  async () => {
    let registerCalls = 0
    const fakeRegistry = {
      registerInstance: () => {
        registerCalls++
        return registerCalls === 1 ? Promise.resolve() : Promise.reject(new Error('renewal boom'))
      },
      deregisterInstance: () => Promise.resolve(),
    } as unknown as ControlPlaneRegistry

    const loggedErrors: unknown[] = []
    const errorStub = stub(
      currentGlobalLogger(),
      'error',
      ((message: string, error: unknown) => {
        loggedErrors.push({ message, error })
      }) as Logger['error'],
    )

    const def = normalize({ name: 'remote-lifecycle-heartbeat-fail-app' })

    try {
      const announced = await announceRemoteInstance(
        def,
        { endpoint: 'http://localhost:9200', heartbeatIntervalMs: 10 },
        fakeRegistry,
      )

      try {
        await wait(50) // several heartbeat ticks — every renewal after the first rejects

        assert(registerCalls >= 2, 'the heartbeat must keep renewing on its own interval')
        assert(
          loggedErrors.some((entry) =>
            (entry as { message: string }).message.includes('failed to renew')
          ),
          'a rejecting renewal must be logged, not thrown/unhandled',
        )
      } finally {
        await announced.stop()
      }
    } finally {
      errorStub.restore()
    }
  },
)

Deno.test(
  'announceRemoteInstance: stop() logs and swallows a deregistration failure — its own promise still resolves',
  async () => {
    const fakeRegistry = {
      registerInstance: () => Promise.resolve(),
      deregisterInstance: () => Promise.reject(new Error('deregister boom')),
    } as unknown as ControlPlaneRegistry

    const loggedErrors: unknown[] = []
    const errorStub = stub(
      currentGlobalLogger(),
      'error',
      ((message: string, error: unknown) => {
        loggedErrors.push({ message, error })
      }) as Logger['error'],
    )

    const def = normalize({ name: 'remote-lifecycle-deregister-fail-app' })

    try {
      const announced = await announceRemoteInstance(
        def,
        { endpoint: 'http://localhost:9201', heartbeatIntervalMs: 10_000 },
        fakeRegistry,
      )

      await announced.stop() // must resolve cleanly despite the rejecting deregisterInstance below

      assertEquals(loggedErrors.length, 1)
      assert(
        (loggedErrors[0] as { message: string }).message.includes(
          'failed to deregister cleanly',
        ),
      )
    } finally {
      errorStub.restore()
    }
  },
)
