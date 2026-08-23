import { assertEquals } from '@std/assert'
import { defineZanixApp } from 'modules/manifest/mod.ts'
import { Controller, Get, ZanixController } from '@zanix/server'

/**
 * Moved out of `unit/manifest/define.test.ts`: this test opens a real port and performs a real
 * `fetch()` against `localhost`, which makes it a functional (end-to-end from the caller's
 * perspective) test rather than a unit one — same real-HTTP pattern as
 * `bootstrap-app-server-health.test.ts` in this same directory.
 */
Deno.test(
  "ZanixAppDefinition.serve(): with 'server', actually serves this app's own mounted routes " +
    '— real HTTP, shut down cleanly by stop()',
  async () => {
    const PORT = 4605

    const reviews = defineZanixApp({
      name: 'serve-reviews',
      routes: true,
      setup: (ctx) => {
        ctx.routes(() => {
          @Controller('endpoint')
          class ServeOnlyController extends ZanixController {
            @Get('ping')
            public ping() {
              return 'serve-reviews'
            }
          }
          void ServeOnlyController
        })
      },
    })

    const handle = await reviews.serve({ server: { rest: { port: PORT } } })

    try {
      await new Promise((resolve) => setTimeout(resolve, 500))

      const res = await fetch(
        `http://localhost:${PORT}/api/serve-reviews/endpoint/ping`,
      )
      assertEquals(res.status, 200)
      await res.body?.cancel()
    } finally {
      await handle.stop()
    }
  },
)
