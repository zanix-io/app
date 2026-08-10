import { assert, assertEquals, assertRejects } from '@std/assert'
import { InternalError } from '@zanix/errors'
import { buildGraph, normalize } from 'modules/manifest/mod.ts'
import { resolveResources } from 'modules/runtime/resolve-resources.ts'
import { registerResourceType } from 'modules/runtime/resource-types.ts'
import { ResourceRegistry } from 'modules/runtime/resource-registry.ts'
import type { RootResources } from 'typings/manifest.ts'

console.error = () => {}
/** Fake resource type registered once for this whole test file — a real `ZanixMongoConnector`
 * auto-connects to a real network address on construction, which unit tests must never do; a
 * fake factory exercises the exact same `resolveResources`/`ResourceRegistry` mechanics without
 * any I/O. `registerResourceType` is exactly the extension point a host would use for a resource
 * type this package never heard of — this test doubles as proof that path works. */
let fakeConnectorCalls = 0
registerResourceType('fake-db', (options) => {
  fakeConnectorCalls++
  return { close: () => {}, options }
})

Deno.test(
  'resolveResources: two apps bound to the SAME root resource resolve to the SAME instance',
  async () => {
    fakeConnectorCalls = 0
    const registry = new ResourceRegistry()
    const rootResources: RootResources = { sharedDb: { type: 'fake-db', options: {} } }
    const bindings = [
      { appName: 'app-a-shared', slot: 'database', resourceName: 'sharedDb' },
      { appName: 'app-b-shared', slot: 'database', resourceName: 'sharedDb' },
    ]
    const graph = buildGraph(
      [
        normalize({ name: 'app-a-shared', dependencies: { database: { type: 'fake-db' } } }),
        normalize({ name: 'app-b-shared', dependencies: { database: { type: 'fake-db' } } }),
      ],
      rootResources,
      bindings,
    )

    const resolved = await resolveResources(graph, registry)

    assert(resolved.get('app-a-shared:database') === resolved.get('app-b-shared:database'))
    assertEquals(fakeConnectorCalls, 1, 'a shared root resource must only ever construct once')
  },
)

Deno.test(
  "resolveResources: an app with its own LOCAL resource of the same slot never shares the root's instance",
  async () => {
    fakeConnectorCalls = 0
    const registry = new ResourceRegistry()
    const rootResources: RootResources = { database: { type: 'fake-db', options: {} } }
    const withLocal = normalize({
      name: 'app-c-local',
      dependencies: { database: { type: 'fake-db' } },
      resources: { database: { type: 'fake-db', options: {} } },
    })
    const withRoot = normalize({
      name: 'app-a-root',
      dependencies: { database: { type: 'fake-db' } },
    })
    const graph = buildGraph(
      [withLocal, withRoot],
      rootResources,
      [{ appName: 'app-a-root', slot: 'database', resourceName: 'database' }],
    )

    const resolved = await resolveResources(graph, registry)

    assert(resolved.get('app-c-local:database') !== resolved.get('app-a-root:database'))
    assertEquals(fakeConnectorCalls, 2, 'a local shadow resource is a construction of its own')
  },
)

Deno.test(
  'resolveResources: two apps racing for the SAME root resource concurrently still construct exactly once',
  async () => {
    fakeConnectorCalls = 0
    let releaseFactory: () => void = () => {}
    const gate = new Promise<void>((resolve) => (releaseFactory = resolve))

    registerResourceType('slow-fake-db', async (options) => {
      fakeConnectorCalls++
      await gate // stay pending so both apps are guaranteed to race mid-construction
      return { close: () => {}, options }
    })

    const registry = new ResourceRegistry()
    const rootResources: RootResources = { sharedSlow: { type: 'slow-fake-db', options: {} } }
    const graph = buildGraph(
      [
        normalize({ name: 'app-a-race', dependencies: { database: { type: 'slow-fake-db' } } }),
        normalize({ name: 'app-b-race', dependencies: { database: { type: 'slow-fake-db' } } }),
      ],
      rootResources,
      [
        { appName: 'app-a-race', slot: 'database', resourceName: 'sharedSlow' },
        { appName: 'app-b-race', slot: 'database', resourceName: 'sharedSlow' },
      ],
    )

    const resolving = resolveResources(graph, registry)
    releaseFactory()
    const resolved = await resolving

    assertEquals(fakeConnectorCalls, 1)
    assert(resolved.get('app-a-race:database') === resolved.get('app-b-race:database'))
  },
)

Deno.test(
  'resolveResources: health-gates a connector-like instance (isReady + isHealthy) via ' +
    "@zanix/server's connectorModuleInitialization before resolving",
  async () => {
    let releaseReady: () => void = () => {}
    const readyGate = new Promise<boolean>((resolve) => (releaseReady = () => resolve(true)))
    let sawHealthCheckedBeforeReturn = false

    registerResourceType('fake-connector-like', () => ({
      close: () => {},
      isReady: readyGate,
      timeoutConnection: 2000,
      retryInterval: 5,
      isHealthy: () => {
        sawHealthCheckedBeforeReturn = true
        return true
      },
    }))

    const registry = new ResourceRegistry()
    const rootResources: RootResources = { db: { type: 'fake-connector-like', options: {} } }
    const graph = buildGraph(
      [normalize({ name: 'app-connector-like', dependencies: { database: { type: 'anything' } } })],
      rootResources,
      [{ appName: 'app-connector-like', slot: 'database', resourceName: 'db' }],
    )

    const resolving = resolveResources(graph, registry)
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert(
      !sawHealthCheckedBeforeReturn,
      'must still be waiting on isReady, isHealthy not checked yet',
    )

    releaseReady()
    await resolving

    assert(
      sawHealthCheckedBeforeReturn,
      'resolveResources must have run the health check before returning',
    )
  },
)

Deno.test(
  'resolveResources: propagates the InternalError when a connector-like instance never becomes healthy',
  async () => {
    registerResourceType('fake-never-healthy', () => ({
      close: () => {},
      isReady: Promise.resolve(true),
      timeoutConnection: 5,
      retryInterval: 1,
      isHealthy: () => false,
    }))

    const registry = new ResourceRegistry()
    const rootResources: RootResources = { db: { type: 'fake-never-healthy', options: {} } }
    const graph = buildGraph(
      [normalize({ name: 'app-never-healthy', dependencies: { database: { type: 'anything' } } })],
      rootResources,
      [{ appName: 'app-never-healthy', slot: 'database', resourceName: 'db' }],
    )

    await assertRejects(() => resolveResources(graph, registry), InternalError)
  },
)

Deno.test(
  'resolveResources: an instance with no isHealthy/isReady (a plain CloseableResource) resolves immediately, unaffected',
  async () => {
    registerResourceType('fake-plain-resource', () => ({ close: () => {} }))
    const registry = new ResourceRegistry()
    const rootResources: RootResources = { db: { type: 'fake-plain-resource', options: {} } }
    const graph = buildGraph(
      [normalize({ name: 'app-plain', dependencies: { database: { type: 'anything' } } })],
      rootResources,
      [{ appName: 'app-plain', slot: 'database', resourceName: 'db' }],
    )

    const resolved = await resolveResources(graph, registry)

    assert(resolved.get('app-plain:database'))
  },
)

Deno.test(
  'resolveResources: a resolved key whose type has no registered factory throws',
  async () => {
    const registry = new ResourceRegistry()
    const rootResources: RootResources = { mystery: { type: 'never-registered-type', options: {} } }
    const graph = buildGraph(
      [normalize({ name: 'app-unknown-type', dependencies: { database: { type: 'anything' } } })],
      rootResources,
      [{ appName: 'app-unknown-type', slot: 'database', resourceName: 'mystery' }],
    )

    await assertRejects(() => resolveResources(graph, registry), InternalError)
  },
)
