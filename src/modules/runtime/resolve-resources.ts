import type { DependencyGraph } from 'typings/manifest.ts'
import { InternalError } from '@zanix/errors'
import { getResourceFactory } from './resource-types.ts'
import type { ResourceRegistry } from './resource-registry.ts'
import { connectorModuleInitialization } from '@zanix/server'
import type { ZanixConnector } from '@zanix/server'
import { createRemoteCaller, type HttpRemoteDispatcher } from './remote-caller.ts'
import { registerResourceInstances } from './resource-instance-registry.ts'

/**
 * Structural check for "is this a real `ZanixConnector` instance" — `CloseableResource` (what
 * every `ResourceFactory` is only required to return) never requires `isHealthy`/`isReady`, so a
 * host-registered resource type with no such concept (e.g. a plain in-memory fake) must never be
 * forced through connector-specific health-gating.
 */
function isZanixConnector(instance: unknown): instance is ZanixConnector {
  return (
    typeof (instance as { isHealthy?: unknown })?.isHealthy === 'function' &&
    (instance as { isReady?: unknown })?.isReady instanceof Promise
  )
}

/**
 * Health-gates a just-constructed resource before it's considered resolved, reusing
 * `@zanix/server`'s own `connectorModuleInitialization` — the exact function
 * `targetInitializations` already runs for every `@Connector`-decorated target. Resources built
 * via `resource-types.ts` (`'mongo'`/`'redis'` and any host-registered type) are constructed
 * OUTSIDE the `@Connector`/`TargetContainer` path by this package's own design (see
 * `resource-types.ts`), so `targetInitializations` never sees them; this is the equivalent gate
 * for that path, not a reimplementation of it.
 */
async function healthGateIfConnector(instance: unknown): Promise<void> {
  if (isZanixConnector(instance)) await connectorModuleInitialization(instance)
}

/**
 * Resolves every entry in `graph.resolvedKeys` through `registry`, returning a
 * `Map<`${appName}:${slot}`, instance>` — the exact shape `ctx.resource(slot)` (once built) reads
 * from directly, never re-triggering a construction itself. Two entries that share the same
 * `qualifiedKey` (e.g. two apps bound to the same root resource) resolve to the SAME instance,
 * via `registry`'s own promise-memoization — this function adds no caching of its own, it only
 * knows how to turn a `type` into a real instance the first time `registry` asks for one.
 *
 * @param graph The already-validated dependency graph (see `validate()`) — never called on an
 * unvalidated graph.
 * @param registry Where constructed LOCAL instances live/get cached — one shared instance across
 * the whole call, so concurrent resolutions for the same `qualifiedKey` (two apps racing for the
 * same root resource) still construct exactly once. Never touched for a `mode: 'remote'` key —
 * there's no local instance to construct or cache for one (see below). Each app's own name is
 * passed as `registry.resolve`'s `ownerApp` — the reference-counting bookkeeping `uninstallApp`
 * later needs to know whether a shared resource still has OTHER referents before releasing it.
 * @param dispatcher Same dispatcher `ctx.remote()` itself uses — needed only for a `mode: 'remote'`
 * resolved key, to build the `RemoteAppHandle` that key resolves to. Omit entirely if this call's
 * `graph` declares no remote resources at all.
 * @throws {InternalError} if a resolved key's `type` has no registered factory (see
 * `registerResourceType`) — LOCAL keys only; a remote key never touches the factory registry.
 * @throws {InternalError} (propagated from `connectorModuleInitialization`) if a constructed
 * `ZanixConnector` instance (e.g. `'mongo'`/`'redis'`) never reports healthy before its own
 * `timeoutConnection` elapses.
 * @returns A map only ever populated with instances that are already ready/healthy, for any
 * instance that is a real `ZanixConnector` — a factory returning a plain `CloseableResource`
 * with no such concept resolves as soon as it returns, unaffected. A `mode: 'remote'` key resolves
 * to a `RemoteAppHandle` (`{call(operationName, payload, options)}`) instead — see
 * `RemoteResourceDeclaration`'s own doc for why that's deliberately NOT the same shape a local
 * instance of the same resource `type` would have.
 *
 * Every entry returned here also merges into `resource-instance-registry.ts`'s own process-wide
 * overlay (see {@link registerResourceInstances}), so `resolveResource(appName, slot)` can resolve
 * it from outside any `RuntimeContext` too — the same standalone resolution `resolveBehavior`
 * already gives `behaviors`.
 */
export async function resolveResources(
  graph: DependencyGraph,
  registry: ResourceRegistry,
  dispatcher?: HttpRemoteDispatcher,
): Promise<Map<string, unknown>> {
  const resolvedByAppSlot = new Map<string, unknown>()
  const remoteCaller = createRemoteCaller(dispatcher)

  await Promise.all(
    [...graph.resolvedKeys].map(async ([appSlotKey, resolvedKey]) => {
      if (resolvedKey.mode === 'remote') {
        // No `ResourceRegistry` involvement at all — a `RemoteAppHandle` owns no connection/
        // lifecycle of its own to cache or close; it's cheap to build fresh every time, and two
        // apps resolving the SAME remote endpoint are never expected to share one "instance" the
        // way two apps sharing a root LOCAL resource are.
        const [callerAppName] = appSlotKey.split(':')
        resolvedByAppSlot.set(
          appSlotKey,
          remoteCaller(callerAppName, resolvedKey.endpoint),
        )
        return
      }

      const [ownerApp] = appSlotKey.split(':')
      const instance = await registry.resolve(
        resolvedKey.qualifiedKey,
        async () => {
          const factory = getResourceFactory(resolvedKey.type)
          if (!factory) {
            throw new InternalError(
              `No resource factory registered for type "${resolvedKey.type}" ` +
                `(qualifiedKey "${resolvedKey.qualifiedKey}") — see registerResourceType().`,
              {
                code: 'UNKNOWN_RESOURCE_TYPE',
                meta: { source: 'zanix', type: resolvedKey.type },
              },
            )
          }
          const instance = await factory(resolvedKey.options)
          await healthGateIfConnector(instance)
          return instance
        },
        ownerApp,
      )
      resolvedByAppSlot.set(appSlotKey, instance)
    }),
  )

  registerResourceInstances(resolvedByAppSlot)
  return resolvedByAppSlot
}
