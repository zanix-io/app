import { assertEquals, assertThrows } from '@std/assert'
import { InternalError } from '@zanix/errors'
import { buildGraph, normalize, validate } from 'modules/manifest/mod.ts'
import type { NormalizedAppDefinition, ResourceBinding, RootResources } from 'typings/manifest.ts'

console.error = () => {}

function app(name: string, dependencies: NormalizedAppDefinition['dependencies'] = {}) {
  return normalize({ name, dependencies })
}

// --- The 4 fail-fast validation cases --------------------------------------------------------

Deno.test(
  'validate: MISSING_REQUIRED_DEPENDENCY — a required slot with no `uses` and no local resource throws',
  () => {
    const graph = buildGraph(
      [app('reviews', { database: { type: 'mongo', required: true } })],
      {},
      [],
    )

    assertThrows(() => validate(graph), InternalError, 'requires "dependencies.database"')
  },
)

Deno.test(
  'validate: DEPENDENCY_TYPE_MISMATCH — `uses` resolves to a resource whose type does not match `dependencies`',
  () => {
    const rootResources: RootResources = { cache: { type: 'redis', options: {} } }
    const bindings: ResourceBinding[] = [
      { appName: 'reviews', slot: 'database', resourceName: 'cache' },
    ]
    const graph = buildGraph(
      [app('reviews', { database: { type: 'mongo', required: true } })],
      rootResources,
      bindings,
    )

    assertThrows(() => validate(graph), InternalError, 'declares type "mongo"')
  },
)

Deno.test(
  "validate: UNDECLARED_RESOURCE — a local `resources` entry outside the app's own `dependencies` throws",
  () => {
    const normalized = normalize({
      name: 'reviews',
      dependencies: { database: { type: 'mongo', required: true } },
      resources: {
        // "database" satisfies the dependency; "secretStore" was never declared as a dependency
        // at all — this is exactly the case UNDECLARED_RESOURCE guards against.
        database: { type: 'mongo', options: {} },
        secretStore: { type: 'vault', options: {} },
      },
    })
    const graph = buildGraph([normalized], {}, [])

    assertThrows(() => validate(graph), InternalError, 'not listed in its own "dependencies"')
  },
)

Deno.test(
  'validate: UNKNOWN_DEPENDENCY_SLOT — a host `uses.<slot>` for a slot the app never declared throws',
  () => {
    const rootResources: RootResources = { mongo: { type: 'mongo', options: {} } }
    const bindings: ResourceBinding[] = [
      { appName: 'reviews', slot: 'unknownSlot', resourceName: 'mongo' },
    ]
    // "reviews" never declares ANY dependency at all — the host is binding something it never
    // asked for.
    const graph = buildGraph([app('reviews')], rootResources, bindings)

    assertThrows(() => validate(graph), InternalError, 'never listed "unknownSlot"')
  },
)

Deno.test('validate: a fully satisfied graph (required + matching type) does not throw', () => {
  const rootResources: RootResources = { mongo: { type: 'mongo', options: {} } }
  const bindings: ResourceBinding[] = [{
    appName: 'reviews',
    slot: 'database',
    resourceName: 'mongo',
  }]
  const graph = buildGraph(
    [app('reviews', { database: { type: 'mongo', required: true } })],
    rootResources,
    bindings,
  )

  validate(graph) // must not throw
})

Deno.test('validate: a non-required, unresolved dependency does not throw', () => {
  const graph = buildGraph([app('reviews', { cache: { type: 'redis', required: false } })], {}, [])

  validate(graph) // must not throw — "cache" is optional and simply stays unresolved
})

// --- Resource resolution: shared root vs. local shadow -----

Deno.test(
  'buildGraph: two apps binding to the SAME root resource resolve to the SAME qualifiedKey',
  () => {
    const rootResources: RootResources = { mongo: { type: 'mongo', options: {} } }
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
    assertEquals(reviewsKey?.ownerApp, null, 'a root-shared resource has no owner app')
  },
)

Deno.test(
  'buildGraph: an app with its own local resource under the SAME name as the slot shadows the ' +
    'root — no explicit `uses` binding needed',
  () => {
    const rootResources: RootResources = { database: { type: 'mongo', options: {} } }
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
    const rootResources: RootResources = { primaryMongo: { type: 'mongo', options: {} } }
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
    const rootResources: RootResources = { primaryRedis: { type: 'redis', options: {} } }
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
    const rootResources: RootResources = { primaryMongo: { type: 'mongo', options: {} } }
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
