import type { NormalizedAppDefinition } from 'typings/manifest.ts'

/**
 * Process-wide `${appName}:${behaviorName} -> implementation` overlay — the only thing that makes
 * a host's `activateApps()`-time `behaviors` override actually visible to `resolveBehavior`/
 * `ctx.behavior(name)`. Same module-level-`Map` pattern already used by `config-overrides.ts`/
 * `operation-registry.ts`/`register-jobs.ts`.
 *
 * Written exactly once per override, by `activateApps()` itself (never by application code
 * directly) — unlike `config-overrides.ts`, there is no later hot-refresh path today; a behavior
 * override is a composition-time decision, not something pushed after the fact. Never touched for
 * an app nobody ever overrides — `resolveBehavior` then reads straight from {@link behaviorDefaults}.
 *
 * @module
 */
const behaviorOverrides = new Map<string, (...args: never[]) => unknown>()

/**
 * Process-wide `${appName}:${behaviorName} -> behaviors.<name>.default` registry — populated by
 * {@linkcode registerBehaviors} at the same moment `operation-registry.ts`'s `registerOperations`
 * populates `operationRegistry`. Exists so `resolveBehavior(appName, name)` can resolve a DEFAULT
 * without needing the owning app's own `NormalizedAppDefinition` in scope (unlike
 * `buildRuntimeContext`, which already has `def` in closure and could read `def.behaviors[name]?.default`
 * directly — a standalone function outside that closure cannot).
 */
const behaviorDefaults = new Map<string, (...args: never[]) => unknown>()

function behaviorKey(appName: string, behaviorName: string): string {
  return `${appName}:${behaviorName}`
}

/** Sets `appName`'s `behaviorName` to `implementation`, overriding whatever the manifest's own
 * `default` says — called by `activateApps()` for each of its own `behaviors` entries, never by
 * application code directly. */
export function setBehaviorOverride(
  appName: string,
  behaviorName: string,
  implementation: (...args: never[]) => unknown,
): void {
  behaviorOverrides.set(behaviorKey(appName, behaviorName), implementation)
}

/**
 * Registers every default in `def.behaviors`, so `resolveBehavior(def.name, name)` can resolve it
 * even when called from outside `def`'s own closure (e.g. a Space page's render, which has no
 * `RuntimeContext` at all) — a no-op if `def.behaviors` is empty.
 *
 * @param def The app whose behavior defaults are being registered — expected to already be inside
 * the `ProgramModule.defineApplication(def.name, ...)` scope that owns this app's composition (same
 * calling convention as `registerOperations`).
 */
export function registerBehaviors(def: NormalizedAppDefinition): void {
  for (const [behaviorName, declaration] of Object.entries(def.behaviors)) {
    behaviorDefaults.set(
      behaviorKey(def.name, behaviorName),
      declaration.default,
    )
  }
}

/**
 * Resolves `appName`'s `behaviorName` to a host override if one was ever set, else to that app's
 * own declared default, else `undefined` (neither ever existed — an unknown name, or an app never
 * activated in this process). The ONE resolution function both `ctx.behavior(name)` and standalone
 * callers (e.g. a Space page overriding a single Comet) go through — never two separate code paths
 * that could silently diverge.
 *
 * `T` is manually specified, not inferred (unlike `resolveTarget<T>`, whose `T` comes from a real
 * class-reference argument) — `name` is just a string with no type-carrying shape, so `T` here is
 * exactly as sound as an `as T` cast. Its only purpose is letting `resolveBehavior<T>(...) ?? default`
 * type-check without wrapping the whole expression in an external cast. Defaults to `unknown`, so a
 * call that omits it behaves exactly as before this generic existed.
 *
 * @param appName The target app's `name`, as declared in ITS manifest.
 * @param name Must exist in that app's own `behaviors` to resolve to anything but `undefined`.
 */
export function resolveBehavior<T = unknown>(
  appName: string,
  name: string,
): T | undefined {
  const key = behaviorKey(appName, name)
  const resolved = behaviorOverrides.get(key) ?? behaviorDefaults.get(key)
  return resolved as T | undefined
}
