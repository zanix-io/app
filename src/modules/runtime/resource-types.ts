import type { CloseableResource } from './resource-registry.ts'
import { ZanixMongoConnector, ZanixRedisConnector } from '@zanix/datamaster'

/** Builds the real resource instance for one `resources.<name>`/`dependencies.<slot>.type`
 * entry, given its `options` exactly as declared in the manifest/host `resources`. Sync or
 * async — a concrete connector's own construction (e.g. `new ZanixMongoConnector(options)`) is
 * sync (async initialization happens separately, via its own `isReady`), but nothing requires
 * every factory to be. */
export type ResourceFactory = (
  options: Record<string, unknown>,
) => CloseableResource | Promise<CloseableResource>

/**
 * Open, string-keyed `type -> factory` registry — same shape and purpose as `@zanix/server`'s
 * own `registerCoreConnectorSlot`/`registerCoreProviderSlot` (a type tag is never a closed enum
 * this package hardcodes; anything can register a new one). `'mongo'`/`'redis'` are pre-seeded
 * because `@zanix/app/runtime` already depends on `@zanix/datamaster` for other reasons — a host
 * that wants a resource type this package has never heard of registers its own factory instead
 * of waiting for `@zanix/app` to add it.
 *
 * Every concrete `@zanix/datamaster` connector's `close()` is `protected` — same situation
 * `ResourceRegistry`'s own `CloseableResource` doc already covers for `@zanix/server`'s
 * `ZanixConnector`. The cast below is the exact same "reach a protected member from outside the
 * class hierarchy" the framework's OWN docs/tests do via bracket access
 * (`connector['close']()`) — not a workaround unique to this package.
 */
const resourceTypeRegistry = new Map<string, ResourceFactory>([
  ['mongo', (options) => new ZanixMongoConnector(options) as unknown as CloseableResource],
  ['redis', (options) => new ZanixRedisConnector(options) as unknown as CloseableResource],
])

/** Registers `type`'s factory — last-write-wins, same as `registerApplicationMount`. Lets a host
 * (or another package) plug in a resource type this module never hardcoded. */
export function registerResourceType(type: string, factory: ResourceFactory): void {
  resourceTypeRegistry.set(type, factory)
}

/** Resolves `type`'s registered factory, or `undefined` if nothing was ever registered for it
 * (neither a built-in `'mongo'`/`'redis'` nor a host-registered one). */
export function getResourceFactory(type: string): ResourceFactory | undefined {
  return resourceTypeRegistry.get(type)
}
