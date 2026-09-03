import { assert, assertEquals } from '@std/assert'
import { activateApps, deactivateApps } from 'modules/runtime/activate-apps.ts'
import { installApp } from 'modules/runtime/install-app.ts'
import { uninstallApp } from 'modules/runtime/uninstall-app.ts'
import { resolveResource } from 'modules/runtime/resource-instance-registry.ts'
import { registerResourceType } from 'modules/runtime/resource-types.ts'
import type { RootResources } from 'typings/manifest.ts'

console.error = () => {}

Deno.test(
  'resolveResource(appName, slot): finds an already-resolved resource instance, standalone (no ctx)',
  async () => {
    registerResourceType('resolve-resource-fake-db', () => ({ close: () => {} }))
    const rootResources: RootResources = {
      db: { type: 'resolve-resource-fake-db', options: {} },
    }
    const activated = await activateApps(
      [{
        name: 'resolve-resource-basic',
        dependencies: { database: { type: 'resolve-resource-fake-db' } },
      }],
      rootResources,
      [{ appName: 'resolve-resource-basic', slot: 'database', resourceName: 'db' }],
    )

    const viaMap = activated.resources.get('resolve-resource-basic:database')
    assertEquals(
      resolveResource('resolve-resource-basic', 'database'),
      viaMap,
    )

    await deactivateApps(activated)
  },
)

Deno.test(
  'resolveResource() and ctx.resource() resolve the exact same instance — same overlay, two entry points',
  async () => {
    registerResourceType('resolve-resource-same-as-ctx-db', () => ({ close: () => {} }))
    let seenViaCtx: unknown
    const activated = await activateApps(
      [{
        name: 'resolve-resource-same-as-ctx',
        dependencies: { database: { type: 'resolve-resource-same-as-ctx-db' } },
        onStart: (ctx: { resource(slot: string): unknown }) => {
          seenViaCtx = ctx.resource('database')
        },
      }],
      { db: { type: 'resolve-resource-same-as-ctx-db', options: {} } },
      [{ appName: 'resolve-resource-same-as-ctx', slot: 'database', resourceName: 'db' }],
    )

    const seenViaResolve = resolveResource('resolve-resource-same-as-ctx', 'database')
    assert(seenViaCtx !== undefined)
    assertEquals(seenViaCtx, seenViaResolve)

    await deactivateApps(activated)
  },
)

Deno.test(
  'resolveResource(appName, slot): undefined when neither the app nor the slot was ever resolved',
  () => {
    assertEquals(
      resolveResource('resolve-resource-never-activated', 'anything'),
      undefined,
    )
  },
)

Deno.test(
  'resolveResource<T>: the generic types the resolved value without an external cast',
  async () => {
    interface FakeConnector {
      close(): void
      ping(): string
    }
    registerResourceType(
      'resolve-resource-generic-db',
      (): FakeConnector => ({ close: () => {}, ping: () => 'pong' }),
    )
    const activated = await activateApps(
      [{
        name: 'resolve-resource-generic',
        dependencies: { database: { type: 'resolve-resource-generic-db' } },
      }],
      { db: { type: 'resolve-resource-generic-db', options: {} } },
      [{ appName: 'resolve-resource-generic', slot: 'database', resourceName: 'db' }],
    )

    const resolved = resolveResource<FakeConnector>('resolve-resource-generic', 'database')
    // No `as`/cast anywhere above — the generic alone types `resolved` as `FakeConnector | undefined`.
    assertEquals(resolved?.ping(), 'pong')

    await deactivateApps(activated)
  },
)

Deno.test(
  'resolveResource(appName, slot): a mode "remote" slot resolves to the same RemoteAppHandle ctx.resource() would see',
  async () => {
    const activated = await activateApps(
      [{
        name: 'resolve-resource-remote',
        dependencies: { billing: { type: 'resolve-resource-remote-billing' } },
      }],
      {
        billingRemote: {
          type: 'resolve-resource-remote-billing',
          mode: 'remote',
          endpoint: 'resolve-resource-remote-target',
        },
      },
      [{ appName: 'resolve-resource-remote', slot: 'billing', resourceName: 'billingRemote' }],
    )

    const handle = resolveResource<{ call: unknown }>('resolve-resource-remote', 'billing')
    assertEquals(typeof handle?.call, 'function')

    await deactivateApps(activated)
  },
)

Deno.test(
  'resolveResource(appName, slot): resolves an installApp()-time delta resource, standalone',
  async () => {
    registerResourceType('resolve-resource-install-db', () => ({ close: () => {} }))
    const activated = await activateApps([{ name: 'resolve-resource-install-base' }])

    const withNew = await installApp(activated, {
      name: 'resolve-resource-install-new',
      dependencies: { database: { type: 'resolve-resource-install-db' } },
    }, {
      rootResources: { db: { type: 'resolve-resource-install-db', options: {} } },
      bindings: [{
        appName: 'resolve-resource-install-new',
        slot: 'database',
        resourceName: 'db',
      }],
    })

    assert(resolveResource('resolve-resource-install-new', 'database') !== undefined)

    await deactivateApps(withNew)
  },
)

Deno.test(
  'resolveResource(appName, slot): undefined again once the app is hot-uninstalled — never returns an already-closed instance',
  async () => {
    let closed = false
    registerResourceType('resolve-resource-uninstall-db', () => ({
      close: () => {
        closed = true
      },
    }))
    const activated = await activateApps(
      [{
        name: 'resolve-resource-uninstall',
        dependencies: { database: { type: 'resolve-resource-uninstall-db' } },
      }],
      { db: { type: 'resolve-resource-uninstall-db', options: {} } },
      [{ appName: 'resolve-resource-uninstall', slot: 'database', resourceName: 'db' }],
    )
    assert(resolveResource('resolve-resource-uninstall', 'database') !== undefined)

    await uninstallApp(activated, 'resolve-resource-uninstall')

    assert(closed, 'the resource must actually close on uninstall')
    assertEquals(
      resolveResource('resolve-resource-uninstall', 'database'),
      undefined,
      'a closed resource must never stay resolvable standalone',
    )
  },
)

Deno.test(
  'resolveResource(appName, slot): undefined again once the whole batch is deactivated',
  async () => {
    registerResourceType('resolve-resource-deactivate-db', () => ({ close: () => {} }))
    const activated = await activateApps(
      [{
        name: 'resolve-resource-deactivate',
        dependencies: { database: { type: 'resolve-resource-deactivate-db' } },
      }],
      { db: { type: 'resolve-resource-deactivate-db', options: {} } },
      [{ appName: 'resolve-resource-deactivate', slot: 'database', resourceName: 'db' }],
    )
    assert(resolveResource('resolve-resource-deactivate', 'database') !== undefined)

    await deactivateApps(activated)

    assertEquals(
      resolveResource('resolve-resource-deactivate', 'database'),
      undefined,
    )
  },
)

Deno.test(
  "resolveResource(appName, slot): uninstalling one app never clears a DIFFERENT active app's own resources",
  async () => {
    registerResourceType('resolve-resource-sibling-db', () => ({ close: () => {} }))
    const activated = await activateApps(
      [
        {
          name: 'resolve-resource-sibling-a',
          dependencies: { database: { type: 'resolve-resource-sibling-db' } },
        },
        {
          name: 'resolve-resource-sibling-b',
          dependencies: { database: { type: 'resolve-resource-sibling-db' } },
        },
      ],
      {
        dbA: { type: 'resolve-resource-sibling-db', options: {} },
        dbB: {
          type: 'resolve-resource-sibling-db',
          options: {},
        },
      },
      [
        { appName: 'resolve-resource-sibling-a', slot: 'database', resourceName: 'dbA' },
        { appName: 'resolve-resource-sibling-b', slot: 'database', resourceName: 'dbB' },
      ],
    )

    const next = await uninstallApp(activated, 'resolve-resource-sibling-a')

    assertEquals(
      resolveResource('resolve-resource-sibling-a', 'database'),
      undefined,
    )
    assert(resolveResource('resolve-resource-sibling-b', 'database') !== undefined)

    await deactivateApps(next)
  },
)
