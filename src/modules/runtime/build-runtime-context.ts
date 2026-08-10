import type { NormalizedAppDefinition, RuntimeContext } from 'typings/manifest.ts'

/**
 * Builds the `{resource, config}` object `onStart`/`onStop` receive — read-only accessors over
 * ALREADY-resolved state, never triggering a construction/resolution of their own (see
 * `RuntimeContext`'s own doc).
 *
 * `config.get`/`config.has` read the manifest's own declared default for now — resolving a host
 * override (`apps.<n>.config`) is `@zanix/core`'s own composition step, not wired in yet; this
 * reads exactly what `def.config` already carries; once host-level overrides normalize into
 * that same shape, nothing here needs to change.
 *
 * @param def The app this context belongs to.
 * @param resources The shared `Map<`${appName}:${slot}`, instance>` from `resolveResources()` —
 * `resource(slot)` reads `resources.get(`${def.name}:${slot}`)`, never re-resolving.
 */
export function buildRuntimeContext(
  def: NormalizedAppDefinition,
  resources: Map<string, unknown>,
): RuntimeContext {
  return {
    resource: (slot: string) => resources.get(`${def.name}:${slot}`),
    config: {
      get: (key: string) => def.config[key]?.default ?? undefined,
      has: (key: string) => key in def.config,
    },
  }
}
