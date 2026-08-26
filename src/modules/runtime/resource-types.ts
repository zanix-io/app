import type { CloseableResource } from './resource-registry.ts'
import { DATAMASTER_SPECIFIER } from '../lazy/specifiers.ts'
import { lazyClass } from '@zanix/helpers'

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
 * this package hardcodes; anything can register a new one). Empty by default — `'mongo'`/
 * `'redis'` are resolved lazily (see {@link getResourceFactory}), never pre-seeded here, so this
 * module itself carries zero `@zanix/datamaster` dependency. A host that wants a resource type
 * this package has never heard of registers its own factory the same way.
 */
const resourceTypeRegistry = new Map<string, ResourceFactory>()

/** Registers `type`'s factory — last-write-wins, same as `registerApplicationMount`. Lets a host
 * (or another package) plug in a resource type this module never hardcoded, including
 * overriding the built-in `'mongo'`/`'redis'` resolution below. */
export function registerResourceType(type: string, factory: ResourceFactory): void {
  resourceTypeRegistry.set(type, factory)
}

/**
 * Built-in `'mongo'`/`'redis'` factories, backed by `@zanix/utils`'s own `lazyClass` —
 * `@zanix/datamaster` itself is never imported until one of these is actually invoked (see
 * `DATAMASTER_SPECIFIER`'s own doc for why the specifier is a deliberately non-literal,
 * fully-qualified `jsr:` string). `lazyClass` returns an async FACTORY (never the class itself —
 * a class can't be `new`ed before its own module has resolved), which is exactly the
 * `ResourceFactory` shape this registry already expects.
 */
const BUILTIN_DATAMASTER_FACTORIES: Record<string, ResourceFactory> = {
  mongo: lazyClass<new (options: Record<string, unknown>) => CloseableResource>(
    DATAMASTER_SPECIFIER,
    'ZanixMongoConnector',
  ),
  redis: lazyClass<new (options: Record<string, unknown>) => CloseableResource>(
    DATAMASTER_SPECIFIER,
    'ZanixRedisConnector',
  ),
}

/**
 * Resolves `type`'s registered factory, falling back to a built-in `'mongo'`/`'redis'` one backed
 * by `@zanix/datamaster` — `undefined` if `type` is neither a host-registered type nor one of
 * those two. Sync — resolving WHICH factory applies never itself needs an `await`; only actually
 * INVOKING the returned factory (see `resolve-resources.ts`) does.
 */
export function getResourceFactory(type: string): ResourceFactory | undefined {
  return resourceTypeRegistry.get(type) ?? BUILTIN_DATAMASTER_FACTORIES[type]
}
