import { assert, assertEquals } from '@std/assert'
import { assertSpyCalls, stub } from '@std/testing/mock'
import { Controller, Get, WebServerManager, ZanixController } from '@zanix/server'
import { defineZanixApp } from 'modules/manifest/mod.ts'
import { registerResourceType } from 'modules/runtime/resource-types.ts'
import { bootstrapRemoteApp } from 'modules/runtime/bootstrap-remote-app.ts'

/**
 * Same technique `@zanix/core`'s own `start-shutdown-signal.test.ts` already uses: stub
 * `Deno.addSignalListener`/`removeSignalListener`/`exit`, capture the real handler
 * `bootstrapRemoteApp` registers, and invoke it directly instead of sending an actual OS signal (a
 * real signal sent to a running `deno test` process is unlikely to route through this listener
 * anyway, since `deno test`'s own CLI intercepts SIGINT for its own purposes).
 */
function stubSignals() {
  const handlers = new Map<string, () => void | Promise<void>>()
  const removed: string[] = []
  const addSignalStub = stub(
    Deno,
    'addSignalListener',
    ((signal: Deno.Signal, handler: () => void) => {
      handlers.set(signal, handler)
    }) as never,
  )
  const removeSignalStub = stub(
    Deno,
    'removeSignalListener',
    ((signal: Deno.Signal) => {
      removed.push(signal)
    }) as never,
  )
  const exitStub = stub(Deno, 'exit', (() => {}) as never)

  return {
    handlers,
    removed,
    exitStub,
    restore: () => {
      addSignalStub.restore()
      removeSignalStub.restore()
      exitStub.restore()
    },
  }
}

Deno.test(
  'bootstrapRemoteApp: with no server, activates (onStart runs) but never listens on any port ' +
    '— stop() runs onStop, closes resources, and removes the signal listeners',
  async () => {
    let onStartRan = false
    let onStopRan = false
    let closed = false

    registerResourceType('bootstrap-remote-jobs-only-fake', () => ({
      close: () => {
        closed = true
      },
    }))

    const jobsOnly = defineZanixApp({
      name: 'bootstrap-remote-jobs-only',
      dependencies: { store: { type: 'bootstrap-remote-jobs-only-fake' } },
      onStart: () => {
        onStartRan = true
      },
      onStop: () => {
        onStopRan = true
      },
    })

    const signals = stubSignals()
    try {
      const handle = await bootstrapRemoteApp(jobsOnly, {
        resources: {
          store: { type: 'bootstrap-remote-jobs-only-fake', options: {} },
        },
        uses: [{ slot: 'store', resourceName: 'store' }],
      })

      assert(onStartRan, 'onStart must run as part of bootstrapRemoteApp')
      assert(
        !closed,
        'must not be closed yet — bootstrapRemoteApp only starts things',
      )
      assert(
        signals.handlers.get('SIGINT'),
        'SIGINT listener should have been registered',
      )
      assert(
        signals.handlers.get('SIGTERM'),
        'SIGTERM listener should have been registered',
      )

      await handle.stop()

      assert(onStopRan, 'onStop must run as part of stop()')
      assert(closed, 'resources must be closed after stop()')
      assert(
        signals.removed.includes('SIGINT') &&
          signals.removed.includes('SIGTERM'),
      )
    } finally {
      signals.restore()
    }
  },
)

Deno.test(
  "bootstrapRemoteApp: with 'server', actually serves this app's own mounted routes — real " +
    'HTTP, shut down cleanly by stop()',
  async () => {
    const PORT = 4610

    const reviews = defineZanixApp({
      name: 'bootstrap-remote-reviews',
      routes: true,
      setup: (ctx) => {
        ctx.routes(() => {
          @Controller('endpoint')
          class BootstrapRemoteController extends ZanixController {
            @Get('ping')
            public ping() {
              return 'bootstrap-remote-reviews'
            }
          }
          void BootstrapRemoteController
        })
      },
    })

    const signals = stubSignals()
    const handle = await bootstrapRemoteApp(reviews, {
      server: { rest: { port: PORT } },
    })

    try {
      await new Promise((resolve) => setTimeout(resolve, 500))

      const res = await fetch(
        `http://localhost:${PORT}/api/bootstrap-remote-reviews/endpoint/ping`,
      )
      assertEquals(res.status, 200)
      await res.body?.cancel()
    } finally {
      await handle.stop()
      signals.restore()
    }
  },
)

Deno.test(
  'bootstrapRemoteApp: a SIGTERM triggers a clean shutdown and exits with code 0',
  async () => {
    const consoleInfo = stub(console, 'info')
    const signals = stubSignals()

    try {
      const def = defineZanixApp({ name: 'bootstrap-remote-sigterm' })
      await bootstrapRemoteApp(def)

      const sigterm = signals.handlers.get('SIGTERM')
      assert(sigterm, 'SIGTERM listener should have been registered')

      await sigterm()

      assert(
        signals.removed.includes('SIGINT') &&
          signals.removed.includes('SIGTERM'),
      )
      assertSpyCalls(signals.exitStub, 1)
      assertEquals(signals.exitStub.calls[0].args[0], 0)
    } finally {
      signals.restore()
      consoleInfo.restore()
    }
  },
)

Deno.test(
  'bootstrapRemoteApp: stop() called twice in a row does not throw removing an already-removed ' +
    'listener',
  async () => {
    const signals = stubSignals()

    try {
      const def = defineZanixApp({ name: 'bootstrap-remote-double-stop' })
      const handle = await bootstrapRemoteApp(def)

      await handle.stop()
      await handle.stop() // must not throw

      assertEquals(signals.removed.filter((s) => s === 'SIGTERM').length, 1)
    } finally {
      signals.restore()
    }
  },
)

Deno.test(
  'bootstrapRemoteApp: a shutdown that fails during a signal-triggered stop still exits, with ' +
    'code 1',
  async () => {
    const consoleInfo = stub(console, 'info')
    const consoleError = stub(console, 'error')
    const signals = stubSignals()

    const def = defineZanixApp({ name: 'bootstrap-remote-shutdown-fails' })
    await bootstrapRemoteApp(def)

    // `webServerManager` itself is `Object.freeze`d (a module-level singleton) — `stop` isn't one
    // of its own properties, it lives on the class prototype, which isn't frozen, so it's stubbed
    // there instead. Same technique `@zanix/core`'s own shutdown test already uses.
    const stopStub = stub(
      WebServerManager.prototype,
      'stop',
      () => Promise.reject(new Error('boom')),
    )

    try {
      const sigterm = signals.handlers.get('SIGTERM')
      assert(sigterm)
      await sigterm()

      assertSpyCalls(signals.exitStub, 1)
      assertEquals(signals.exitStub.calls[0].args[0], 1)
    } finally {
      stopStub.restore()
      signals.restore()
      consoleInfo.restore()
      consoleError.restore()
    }
  },
)
