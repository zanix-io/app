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

// --- The 4 fail-fast validation cases --------------------------------------------------------

Deno.test(
  'validate: MISSING_REQUIRED_DEPENDENCY — a required slot with no `uses` and no local resource throws',
  () => {
    const graph = buildGraph(
      [app('reviews', { database: { type: 'mongo', required: true } })],
      {},
      [],
    )

    assertThrows(
      () => validate(graph),
      InternalError,
      'requires "dependencies.database"',
    )
  },
)

Deno.test(
  'validate: DEPENDENCY_TYPE_MISMATCH — `uses` resolves to a resource whose type does not match `dependencies`',
  () => {
    const rootResources: RootResources = {
      cache: { type: 'redis', options: {} },
    }
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

    assertThrows(
      () => validate(graph),
      InternalError,
      'not listed in its own "dependencies"',
    )
  },
)

Deno.test(
  'validate: UNKNOWN_DEPENDENCY_SLOT — a host `uses.<slot>` for a slot the app never declared throws',
  () => {
    const rootResources: RootResources = {
      mongo: { type: 'mongo', options: {} },
    }
    const bindings: ResourceBinding[] = [
      { appName: 'reviews', slot: 'unknownSlot', resourceName: 'mongo' },
    ]
    // "reviews" never declares ANY dependency at all — the host is binding something it never
    // asked for.
    const graph = buildGraph([app('reviews')], rootResources, bindings)

    assertThrows(
      () => validate(graph),
      InternalError,
      'never listed "unknownSlot"',
    )
  },
)

Deno.test('validate: a fully satisfied graph (required + matching type) does not throw', () => {
  const rootResources: RootResources = {
    mongo: { type: 'mongo', options: {} },
  }
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
  const graph = buildGraph(
    [app('reviews', { cache: { type: 'redis', required: false } })],
    {},
    [],
  )

  validate(graph) // must not throw — "cache" is optional and simply stays unresolved
})

// --- Remote Resource Binding (validate's own remote rules — buildGraph's own resolution tests
// live in graph.test.ts) -----------------------------------------------------------------------

Deno.test(
  'validate: a remote resource still enforces the type-match rule exactly like a local one',
  () => {
    const rootResources: RootResources = {
      billingCache: { type: 'redis', mode: 'remote', endpoint: 'billing' },
    }
    const bindings: ResourceBinding[] = [
      { appName: 'reviews', slot: 'database', resourceName: 'billingCache' },
    ]
    const graph = buildGraph(
      [app('reviews', { database: { type: 'mongo', required: true } })],
      rootResources,
      bindings,
    )

    assertThrows(() => validate(graph), InternalError, 'declares type "mongo"')
  },
)

// --- requiredVersion (manifest version validated between apps) --------------------------------

Deno.test(
  "validate: requiredVersion satisfied by the co-located target app's own version never throws",
  () => {
    const reviews = app('reviews', {
      database: { type: 'mongo', required: true },
    })
    const billing = normalize({ name: 'billing', version: '1.4.0' })
    const graph = buildGraph(
      [reviews, billing],
      {
        billingDb: {
          type: 'mongo',
          mode: 'remote',
          endpoint: 'billing',
          requiredVersion: '^1.0.0',
        },
      },
      [{ appName: 'reviews', slot: 'database', resourceName: 'billingDb' }],
    )

    validate(graph) // must not throw
  },
)

Deno.test(
  "validate: REMOTE_RESOURCE_VERSION_MISMATCH when the co-located target's version does not satisfy requiredVersion",
  () => {
    const reviews = app('reviews', {
      database: { type: 'mongo', required: true },
    })
    const billing = normalize({ name: 'billing', version: '2.0.0' })
    const graph = buildGraph(
      [reviews, billing],
      {
        billingDb: {
          type: 'mongo',
          mode: 'remote',
          endpoint: 'billing',
          requiredVersion: '^1.0.0',
        },
      },
      [{ appName: 'reviews', slot: 'database', resourceName: 'billingDb' }],
    )

    const error = assertThrows(() => validate(graph), InternalError)
    assertEquals(
      (error as InternalError).code,
      'REMOTE_RESOURCE_VERSION_MISMATCH',
    )
  },
)

Deno.test(
  'validate: requiredVersion is silently skipped when the target app never declared its own version',
  () => {
    const reviews = app('reviews', {
      database: { type: 'mongo', required: true },
    })
    const billing = normalize({ name: 'billing' }) // no version declared
    const graph = buildGraph(
      [reviews, billing],
      {
        billingDb: {
          type: 'mongo',
          mode: 'remote',
          endpoint: 'billing',
          requiredVersion: '^1.0.0',
        },
      },
      [{ appName: 'reviews', slot: 'database', resourceName: 'billingDb' }],
    )

    validate(graph) // must not throw — nothing to check against
  },
)

Deno.test(
  'validate: requiredVersion is silently skipped when the target app is not part of this same graph at all',
  () => {
    // "billing" is genuinely elsewhere — never passed to buildGraph, only referenced by name.
    const reviews = app('reviews', {
      database: { type: 'mongo', required: true },
    })
    const graph = buildGraph(
      [reviews],
      {
        billingDb: {
          type: 'mongo',
          mode: 'remote',
          endpoint: 'billing',
          requiredVersion: '^1.0.0',
        },
      },
      [{ appName: 'reviews', slot: 'database', resourceName: 'billingDb' }],
    )

    validate(graph) // must not throw — an actually cross-process target can't be checked here
  },
)

Deno.test(
  'validate: INVALID_VERSION_RANGE when requiredVersion itself is not valid semver',
  () => {
    const reviews = app('reviews', {
      database: { type: 'mongo', required: true },
    })
    const billing = normalize({ name: 'billing', version: '1.0.0' })
    const graph = buildGraph(
      [reviews, billing],
      {
        billingDb: {
          type: 'mongo',
          mode: 'remote',
          endpoint: 'billing',
          requiredVersion: 'not-a-real-range',
        },
      },
      [{ appName: 'reviews', slot: 'database', resourceName: 'billingDb' }],
    )

    const error = assertThrows(() => validate(graph), InternalError)
    assertEquals((error as InternalError).code, 'INVALID_VERSION_RANGE')
  },
)
