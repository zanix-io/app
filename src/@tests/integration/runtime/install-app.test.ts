import { assert, assertEquals, assertRejects } from '@std/assert'
import { InternalError } from '@zanix/errors'
import { ZanixRedisConnector } from '@zanix/datamaster'
import { activateApps, deactivateApps } from 'modules/runtime/activate-apps.ts'
import { installApp } from 'modules/runtime/install-app.ts'
import { ControlPlaneRegistry } from 'modules/runtime/control-plane/registry.ts'
import { HttpRemoteAdapter } from 'modules/runtime/http-remote-adapter.ts'

console.error = () => {}

// Real Redis connector — no mocking, same pattern as the rest of this suite's integration tests.
const connector = new ZanixRedisConnector()
const registry = new ControlPlaneRegistry(connector)
const dispatcher = new HttpRemoteAdapter(registry)

Deno.test(
  "installApp: options.remoteInstance announces the newly hot-installed app via the batch's own " +
    'HttpRemoteAdapter — resolves to the SAME ControlPlaneRegistry the dispatcher already uses',
  async () => {
    const appName = `install-app-remote-${crypto.randomUUID()}`
    const activated = await activateApps(
      [{ name: 'install-app-remote-existing' }],
      {},
      [],
      dispatcher,
    )

    try {
      const next = await installApp(activated, { name: appName }, {
        remoteInstance: { endpoint: 'http://localhost:9300' },
      })

      assertEquals(next.announced.length, 1)
      assertEquals(next.announced[0].appName, appName)
      assertEquals(await registry.getDeploymentTarget(appName), {
        mode: 'remote',
        prefix: appName,
        endpoints: ['http://localhost:9300'],
      })

      await next.announced[0].stop()
    } finally {
      await deactivateApps(activated)
    }
  },
)

Deno.test(
  'installApp: options.remoteInstance with no HttpRemoteAdapter dispatcher and no controlPlane ' +
    'provider throws CONTROL_PLANE_NOT_CONFIGURED — the app is never resolved/registered',
  async () => {
    const appName = `install-app-remote-unconfigured-${crypto.randomUUID()}`
    const activated = await activateApps([
      { name: 'install-app-remote-unconfigured-existing' },
    ])

    try {
      const error = await assertRejects(
        () =>
          installApp(activated, { name: appName }, {
            remoteInstance: { endpoint: 'http://localhost:9301' },
          }),
        InternalError,
      )

      assertEquals((error as InternalError).code, 'CONTROL_PLANE_NOT_CONFIGURED')
      assert(
        !activated.apps.some((app) => app.name === appName),
        'the app must never end up registered when announcing it fails',
      )
    } finally {
      await deactivateApps(activated)
    }
  },
)

// Keep this at the end to ensure the Redis connection (socket) closes properly.
Deno.test('close the shared Redis connection', () => {
  connector['close']()
  dispatcher.close()
})
