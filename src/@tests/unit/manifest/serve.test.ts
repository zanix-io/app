import { assert, assertEquals } from '@std/assert'
import { defineZanixApp } from 'modules/manifest/mod.ts'
import { registerResourceType } from 'modules/runtime/resource-types.ts'
import { Controller, Get, ZanixController } from '@zanix/server'

Deno.test(
  'ZanixAppDefinition.serve(): with no server, registers (onStart runs) but never listens on ' +
    'any port — stop() still runs onStop and closes resources',
  async () => {
    let onStartRan = false
    let onStopRan = false
    let closed = false

    registerResourceType('serve-jobs-only-fake', () => ({
      close: () => {
        closed = true
      },
    }))

    const jobsOnly = defineZanixApp({
      name: 'serve-jobs-only',
      dependencies: { store: { type: 'serve-jobs-only-fake' } },
      onStart: () => {
        onStartRan = true
      },
      onStop: () => {
        onStopRan = true
      },
    })

    const handle = await jobsOnly.serve({
      resources: { store: { type: 'serve-jobs-only-fake', options: {} } },
      uses: [{ slot: 'store', resourceName: 'store' }],
    })

    assert(onStartRan, 'onStart must run as part of serve()')
    assert(!closed, 'must not be closed yet — serve() only starts things')

    await handle.stop()

    assert(onStopRan, 'onStop must run as part of stop()')
    assert(closed, 'resources must be closed after stop()')
  },
)

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
