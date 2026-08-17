import { assert, assertEquals, assertRejects } from '@std/assert'
import { InternalError } from '@zanix/errors'
import { activateApps, deactivateApps } from 'modules/runtime/activate-apps.ts'
import { resolveBehavior } from 'modules/runtime/behavior-registry.ts'
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

    assertEquals(startedApps, [
      'activate-apps-via-define',
      'activate-apps-via-raw',
    ])
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
        jobs: {
          syncReviews: { processingQueue: 'soft' as const, handler: () => {} },
        },
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
      {
        appName: 'activate-apps-reviews',
        slot: 'database',
        resourceName: 'sharedDb',
      },
      {
        appName: 'activate-apps-billing',
        slot: 'database',
        resourceName: 'sharedDb',
      },
    ]

    const activated = await activateApps(defs, rootResources, bindings)

    assertEquals(
      fakeConnectorCalls,
      1,
      'a shared root resource must only ever construct once',
    )
    assert(
      activated.resources.get('activate-apps-reviews:database') ===
        activated.resources.get('activate-apps-billing:database'),
      'both apps must share the exact same resource instance',
    )
    assertEquals(
      order,
      ['reviews-start', 'billing-start'],
      'onStart must run in declaration order',
    )
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
        dependencies: {
          database: { type: 'activate-apps-fail-fast-db', required: true },
        },
        jobs: {
          neverRegistered: {
            processingQueue: 'soft' as const,
            handler: () => {},
          },
        },
      },
    ]

    await assertRejects(() => activateApps(defs), InternalError)

    assertEquals(
      fakeConnectorCalls,
      0,
      'no resource must ever construct when validate() throws',
    )
    assertEquals(
      getNamespacedJobOrigin('activate-apps-missing-dep:neverRegistered'),
      undefined,
    )
  },
)

Deno.test(
  "activateApps: ctx.behavior(name) resolves to the app's own declared default when no override is given",
  async () => {
    const calculateDiscount = (total: number) => total * 0
    let seen: unknown
    const defs = [
      {
        name: 'activate-apps-billing-default',
        behaviors: { calculateDiscount: { default: calculateDiscount } },
        onStart: (ctx: { behavior<T>(name: string): T | undefined }) => {
          seen = ctx.behavior('calculateDiscount')
        },
      },
    ]

    await activateApps(defs)

    assertEquals(seen, calculateDiscount)
  },
)

Deno.test(
  'activateApps: a behaviors override replaces the declared default for ctx.behavior(name)',
  async () => {
    const defaultDiscount = (total: number) => total * 0
    const customDiscount = (total: number) => total * 0.1
    let seen: unknown
    const defs = [
      {
        name: 'activate-apps-billing-override',
        behaviors: { calculateDiscount: { default: defaultDiscount } },
        onStart: (ctx: { behavior<T>(name: string): T | undefined }) => {
          seen = ctx.behavior('calculateDiscount')
        },
      },
    ]

    await activateApps(defs, {}, [], undefined, {}, [
      {
        appName: 'activate-apps-billing-override',
        name: 'calculateDiscount',
        implementation: customDiscount,
      },
    ])

    assertEquals(seen, customDiscount)
  },
)

Deno.test(
  'activateApps: a behaviors override naming an app not in this activation throws BEFORE anything is registered',
  async () => {
    const defs = [{ name: 'activate-apps-behaviors-no-app' }]

    await assertRejects(
      () =>
        activateApps(defs, {}, [], undefined, {}, [
          {
            appName: 'nonexistent-app',
            name: 'anything',
            implementation: () => {},
          },
        ]),
      InternalError,
    )
  },
)

Deno.test(
  'activateApps: a behaviors override naming a behavior the app never declared throws BEFORE anything is registered',
  async () => {
    const defs = [
      {
        name: 'activate-apps-behaviors-unknown-name',
        behaviors: { calculateDiscount: { default: () => 0 } },
      },
    ]

    await assertRejects(
      () =>
        activateApps(defs, {}, [], undefined, {}, [
          {
            appName: 'activate-apps-behaviors-unknown-name',
            name: 'formatInvoiceNumber',
            implementation: () => 'x',
          },
        ]),
      InternalError,
    )
  },
)

Deno.test(
  "resolveBehavior(appName, name): finds the app's own declared default, standalone (no ctx)",
  async () => {
    const calculateDiscount = (total: number) => total * 0
    const defs = [
      {
        name: 'resolve-behavior-default',
        behaviors: { calculateDiscount: { default: calculateDiscount } },
      },
    ]

    await activateApps(defs)

    assertEquals(
      resolveBehavior('resolve-behavior-default', 'calculateDiscount'),
      calculateDiscount,
    )
  },
)

Deno.test(
  'resolveBehavior(appName, name): a host override replaces the declared default, standalone (no ctx)',
  async () => {
    const defaultDiscount = (total: number) => total * 0
    const customDiscount = (total: number) => total * 0.1
    const defs = [
      {
        name: 'resolve-behavior-override',
        behaviors: { calculateDiscount: { default: defaultDiscount } },
      },
    ]

    await activateApps(defs, {}, [], undefined, {}, [
      {
        appName: 'resolve-behavior-override',
        name: 'calculateDiscount',
        implementation: customDiscount,
      },
    ])

    assertEquals(
      resolveBehavior('resolve-behavior-override', 'calculateDiscount'),
      customDiscount,
    )
  },
)

Deno.test(
  'resolveBehavior() and ctx.behavior() resolve the exact same value — same registry, two entry points',
  async () => {
    const customDiscount = (total: number) => total * 0.1
    let seenViaCtx: unknown
    const defs = [
      {
        name: 'resolve-behavior-same-as-ctx',
        behaviors: {
          calculateDiscount: { default: (total: number) => total * 0 },
        },
        onStart: (ctx: { behavior<T>(name: string): T | undefined }) => {
          seenViaCtx = ctx.behavior('calculateDiscount')
        },
      },
    ]

    await activateApps(defs, {}, [], undefined, {}, [
      {
        appName: 'resolve-behavior-same-as-ctx',
        name: 'calculateDiscount',
        implementation: customDiscount,
      },
    ])

    const seenViaResolve = resolveBehavior(
      'resolve-behavior-same-as-ctx',
      'calculateDiscount',
    )
    assertEquals(seenViaCtx, customDiscount)
    assertEquals(seenViaResolve, customDiscount)
    assertEquals(seenViaCtx, seenViaResolve)
  },
)

Deno.test(
  'resolveBehavior(appName, name): undefined when neither an override nor a default was ever registered',
  () => {
    assertEquals(
      resolveBehavior('resolve-behavior-never-activated', 'anything'),
      undefined,
    )
  },
)

Deno.test(
  'resolveBehavior<T>/ctx.behavior<T>: the generic types the resolved value in both APIs without an external cast',
  async () => {
    type Formatter = (invoiceNumber: number) => string
    const defaultFormatter: Formatter = (n) => `INV-${n}`
    const customFormatter: Formatter = (n) => `CUSTOM-${n}`
    let seenViaCtx: Formatter | undefined
    const defs = [
      {
        name: 'resolve-behavior-generic',
        behaviors: { formatInvoiceNumber: { default: defaultFormatter } },
        onStart: (ctx: { behavior<T>(name: string): T | undefined }) => {
          seenViaCtx = ctx.behavior<Formatter>('formatInvoiceNumber')
        },
      },
    ]

    await activateApps(defs, {}, [], undefined, {}, [
      {
        appName: 'resolve-behavior-generic',
        name: 'formatInvoiceNumber',
        implementation: customFormatter,
      },
    ])

    const seenViaResolve = resolveBehavior<Formatter>(
      'resolve-behavior-generic',
      'formatInvoiceNumber',
    )
    // No `as`/cast anywhere above — the generic alone types both calls as `Formatter | undefined`.
    assertEquals(seenViaCtx?.(1), 'CUSTOM-1')
    assertEquals(seenViaResolve?.(1), 'CUSTOM-1')
  },
)

Deno.test(
  'behaviors: a Comet-shaped function component can be registered/resolved without @zanix/app depending on Preact or React',
  async () => {
    // Stands in for a Preact/React function component (a Comet is, structurally, just a function
    // taking props and returning a value) — `behaviors`/`resolveBehavior` never inspect what the
    // function returns, so this proves the mechanism is content-agnostic without importing any UI
    // framework into this package.
    type FakeVNode = { tag: string; props: Record<string, unknown> }
    const DefaultAddToCartButton = (
      props: Record<string, unknown>,
    ): FakeVNode => ({
      tag: 'DefaultAddToCartButton',
      props,
    })
    const CustomAddToCartButton = (
      props: Record<string, unknown>,
    ): FakeVNode => ({
      tag: 'CustomAddToCartButton',
      props,
    })
    const defs = [
      {
        name: 'resolve-behavior-comet-shaped',
        behaviors: { AddToCartButton: { default: DefaultAddToCartButton } },
      },
    ]

    await activateApps(defs, {}, [], undefined, {}, [
      {
        appName: 'resolve-behavior-comet-shaped',
        name: 'AddToCartButton',
        implementation: CustomAddToCartButton,
      },
    ])

    const Resolved = resolveBehavior<typeof DefaultAddToCartButton>(
      'resolve-behavior-comet-shaped',
      'AddToCartButton',
    ) ?? DefaultAddToCartButton

    assertEquals(Resolved({ product: 'sku-1' }), {
      tag: 'CustomAddToCartButton',
      props: { product: 'sku-1' },
    })
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
      {
        appName: 'activate-apps-lifecycle',
        slot: 'database',
        resourceName: 'db',
      },
    ]

    const activated = await activateApps(defs, rootResources, bindings)
    assert(!closed, 'must not be closed before deactivateApps runs at all')

    await assertRejects(() => deactivateApps(activated), AggregateError)

    assert(closed, 'must still close resources even though onStop failed')
  },
)
