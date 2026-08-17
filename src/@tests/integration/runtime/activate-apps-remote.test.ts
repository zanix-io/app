import { assert, assertEquals, assertRejects, assertStrictEquals } from '@std/assert'
import { InternalError } from '@zanix/errors'
import { ZanixRedisConnector } from '@zanix/datamaster'
import { defineZanixApp } from 'modules/manifest/mod.ts'
import { activateApps, deactivateApps } from 'modules/runtime/activate-apps.ts'
import { ControlPlaneRegistry } from 'modules/runtime/control-plane/registry.ts'
import { HttpRemoteAdapter } from 'modules/runtime/http-remote-adapter.ts'

console.info = () => {}
console.error = () => {}
console.warn = () => {}

// Real Redis connector — no mocking.
const connector = new ZanixRedisConnector()
const registry = new ControlPlaneRegistry(connector)
const dispatcher = new HttpRemoteAdapter(registry)

Deno.test(
  'activateApps: remoteInstances announces AFTER onStart; deactivateApps deregisters BEFORE onStop',
  async () => {
    const appName = `activate-remote-${crypto.randomUUID()}`
    let registeredDuringOnStart = false
    let stillRegisteredAtOnStop = true

    const def = defineZanixApp({
      name: appName,
      onStart: async () => {
        registeredDuringOnStart = Boolean(
          await registry.getDeploymentTarget(appName),
        )
      },
      onStop: async () => {
        stillRegisteredAtOnStop = Boolean(
          await registry.getDeploymentTarget(appName),
        )
      },
    })

    const activated = await activateApps([def], {}, [], dispatcher, {
      [appName]: { endpoint: 'http://localhost:9100' },
    })

    assertStrictEquals(
      registeredDuringOnStart,
      false,
      'the announce step runs AFTER onStart, not during it — onStart must never see itself as live',
    )
    assert(
      await registry.getDeploymentTarget(appName),
      'must be registered by the time activateApps resolves',
    )
    assertEquals(activated.announced.length, 1)
    assertEquals(activated.announced[0].appName, appName)

    await deactivateApps(activated)

    assertStrictEquals(
      stillRegisteredAtOnStop,
      false,
      'must already be deregistered by the time onStop runs (Gateway stops routing first)',
    )
    assertStrictEquals(await registry.getDeploymentTarget(appName), undefined)
  },
)

Deno.test(
  'activateApps: remoteInstances naming an app not in defs throws UNKNOWN_REMOTE_INSTANCE_APP',
  async () => {
    const def = defineZanixApp({
      name: `activate-remote-real-${crypto.randomUUID()}`,
    })

    const error = await assertRejects(
      () =>
        activateApps([def], {}, [], dispatcher, {
          'activate-remote-never-declared': {
            endpoint: 'http://localhost:9101',
          },
        }),
      InternalError,
    )

    assertEquals((error as InternalError).code, 'UNKNOWN_REMOTE_INSTANCE_APP')
  },
)

Deno.test(
  'activateApps: remoteInstances with no dispatcher and no controlPlane provider throws CONTROL_PLANE_NOT_CONFIGURED',
  async () => {
    const appName = `activate-remote-unconfigured-${crypto.randomUUID()}`
    const def = defineZanixApp({ name: appName })

    const error = await assertRejects(
      () =>
        activateApps([def], {}, [], undefined, {
          [appName]: { endpoint: 'http://localhost:9102' },
        }),
      InternalError,
    )

    assertEquals((error as InternalError).code, 'CONTROL_PLANE_NOT_CONFIGURED')
  },
)

Deno.test('activateApps: no remoteInstances given never touches the Control Plane', async () => {
  const def = defineZanixApp({
    name: `activate-remote-none-${crypto.randomUUID()}`,
  })

  const activated = await activateApps([def])

  assertEquals(activated.announced, [])

  await deactivateApps(activated)
})

// Keep this at the end to ensure the Redis connection (socket) closes properly.
Deno.test('close the shared Redis connection', () => {
  connector['close']()
})
