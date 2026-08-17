import { assertEquals } from '@std/assert'
import type { HttpRemoteDispatcher } from 'modules/runtime/remote-caller.ts'
import { activateApps, deactivateApps } from 'modules/runtime/activate-apps.ts'
import { installApp } from 'modules/runtime/install-app.ts'
import { ProgramModule } from '@zanix/server'
import type { ZanixControlPlaneProvider } from 'modules/runtime/control-plane/mod.ts'

console.error = () => {}

// Same real-infra bootstrapping `control-plane/provider.test.ts` already establishes: `REDIS_URI`
// must be set BEFORE `@zanix/datamaster/core` evaluates, and importing `@zanix/app/core` is what
// registers the `'controlPlane'` provider slot `installApp` itself falls back to
// (`resolveControlPlaneProvider()`) whenever the batch's own `dispatcher` isn't an
// `HttpRemoteAdapter`. Kept in its OWN file — `install-app.test.ts`'s own
// `CONTROL_PLANE_NOT_CONFIGURED` case specifically needs this provider slot to stay unregistered,
// and importing `@zanix/app/core` anywhere in a file registers it for that whole file (per-file
// isolation keeps the two from interfering with each other).
Deno.env.set('REDIS_URI', 'redis://localhost:6379')
await import('@zanix/datamaster/core')
await import('@zanix/app/core')

/** A `HttpRemoteDispatcher` that is deliberately NOT an `HttpRemoteAdapter` instance — forces
 * `installApp`'s own `activated.dispatcher instanceof HttpRemoteAdapter` check to its `false`
 * branch, so `options.remoteInstance` resolves its registry via the `'controlPlane'` core
 * provider instead (the one path `install-app.test.ts`'s own `HttpRemoteAdapter`-dispatcher case
 * never exercises). */
const nonAdapterDispatcher: HttpRemoteDispatcher = {
  dispatch: () => Promise.reject(new Error('never actually called by this test')),
}

Deno.test(
  "installApp: options.remoteInstance with a dispatcher that ISN'T an HttpRemoteAdapter falls " +
    "back to the 'controlPlane' provider's own ControlPlaneRegistry/ControlPlaneConfig",
  async () => {
    const provider = ProgramModule.getProviders().get<ZanixControlPlaneProvider>(
      'controlPlane',
    )

    const appName = `install-app-provider-fallback-${crypto.randomUUID()}`
    const activated = await activateApps(
      [{ name: 'install-app-provider-fallback-existing' }],
      {},
      [],
      nonAdapterDispatcher,
    )

    try {
      const next = await installApp(activated, { name: appName }, {
        remoteInstance: { endpoint: 'http://localhost:9302' },
      })

      assertEquals(next.announced[0].appName, appName)
      assertEquals(await provider?.controlPlaneRegistry.getDeploymentTarget(appName), {
        mode: 'remote',
        prefix: appName,
        endpoints: ['http://localhost:9302'],
      })

      await next.announced[0].stop()
    } finally {
      await deactivateApps(activated)
    }
  },
)
