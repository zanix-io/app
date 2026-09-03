import type { NormalizedAppDefinition, RuntimeContext } from 'typings/manifest.ts'
import { createRemoteCaller, type RemoteCallerFactory } from './remote-caller.ts'
import { resolveConfig } from './config-overrides.ts'
import { resolveBehavior } from './behavior-registry.ts'

/**
 * Builds the `{resource, config, remote}` object `onStart`/`onStop` receive — read-only accessors
 * over ALREADY-resolved state, never triggering a construction/resolution of their own (see
 * `RuntimeContext`'s own doc).
 *
 * `config.get` delegates entirely to `resolveConfig(def.name, key)` (`config-overrides.ts`) — the
 * SAME function a standalone caller outside any `RuntimeContext` (e.g. a `ZanixInteractor` handling
 * a request) goes through, so the two entry points can never diverge. `resolveConfig` itself checks
 * the Config Plane hot-refresh overlay FIRST — the only way a `remote` instance subscribed via
 * `announceRemoteInstance` ever sees a live push reflected here — falling back to that app's own
 * declared default (registered once, at `registerApp()` time, via `registerConfigDefaults`) when no
 * override was ever set (an `embedded` app, or one that never declared non-secret `config`, always
 * falls back — that overlay stays untouched for it). `config.has` only checks `def.config`'s own
 * declared keys, never the override overlay directly — safe because an override can only ever exist
 * for a key already declared there (`announceRemoteInstance` only ever subscribes declared,
 * non-secret keys), so the two can never disagree in practice. Resolving a HOST-level static
 * override (`apps.<n>.config`, `@zanix/core`'s own composition step) is separate and still not
 * wired in; once it normalizes into `def.config` itself, nothing here needs to change.
 *
 * @param def The app this context belongs to — also `remote()`'s own caller identity.
 * @param resources The shared `Map<`${appName}:${slot}`, instance>` from `resolveResources()` —
 * `resource(slot)` reads `resources.get(`${def.name}:${slot}`)`, never re-resolving. The same
 * instance is also reachable standalone, outside any `RuntimeContext`, via
 * `resolveResource(def.name, slot)` (`resource-instance-registry.ts`) — the resource-side
 * counterpart to `resolveBehavior`, for code with no `ctx` of its own (a `@zanix/space` page, a
 * `ZanixInteractor` handling a request).
 * @param remoteCaller The shared factory from `activateApps()`'s own `createRemoteCaller()` call —
 * one instance across every app in the batch; `def.name` is applied here as the caller identity.
 * Defaults to a local-only caller (see `createRemoteCaller`'s own doc) — safe because the
 * in-process operation registry it consults is module-level state, shared regardless of which
 * `RemoteCallerFactory` instance is used; only the "target isn't local, and no dispatcher is
 * configured" error path differs per instance.
 *
 * `behavior(name)` delegates entirely to `resolveBehavior(def.name, name)` (`behavior-registry.ts`)
 * — the SAME function a standalone caller outside any `RuntimeContext` (e.g. a Space page overriding
 * a single Comet) goes through, so the two entry points can never diverge. `resolveBehavior` itself
 * checks the host-set override overlay first, falling back to `def.behaviors[name]?.default`
 * (registered once, at `registerApp()` time, via `registerBehaviors`) when no override was ever set.
 */
export function buildRuntimeContext(
  def: NormalizedAppDefinition,
  resources: Map<string, unknown>,
  remoteCaller: RemoteCallerFactory = createRemoteCaller(),
): RuntimeContext {
  return {
    resource: (slot: string) => resources.get(`${def.name}:${slot}`),
    config: {
      get: (key: string) => resolveConfig(def.name, key),
      has: (key: string) => key in def.config,
    },
    remote: (targetAppName: string) => remoteCaller(def.name, targetAppName),
    behavior: <T = unknown>(name: string) => resolveBehavior<T>(def.name, name),
  }
}
