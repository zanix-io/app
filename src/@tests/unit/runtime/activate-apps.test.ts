import { assert, assertEquals, assertRejects } from '@std/assert'
import { InternalError } from '@zanix/errors'
import { activateApps, deactivateApps } from 'modules/runtime/activate-apps.ts'
import { registerResourceType } from 'modules/runtime/resource-types.ts'
import { getNamespacedJobOrigin } from 'modules/runtime/register-jobs.ts'
import { defineZanixApp } from 'modules/manifest/define.ts'
import { normalize } from 'modules/manifest/normalize.ts'
import type { RootResources } from 'typings/manifest.ts'

console.error = () => {}

Deno.test(
  "activateApps: accepts defineZanixApp()'s own return value directly, mixed with raw " +
    'AppDefinition entries, without re-normalizing either',
  async () => {
    const startedApps: string[] = []
    const viaDefine = defineZanixApp({
      name: 'activate-apps-via-define',
      onStart: () => {
        startedApps.push('activate-apps-via-define')
      },
    })
    const viaRaw = {
      name: 'activate-apps-via-raw',
      onStart: () => {
        startedApps.push('activate-apps-via-raw')
      },
    }

    const activated = await activateApps([viaDefine, viaRaw])

    assertEquals(startedApps, ['activate-apps-via-define', 'activate-apps-via-raw'])
    assertEquals(
      activated.apps.map((app) => app.name),
      ['activate-apps-via-define', 'activate-apps-via-raw'],
    )
    // The defineZanixApp() branch must be used AS-IS (never re-normalized) — same object identity
    // as what normalize() itself would have produced for the exact same input, proving this
    // wasn't silently re-run.
    assertEquals(activated.apps[0], viaDefine.definition)
    assertEquals(activated.apps[1], normalize(viaRaw))
  },
)

Deno.test(
  'activateApps: end-to-end — shared resource resolves once, onStart runs sequentially, ' +
    'jobs get namespaced',
  async () => {
    const order: string[] = []
    let fakeConnectorCalls = 0
    registerResourceType('activate-apps-fake-db', (options) => {
      fakeConnectorCalls++
      return { close: () => {}, options }
    })

    const rootResources: RootResources = {
      sharedDb: { type: 'activate-apps-fake-db', options: {} },
    }
    const defs = [
      {
        name: 'activate-apps-reviews',
        dependencies: { database: { type: 'activate-apps-fake-db' } },
        jobs: { syncReviews: { processingQueue: 'soft' as const, handler: () => {} } },
        onStart: () => {
          order.push('reviews-start')
        },
      },
      {
        name: 'activate-apps-billing',
        dependencies: { database: { type: 'activate-apps-fake-db' } },
        onStart: () => {
          order.push('billing-start')
        },
      },
    ]
    const bindings = [
      { appName: 'activate-apps-reviews', slot: 'database', resourceName: 'sharedDb' },
      { appName: 'activate-apps-billing', slot: 'database', resourceName: 'sharedDb' },
    ]

    const activated = await activateApps(defs, rootResources, bindings)

    assertEquals(fakeConnectorCalls, 1, 'a shared root resource must only ever construct once')
    assert(
      activated.resources.get('activate-apps-reviews:database') ===
        activated.resources.get('activate-apps-billing:database'),
      'both apps must share the exact same resource instance',
    )
    assertEquals(order, ['reviews-start', 'billing-start'], 'onStart must run in declaration order')
    assertEquals(getNamespacedJobOrigin('activate-apps-reviews:syncReviews'), {
      appName: 'activate-apps-reviews',
      originalName: 'syncReviews',
    })

    await deactivateApps(activated) // must not throw
  },
)

Deno.test(
  'activateApps: validate() failure throws BEFORE anything is registered — no job, no resource construction',
  async () => {
    let fakeConnectorCalls = 0
    registerResourceType('activate-apps-fail-fast-db', () => {
      fakeConnectorCalls++
      return { close: () => {} }
    })

    const defs = [
      {
        name: 'activate-apps-missing-dep',
        dependencies: { database: { type: 'activate-apps-fail-fast-db', required: true } },
        jobs: { neverRegistered: { processingQueue: 'soft' as const, handler: () => {} } },
      },
    ]

    await assertRejects(() => activateApps(defs), InternalError)

    assertEquals(fakeConnectorCalls, 0, 'no resource must ever construct when validate() throws')
    assertEquals(getNamespacedJobOrigin('activate-apps-missing-dep:neverRegistered'), undefined)
  },
)

Deno.test(
  'deactivateApps: closes resources AFTER onStop, and still closes them even if onStop fails',
  async () => {
    let closed = false
    registerResourceType('activate-apps-lifecycle-fake', () => ({
      close: () => {
        closed = true
      },
    }))

    const defs = [
      {
        name: 'activate-apps-lifecycle',
        dependencies: { database: { type: 'activate-apps-lifecycle-fake' } },
        onStop: () => {
          throw new Error('boom')
        },
      },
    ]
    const rootResources: RootResources = {
      db: { type: 'activate-apps-lifecycle-fake', options: {} },
    }
    const bindings = [
      { appName: 'activate-apps-lifecycle', slot: 'database', resourceName: 'db' },
    ]

    const activated = await activateApps(defs, rootResources, bindings)
    assert(!closed, 'must not be closed before deactivateApps runs at all')

    await assertRejects(() => deactivateApps(activated), AggregateError)

    assert(closed, 'must still close resources even though onStop failed')
  },
)
