/**
 * Process-wide `${appName}:${configKey} -> value` overlay — the only thing that makes a Config
 * Plane hot-refresh (on receiving the update message, `ctx.config.get(key)` refreshes live, with
 * no restart) actually visible to `ctx.config.get(key)`. Same
 * module-level-`Map` pattern already used by `operation-registry.ts`/`register-jobs.ts`.
 *
 * Never touched for an app that never subscribes to Config Plane updates (embedded apps,
 * or a `remote` app with no declared non-secret `config`) — `ctx.config.get(key)` then reads
 * straight from the manifest's own default, exactly as before this module existed.
 *
 * @module
 */
const configOverrides = new Map<string, unknown>()

function overrideKey(appName: string, configKey: string): string {
  return `${appName}:${configKey}`
}

/** Sets `appName`'s `configKey` to `value`, overriding whatever the manifest's own `default`
 * says — called by the Config Plane subscription callback (see `announceRemoteInstance`), never
 * by application code directly. */
export function setConfigOverride(
  appName: string,
  configKey: string,
  value: unknown,
): void {
  configOverrides.set(overrideKey(appName, configKey), value)
}

/** Reads `appName`'s `configKey` override, or `undefined` if it was never set — `undefined` here
 * means "fall back to the manifest default", not "the value is JS `undefined`" (a real value can
 * never be told apart from "never set" this way, but Config Plane values are always
 * JSON-round-tripped already, so a real `undefined` never flows through it in practice). */
export function getConfigOverride(appName: string, configKey: string): unknown {
  return configOverrides.get(overrideKey(appName, configKey))
}

/** Whether `appName`'s `configKey` has ever been overridden — lets `ctx.config.get`
 * distinguish "override present, value happens to be falsy" from "no override at all". */
export function hasConfigOverride(appName: string, configKey: string): boolean {
  return configOverrides.has(overrideKey(appName, configKey))
}
