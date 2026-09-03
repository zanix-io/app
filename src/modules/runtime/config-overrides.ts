import type { NormalizedAppDefinition } from 'typings/manifest.ts'

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

/**
 * Process-wide `${appName}:${configKey} -> config.<key>.default` registry — mirrors
 * `behavior-registry.ts`'s own `behaviorDefaults`, populated by {@link registerConfigDefaults} at
 * the same moment `app-container.ts`'s `registerApp` already calls `registerBehaviors`. Exists so
 * {@link resolveConfig} can resolve a DEFAULT without needing the owning app's own
 * `NormalizedAppDefinition` in scope (unlike `buildRuntimeContext`, which already has `def` in
 * closure and could read `def.config[key]?.default` directly — a standalone function outside that
 * closure cannot).
 */
const configDefaults = new Map<string, unknown>()

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

/**
 * Registers every declared default in `def.config`, so {@link resolveConfig}`(def.name, key)` can
 * resolve it even when called from outside `def`'s own closure (e.g. a `ZanixInteractor` handling
 * a request, invoked long after `setup(ctx)` already ran) — a no-op if `def.config` is empty.
 *
 * @param def The app whose config defaults are being registered — expected to already be inside
 * the `ProgramModule.defineApplication(def.name, ...)` scope that owns this app's composition (same
 * calling convention as `registerBehaviors`).
 */
export function registerConfigDefaults(def: NormalizedAppDefinition): void {
  for (const [configKey, declaration] of Object.entries(def.config)) {
    configDefaults.set(overrideKey(def.name, configKey), declaration.default)
  }
}

/**
 * Resolves `appName`'s `configKey` to a host override if one was ever set, else to that app's own
 * declared default, else `undefined` (neither ever existed — an unknown key, or an app never
 * activated in this process) — the exact "override, else default" precedence `ctx.config.get`
 * already follows, resolved standalone here. `ctx.config.get` delegates to this function
 * internally, so the two entry points can never resolve differently — the config-side counterpart
 * to `resolveBehavior`, for code with no `RuntimeContext` of its own (a `ZanixInteractor` handling
 * a request, a `@zanix/space` page's own render).
 *
 * `T` is manually specified, not inferred (`configKey` is just a string with no type-carrying
 * shape) — exactly as sound as an `as T` cast, only sparing the call site from writing one out.
 * Defaults to `unknown`, so a call that omits it behaves exactly as before this generic existed.
 *
 * @param appName The target app's `name`, as declared in ITS manifest.
 * @param configKey Must exist in that app's own `config` to resolve to anything but `undefined` —
 * `null`/`undefined` (a declared key with no default, or one never declared at all) both collapse
 * to `undefined` here, same as `ctx.config.get` already does.
 */
export function resolveConfig<T = unknown>(
  appName: string,
  configKey: string,
): T | undefined {
  if (hasConfigOverride(appName, configKey)) {
    return getConfigOverride(appName, configKey) as T | undefined
  }
  return (configDefaults.get(overrideKey(appName, configKey)) ?? undefined) as T | undefined
}
