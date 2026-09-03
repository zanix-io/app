/**
 * Process-wide `${appName}:${slot} -> instance` overlay — mirrors `behavior-registry.ts`'s own
 * `behaviorDefaults`, but for resources: the one thing that lets {@link resolveResource} resolve a
 * resource instance from OUTSIDE any `RuntimeContext` (a `@zanix/space` page, a `ZanixInteractor`
 * handling a request — neither has access to `ctx.resource()`, which only exists inside
 * `setup`/`onStart`/`onStop`/`operations`).
 *
 * Unlike `resources`/`ctx.resource(slot)` itself — a `Map<string, unknown>` threaded PURELY
 * FUNCTIONALLY through `activateApps()`/`installApp()`/`uninstallApp()`, each of which returns a
 * fresh `Map` rather than mutating the one it received — this Map is genuine module-level state:
 * the one thing {@link resolveResource} can read without an `ActivatedApps` reference in scope.
 *
 * Kept in sync with the functional `resources` Map at the two points that actually change it:
 * {@link registerResourceInstances} merges every entry `resolveResources()` produces (covers both
 * a full `activateApps()` batch and an `installApp()` delta, since both call through it);
 * {@link clearResourceInstances} removes an app's own entries once its resources are actually
 * released/closed (`uninstallApp`, `deactivateApps`) — a resource instance staying resolvable here
 * after its own `close()` already ran would be a real correctness bug, not just a stale read,
 * since a `ZanixConnector`'s `close()` can leave the instance unusable.
 *
 * @module
 */
const resourceInstances = new Map<string, unknown>()

function resourceKey(appName: string, slot: string): string {
  return `${appName}:${slot}`
}

/**
 * Merges every `${appName}:${slot} -> instance` entry in `resolved` into the process-wide
 * overlay — called once per `resolveResources()` call, so both a full `activateApps()` batch and
 * an `installApp()` delta stay reflected here, never by application code directly.
 *
 * @param resolved The exact `Map` `resolveResources()` is about to return, including
 * `mode: 'remote'` entries (a `RemoteAppHandle`) — those merge in unchanged, since
 * {@link resolveResource} makes no distinction application code's own `ctx.resource(slot)` doesn't
 * already make either.
 */
export function registerResourceInstances(resolved: Map<string, unknown>): void {
  for (const [key, instance] of resolved) resourceInstances.set(key, instance)
}

/**
 * Removes every entry belonging to `appName` from the process-wide overlay — called once its
 * resources are actually released/closed (`uninstallApp`'s own per-key `registry.release()` loop,
 * `deactivateApps`'s own `registry.close()`), never by application code directly.
 *
 * @param appName The app whose resource instances just stopped being valid to resolve.
 */
export function clearResourceInstances(appName: string): void {
  const prefix = `${appName}:`
  for (const key of resourceInstances.keys()) {
    if (key.startsWith(prefix)) resourceInstances.delete(key)
  }
}

/**
 * Resolves `appName`'s `slot` to its already-constructed resource instance, standalone — the same
 * `${appName}:${slot}` key `ctx.resource(slot)` reads from its own (purely functional) `resources`
 * Map, read here from the process-wide overlay {@link registerResourceInstances} keeps in sync
 * instead. The ONE resolution function standalone callers (e.g. a `ZanixInteractor` with no
 * `RuntimeContext` of its own) go through — never a hand-rolled module-level bridge that would have
 * to be reinvented per consumer.
 *
 * Returns `undefined` for a slot that was never resolved: an unknown name, an app never activated
 * in this process, or one already uninstalled/deactivated — never throws.
 *
 * `T` is manually specified, not inferred (same reasoning as `resolveBehavior<T>` — `slot` is just
 * a string with no type-carrying shape of its own): exactly as sound as an `as T` cast, only
 * sparing the call site from writing one out. Defaults to `unknown`, so a call that omits it
 * behaves exactly as before this generic existed.
 *
 * @param appName The target app's `name`, as declared in ITS manifest.
 * @param slot Must be one of that app's own resolved `dependencies`/`resources` slots to resolve
 * to anything but `undefined`.
 */
export function resolveResource<T = unknown>(
  appName: string,
  slot: string,
): T | undefined {
  return resourceInstances.get(resourceKey(appName, slot)) as T | undefined
}
