import { assertEquals } from '@std/assert'
import { stub } from '@std/testing/mock'
import { Controller, Get, ZanixController } from '@zanix/server'
import { defineZanixApp } from 'modules/manifest/mod.ts'
import { bootstrapRemoteApp } from 'modules/runtime/bootstrap-remote-app.ts'

/**
 * Moved out of `unit/runtime/bootstrap-remote-app.test.ts`: this test opens a real port and
 * performs a real `fetch()` against `localhost`, which makes it a functional (end-to-end from the
 * caller's perspective) test rather than a unit one — same real-HTTP pattern as
 * `bootstrap-app-server-health.test.ts` and `define-app-serve.test.ts` in this same directory.
 *
 * Same technique `@zanix/core`'s own `start-shutdown-signal.test.ts` already uses: stub
 * `Deno.addSignalListener`/`removeSignalListener`/`exit` so registering real signal handlers
 * during `bootstrapRemoteApp` doesn't leak listeners across the real OS process running this test.
 */
function stubSignals() {
  const addSignalStub = stub(Deno, 'addSignalListener', (() => {}) as never)
  const removeSignalStub = stub(
    Deno,
    'removeSignalListener',
    (() => {}) as never,
  )
  const exitStub = stub(Deno, 'exit', (() => {}) as never)

  return {
    restore: () => {
      addSignalStub.restore()
      removeSignalStub.restore()
      exitStub.restore()
    },
  }
}

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
