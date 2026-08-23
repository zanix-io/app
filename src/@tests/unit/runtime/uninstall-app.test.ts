import { assert, assertEquals, assertRejects } from '@std/assert'
import { InternalError } from '@zanix/errors'
import { activateApps } from 'modules/runtime/activate-apps.ts'
import { installApp } from 'modules/runtime/install-app.ts'
import { uninstallApp } from 'modules/runtime/uninstall-app.ts'
import { registerResourceType } from 'modules/runtime/resource-types.ts'
import type { AnnouncedRemoteInstance } from 'modules/runtime/remote-lifecycle.ts'
import type { RootResources } from 'typings/manifest.ts'

console.error = () => {}

Deno.test(
  'uninstallApp: removes the app — its onStop runs, and it disappears from the returned ' +
    'ActivatedApps',
  async () => {
    const events: string[] = []
    const activated = await activateApps([
      {
        name: 'uninstall-app-keep',
        onStart: () => {
          events.push('keep-start')
        },
      },
      {
        name: 'uninstall-app-remove',
        onStart: () => {
          events.push('remove-start')
        },
        onStop: () => {
          events.push('remove-stop')
        },
      },
    ])

    const next = await uninstallApp(activated, 'uninstall-app-remove')

    assertEquals(events, ['keep-start', 'remove-start', 'remove-stop'])
    assertEquals(next.apps.map((app) => app.name), ['uninstall-app-keep'])
  },
)

Deno.test(
  'uninstallApp: a resource shared with a still-active app stays open; releasing the LAST ' +
    'referencing app actually closes it',
  async () => {
    let closed = false
    registerResourceType('uninstall-app-shared-db', () => ({
      close: () => {
        closed = true
      },
    }))

    const rootResources: RootResources = {
      sharedDb: { type: 'uninstall-app-shared-db', options: {} },
    }
    const activated = await activateApps(
      [
        {
          name: 'uninstall-app-shared-a',
          dependencies: { database: { type: 'uninstall-app-shared-db' } },
        },
        {
          name: 'uninstall-app-shared-b',
          dependencies: { database: { type: 'uninstall-app-shared-db' } },
        },
      ],
      rootResources,
      [
        {
          appName: 'uninstall-app-shared-a',
          slot: 'database',
          resourceName: 'sharedDb',
        },
        {
          appName: 'uninstall-app-shared-b',
          slot: 'database',
          resourceName: 'sharedDb',
        },
      ],
    )

    const afterFirst = await uninstallApp(activated, 'uninstall-app-shared-a')
    assert(
      !closed,
      'the shared resource must stay open while uninstall-app-shared-b still uses it',
    )
    assertEquals(
      afterFirst.resources.has('uninstall-app-shared-a:database'),
      false,
    )
    assert(afterFirst.resources.has('uninstall-app-shared-b:database'))

    await uninstallApp(afterFirst, 'uninstall-app-shared-b')
    assert(
      closed,
      'the resource must close once its last referencing app is uninstalled',
    )
  },
)

Deno.test(
  'uninstallApp: blocked (APP_STILL_REQUIRED) when another active app has a REQUIRED ' +
    "mode: 'remote' dependency resolving to the target app — nothing is torn down",
  async () => {
    let onStopCalls = 0
    const activated = await activateApps(
      [
        {
          name: 'uninstall-app-target',
          onStop: () => {
            onStopCalls++
          },
        },
        {
          name: 'uninstall-app-dependent',
          dependencies: {
            billing: { type: 'billing-service', required: true },
          },
        },
      ],
      {
        billingRemote: {
          type: 'billing-service',
          mode: 'remote',
          endpoint: 'uninstall-app-target',
        },
      },
      [{
        appName: 'uninstall-app-dependent',
        slot: 'billing',
        resourceName: 'billingRemote',
      }],
    )

    const error = await assertRejects(
      () => uninstallApp(activated, 'uninstall-app-target'),
      InternalError,
    )
    assertEquals((error as InternalError).code, 'APP_STILL_REQUIRED')
    assertEquals(onStopCalls, 0, "the blocked app's onStop must never run")
    // Caller-expected control-flow (a conflict guard on the caller's own requested action) — must
    // NOT auto-log.
    assertEquals((error as unknown as { _logged: boolean })._logged, false)
  },
)

Deno.test(
  "uninstallApp: stops ONLY the target app's own announced Control Plane instance — a " +
    "different app's announcement survives untouched in the returned ActivatedApps",
  async () => {
    // Pre-existing gap, unrelated to this PR's own diff: real coverage data showed
    // `activated.announced`'s own loop (`for (const instance of activated.announced)`) had NEVER
    // run its body in any existing test — every prior `uninstallApp` test left `announced` empty.
    // Builds `AnnouncedRemoteInstance` fixtures directly (see `remote-lifecycle.test.ts`'s own
    // precedent for stubbing this exact shape) rather than going through `activateApps`'s
    // `remoteInstances` option, which would require a real `ControlPlaneRegistry`/Redis for a
    // unit-tier test.
    const activated = await activateApps([
      { name: 'uninstall-app-announced-target' },
      { name: 'uninstall-app-announced-other' },
    ])

    let targetStopped = false
    let otherStopped = false
    const announced: AnnouncedRemoteInstance[] = [
      {
        appName: 'uninstall-app-announced-target',
        instanceId: 'inst-target',
        stop: () => {
          targetStopped = true
          return Promise.resolve()
        },
      },
      {
        appName: 'uninstall-app-announced-other',
        instanceId: 'inst-other',
        stop: () => {
          otherStopped = true
          return Promise.resolve()
        },
      },
    ]

    const next = await uninstallApp(
      { ...activated, announced },
      'uninstall-app-announced-target',
    )

    assert(targetStopped, "the target app's own announced instance must be stopped")
    assert(!otherStopped, "a different app's announced instance must never be touched")
    assertEquals(next.announced.map((instance) => instance.appName), [
      'uninstall-app-announced-other',
    ])
  },
)

Deno.test(
  'uninstallApp: an app with its own mode: "remote" dependency is uninstalled cleanly — ' +
    'registry.release() is never called for it (nothing was ever registered in the ' +
    'ResourceRegistry for a remote-mode resource)',
  async () => {
    // Pre-existing gap, unrelated to this PR's own diff: real coverage data showed the
    // `if (resolvedKey.mode === 'remote') continue` guard inside the post-onStop release loop had
    // never actually skipped anything in any existing test — every prior test's target app had
    // only LOCAL resolved dependencies.
    const activated = await activateApps(
      [{
        name: 'uninstall-app-remote-dep',
        dependencies: { billing: { type: 'billing-service' } },
      }],
      {
        billingRemote: {
          type: 'billing-service',
          mode: 'remote',
          endpoint: 'uninstall-app-remote-dep-target',
        },
      },
      [{
        appName: 'uninstall-app-remote-dep',
        slot: 'billing',
        resourceName: 'billingRemote',
      }],
    )

    const releasedKeys: string[] = []
    const originalRelease = activated.registry.release.bind(activated.registry)
    activated.registry.release = ((qualifiedKey: string, ownerApp: string) => {
      releasedKeys.push(qualifiedKey)
      return originalRelease(qualifiedKey, ownerApp)
    }) as typeof activated.registry.release

    const next = await uninstallApp(activated, 'uninstall-app-remote-dep')

    assertEquals(next.apps.length, 0)
    assertEquals(
      releasedKeys,
      [],
      'a mode: "remote" dependency was never registered in the ResourceRegistry — release() ' +
        'must never be called for it',
    )
  },
)

Deno.test('uninstallApp: throws APP_NOT_INSTALLED for an app that is not active', async () => {
  const activated = await activateApps([{ name: 'uninstall-app-only' }])

  const error = await assertRejects(
    () => uninstallApp(activated, 'uninstall-app-never-existed'),
    InternalError,
  )
  assertEquals((error as InternalError).code, 'APP_NOT_INSTALLED')
  // Caller-expected control-flow (the caller already gets to catch this) — must NOT auto-log.
  assertEquals((error as unknown as { _logged: boolean })._logged, false)
})

Deno.test(
  'installApp + uninstallApp round trip: a hot-installed app can be hot-uninstalled again ' +
    'cleanly, leaving the original batch exactly as it was',
  async () => {
    const activated = await activateApps([{ name: 'round-trip-original' }])

    const withNew = await installApp(activated, { name: 'round-trip-new' })
    assertEquals(withNew.apps.map((app) => app.name), [
      'round-trip-original',
      'round-trip-new',
    ])

    const back = await uninstallApp(withNew, 'round-trip-new')
    assertEquals(back.apps.map((app) => app.name), ['round-trip-original'])
  },
)
