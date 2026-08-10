import { assert, assertEquals } from '@std/assert'
import { stub } from '@std/testing/mock'
import { bootstrapAppServer, webServerManager } from '../../../../runtime.ts'
import { Controller, Get, ProgramModule, ZanixController } from '@zanix/server'

stub(console, 'info')

/**
 * Regression for a real bug: `bootstrapAppServer` used to rebuild its own `namedServers` object by
 * looping `Object.entries(server)` and treating EVERY entry as a per-type server config — `health`
 * (a sibling field, not a `WebServerTypes` entry) got silently mangled into
 * `{ ...false, application: appName }` (an unrelated object) instead of reaching
 * `bootstrapServers()` as the real `boolean | HealthOptions` value. Every Zanix App server (a named
 * `apps` entry in `@zanix/core`, `@zanix/core`'s own embedded `admin`, `@zanix/admin`'s
 * `ZanixAdminHub`) routes through this exact function, so `health: false` had zero effect anywhere
 * in that path — confirmed against a real consumer app.
 */
Deno.test(
  'bootstrapAppServer: health: false actually disables /health for this app, real route unaffected',
  async () => {
    await ProgramModule.defineApplication('bootstrap-app-server-health', () => {
      @Controller()
      class _Probe extends ZanixController {
        @Get('/ping')
        public ping() {
          return 'pong'
        }
      }
    })

    const servers = await bootstrapAppServer('bootstrap-app-server-health', {
      rest: { port: 4501 },
      health: false,
    }, true)

    try {
      assertEquals(servers.length, 1)
      const addr = webServerManager.info(servers[0]).addr
      assert(addr, 'the REST server should be listening')
      const base = `http://${addr.hostname}:${addr.port}`

      const health = await fetch(`${base}/health`)
      assertEquals(health.status, 404)
      await health.body?.cancel()

      const ping = await fetch(`${base}/api/ping`)
      assertEquals(ping.status, 200)
      assertEquals(await ping.text(), 'pong')
    } finally {
      await webServerManager.stop(servers)
    }
  },
)
