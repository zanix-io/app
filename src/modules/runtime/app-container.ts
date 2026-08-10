import type { NormalizedAppDefinition } from 'typings/manifest.ts'
import { ProgramModule, registerApplicationMount } from '@zanix/server'
import { registerNamespacedJobs } from './register-jobs.ts'
import { buildSetupContext } from './build-setup-context.ts'

/**
 * Composes one already-normalized app into the running process: opens its own
 * `ProgramModule.defineApplication` scope (giving it its own route/DI identity), registers its
 * mount prefix (unless `routes: false`), namespaces its jobs, then runs `setup(ctx)` (if the
 * manifest declared one) with a `ctx` scoped to this app and this call's already-resolved
 * `resources`.
 *
 * Deliberately NOT this function's job:
 * - Loading `rootDir`/`package` manifest files (an app installed from disk/a package specifier) —
 *   a separate, not-yet-implemented auto-discovery mechanism; `def.rootDir`/`def.package` are
 *   stored but unused here.
 * - Producing `resources` itself, or running `onStart`/`onStop` — those are cross-app concerns
 *   (one shared `resolveResources()` call, one `runOnStart`/`runOnStop` call across every app),
 *   owned by whoever composes the full set of apps (`@zanix/core`'s `Zanix.start()`), never by a
 *   single app's own registration.
 *
 * @param def The normalized app to register — see `normalize()`.
 * @param resources The shared `Map<`${appName}:${slot}`, instance>` from `resolveResources()` —
 * pass `new Map()` for an app with no resources.
 */
export async function registerApp(
  def: NormalizedAppDefinition,
  resources: Map<string, unknown>,
): Promise<void> {
  await ProgramModule.defineApplication(def.name, async () => {
    if (def.routesPrefix !== null) registerApplicationMount(def.name, def.routesPrefix)
    registerNamespacedJobs(def)
    await def.setup?.(buildSetupContext(def, resources))
  })
}
