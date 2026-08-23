import { assertEquals, assertThrows } from '@std/assert'
import { InternalError } from '@zanix/errors'
import { buildGraph, normalize, validate } from 'modules/manifest/mod.ts'
import type { NormalizedAppDefinition, ResourceBinding, RootResources } from 'typings/manifest.ts'

console.error = () => {}

function app(
  name: string,
  dependencies: NormalizedAppDefinition['dependencies'] = {},
) {
  return normalize({ name, dependencies })
}

// --- Resource resolution: shared root vs. local shadow -----

Deno.test(
  'buildGraph: two apps binding to the SAME root resource resolve to the SAME qualifiedKey',
  () => {
    const rootResources: RootResources = {
      mongo: { type: 'mongo', options: {} },
    }
    const bindings: ResourceBinding[] = [
      { appName: 'reviews', slot: 'database', resourceName: 'mongo' },
      { appName: 'orders', slot: 'database', resourceName: 'mongo' },
    ]
    const graph = buildGraph(
      [
        app('reviews', { database: { type: 'mongo', required: true } }),
        app('orders', { database: { type: 'mongo', required: true } }),
      ],
      rootResources,
      bindings,
    )

    const reviewsKey = graph.resolvedKeys.get('reviews:database')
    const ordersKey = graph.resolvedKeys.get('orders:database')

    assertEquals(reviewsKey?.qualifiedKey, 'mongo')
    assertEquals(ordersKey?.qualifiedKey, 'mongo')
    assertEquals(
      reviewsKey?.ownerApp,
      null,
      'a root-shared resource has no owner app',
    )
  },
)

Deno.test(
  'buildGraph: an app with its own local resource under the SAME name as the slot shadows the ' +
    'root — no explicit `uses` binding needed',
  () => {
    const rootResources: RootResources = {
      database: { type: 'mongo', options: {} },
    }
    const normalized = normalize({
      name: 'billing',
      dependencies: { database: { type: 'postgres', required: true } },
      resources: { database: { type: 'postgres', options: {} } },
    })
    // No binding at all for "billing" — resolution must fall back to its OWN local resource,
    // never the root one (whose type doesn't even match).
    const graph = buildGraph([normalized], rootResources, [])

    const resolved = graph.resolvedKeys.get('billing:database')
    assertEquals(resolved?.qualifiedKey, 'billing:database')
    assertEquals(resolved?.ownerApp, 'billing')
    assertEquals(resolved?.type, 'postgres')

    validate(graph) // must not throw — resolves to its own local resource, type matches
  },
)

// --- Auto-bind: exactly one root resource of the declared `type`, no explicit `uses` needed --

Deno.test(
  "buildGraph: auto-binds to the root resource when EXACTLY ONE matches the slot's declared " +
    'type — no explicit `uses` needed',
  () => {
    const rootResources: RootResources = {
      primaryMongo: { type: 'mongo', options: {} },
    }
    const graph = buildGraph(
      [app('reviews', { database: { type: 'mongo', required: true } })],
      rootResources,
      [], // no explicit uses.database binding at all
    )

    const resolved = graph.resolvedKeys.get('reviews:database')
    assertEquals(resolved?.qualifiedKey, 'primaryMongo')
    assertEquals(resolved?.ownerApp, null)
    assertEquals(resolved?.type, 'mongo')

    validate(graph) // must not throw — auto-bound, type matches
  },
)

Deno.test(
  'buildGraph: never auto-binds when ZERO root resources match the type — stays unresolved, ' +
    'validate() still fails fast for a required slot',
  () => {
    const rootResources: RootResources = {
      primaryRedis: { type: 'redis', options: {} },
    }
    const graph = buildGraph(
      [app('reviews', { database: { type: 'mongo', required: true } })],
      rootResources,
      [],
    )

    assertEquals(graph.resolvedKeys.get('reviews:database'), undefined)
    assertThrows(() => validate(graph), InternalError)
  },
)

Deno.test(
  'buildGraph: never auto-binds when MORE THAN ONE root resource matches the type (real ' +
    'ambiguity) — stays unresolved, an explicit `uses` is still required',
  () => {
    const rootResources: RootResources = {
      mongoA: { type: 'mongo', options: {} },
      mongoB: { type: 'mongo', options: {} },
    }
    const graph = buildGraph(
      [app('reviews', { database: { type: 'mongo', required: true } })],
      rootResources,
      [],
    )

    assertEquals(graph.resolvedKeys.get('reviews:database'), undefined)
    assertThrows(() => validate(graph), InternalError)
  },
)

Deno.test(
  'buildGraph: an explicit `uses` binding that fails to resolve is a real error, never silently ' +
    'replaced by auto-bind even if exactly one root resource of the right type exists',
  () => {
    const rootResources: RootResources = {
      primaryMongo: { type: 'mongo', options: {} },
    }
    const bindings: ResourceBinding[] = [
      { appName: 'reviews', slot: 'database', resourceName: 'nonexistent' },
    ]
    const graph = buildGraph(
      [app('reviews', { database: { type: 'mongo', required: true } })],
      rootResources,
      bindings,
    )

    // The explicit (but broken) binding is checked FIRST and returns unresolved on its own —
    // auto-bind (a fallback for "no binding at all") must never override a host's explicit,
    // if mistaken, intent.
    assertEquals(graph.resolvedKeys.get('reviews:database'), undefined)
    assertThrows(() => validate(graph), InternalError)
  },
)

// --- Remote Resource Binding (buildGraph resolution only — validate's own remote rules live in
// validate.test.ts) --------------------------------------------------------------------------

Deno.test(
  'buildGraph: a root resource with mode: "remote" resolves to an endpoint, never construction options',
  () => {
    const rootResources: RootResources = {
      billingDb: { type: 'mongo', mode: 'remote', endpoint: 'billing' },
    }
    const graph = buildGraph(
      [app('reviews', { database: { type: 'mongo', required: true } })],
      rootResources,
      [{ appName: 'reviews', slot: 'database', resourceName: 'billingDb' }],
    )

    assertEquals(graph.resolvedKeys.get('reviews:database'), {
      qualifiedKey: 'billingDb',
      type: 'mongo',
      mode: 'remote',
      endpoint: 'billing',
      requiredVersion: undefined,
      ownerApp: null,
    })
  },
)

Deno.test(
  'buildGraph: an app\'s own LOCAL resource with mode: "remote" resolves the same way, scoped to that app',
  () => {
    const withRemoteLocal = normalize({
      name: 'reviews',
      dependencies: { database: { type: 'mongo', required: true } },
      resources: {
        database: { type: 'mongo', mode: 'remote', endpoint: 'billing' },
      },
    })
    const graph = buildGraph([withRemoteLocal], {}, [])

    assertEquals(graph.resolvedKeys.get('reviews:database'), {
      qualifiedKey: 'reviews:database',
      type: 'mongo',
      mode: 'remote',
      endpoint: 'billing',
      requiredVersion: undefined,
      ownerApp: 'reviews',
    })
  },
)
