import { assert, assertEquals, assertRejects } from '@std/assert'
import { InternalError } from '@zanix/errors'
import { activateApps } from 'modules/runtime/activate-apps.ts'
import { installApp } from 'modules/runtime/install-app.ts'
import { registerResourceType } from 'modules/runtime/resource-types.ts'
import { defineZanixApp } from 'modules/manifest/mod.ts'
import type { RootResources } from 'typings/manifest.ts'

console.error = () => {}

Deno.test(
  'installApp: accepts a defineZanixApp()-wrapped ZanixAppDefinition, using its already-' +
    'normalized definition as-is (never re-normalizing it)',
  async () => {
    const activated = await activateApps([
      { name: 'install-app-zanix-def-existing' },
    ])

    const wrapped = defineZanixApp({ name: 'install-app-zanix-def-new' })
    const next = await installApp(activated, wrapped)

    assertEquals(next.apps[1], wrapped.definition)
  },
)

Deno.test(
  'installApp: adds a new app to an already-activated batch — its onStart runs, the app ' +
    'appears in the returned ActivatedApps, and every already-active app is left untouched',
  async () => {
    const started: string[] = []
    const activated = await activateApps([
      {
        name: 'install-app-existing',
        onStart: () => {
          started.push('existing')
        },
      },
    ])

    const next = await installApp(activated, {
      name: 'install-app-new',
      onStart: () => {
        started.push('new')
      },
    })

    assertEquals(started, ['existing', 'new'])
    assertEquals(next.apps.map((app) => app.name), [
      'install-app-existing',
      'install-app-new',
    ])
    // The already-active app's own entry is the SAME object — installApp never re-normalizes or
    // re-registers anything about it.
    assertEquals(next.apps[0], activated.apps[0])
  },
)

Deno.test(
  "installApp: a new app sharing an already-active app's root resource reuses the SAME " +
    'instance — the factory is never invoked a second time',
  async () => {
    let calls = 0
    registerResourceType('install-app-shared-db', (options) => {
      calls++
      return { close: () => {}, options }
    })

    const rootResources: RootResources = {
      sharedDb: { type: 'install-app-shared-db', options: {} },
    }
    const activated = await activateApps(
      [{
        name: 'install-app-shared-first',
        dependencies: { database: { type: 'install-app-shared-db' } },
      }],
      rootResources,
      [{
        appName: 'install-app-shared-first',
        slot: 'database',
        resourceName: 'sharedDb',
      }],
    )
    assertEquals(calls, 1)

    const next = await installApp(
      activated,
      {
        name: 'install-app-shared-second',
        dependencies: { database: { type: 'install-app-shared-db' } },
      },
      {
        bindings: [{
          appName: 'install-app-shared-second',
          slot: 'database',
          resourceName: 'sharedDb',
        }],
      },
    )

    assertEquals(
      calls,
      1,
      'installing a second app sharing the SAME root resource must not reconstruct it',
    )
    assert(
      next.resources.get('install-app-shared-first:database') ===
        next.resources.get('install-app-shared-second:database'),
      'both apps must resolve to the exact same instance',
    )
  },
)

Deno.test(
  'installApp: validate() failure (new app violates its own contract) throws BEFORE registering ' +
    'anything, and the existing batch is never touched',
  async () => {
    let onStartCalls = 0
    const activated = await activateApps([
      {
        name: 'install-app-safe-existing',
        onStart: () => {
          onStartCalls++
        },
      },
    ])

    await assertRejects(
      () =>
        installApp(activated, {
          name: 'install-app-invalid-new',
          dependencies: {
            database: { type: 'install-app-nonexistent-db', required: true },
          },
        }),
      InternalError,
    )

    assertEquals(
      onStartCalls,
      1,
      "the new app's onStart must never run when validate() rejects it",
    )
  },
)

Deno.test(
  "installApp: throws APP_ALREADY_INSTALLED when the new app's name collides with an active one",
  async () => {
    const activated = await activateApps([{ name: 'install-app-duplicate' }])

    const error = await assertRejects(
      () => installApp(activated, { name: 'install-app-duplicate' }),
      InternalError,
    )
    assertEquals((error as InternalError).code, 'APP_ALREADY_INSTALLED')
    // Caller-expected control-flow (the caller already gets to catch this) — must NOT auto-log.
    assertEquals((error as unknown as { _logged: boolean })._logged, false)
  },
)

Deno.test(
  'installApp: options.maxResources caps how many distinct resources the new (tenant-scoped) ' +
    'app may hold — a 3rd local resource beyond a quota of 2 rejects with RESOURCE_QUOTA_EXCEEDED',
  async () => {
    registerResourceType('install-app-quota-db', () => ({ close: () => {} }))
    const activated = await activateApps([{
      name: 'install-app-quota-existing',
    }])

    const error = await assertRejects(
      () =>
        installApp(
          activated,
          {
            name: 'install-app-quota-tenant',
            dependencies: {
              db1: { type: 'install-app-quota-db' },
              db2: { type: 'install-app-quota-db' },
              db3: { type: 'install-app-quota-db' },
            },
            resources: {
              db1: { type: 'install-app-quota-db', options: {} },
              db2: { type: 'install-app-quota-db', options: {} },
              db3: { type: 'install-app-quota-db', options: {} },
            },
          },
          { maxResources: 2 },
        ),
      InternalError,
    )
    assertEquals((error as InternalError).code, 'RESOURCE_QUOTA_EXCEEDED')
    // Caller-expected control-flow (a host rejecting an over-quota tenant install) — must NOT
    // auto-log.
    assertEquals((error as unknown as { _logged: boolean })._logged, false)
  },
)
