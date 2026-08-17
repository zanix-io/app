import type { NormalizedAppDefinition } from 'typings/manifest.ts'
import { ProgramModule, registerApplicationMount } from '@zanix/server'
import { registerNamespacedJobs } from './register-jobs.ts'
import { buildSetupContext } from './build-setup-context.ts'
import { createRemoteCaller, type RemoteCallerFactory } from './remote-caller.ts'
import { registerOperations } from './operation-registry.ts'
import { registerRemoteDispatchRoutes } from './remote-dispatch-route.ts'
import { registerBehaviors } from './behavior-registry.ts'

/**
 * Composes one already-normalized app into the running process: opens its own
 * `ProgramModule.defineApplication` scope (giving it its own route/DI identity), registers its
 * mount prefix (unless `routes: false`), namespaces its jobs, registers its `operations` (both
 * locally — so any app in this same process can reach them via `ctx.remote()` at zero cost — and,
 * if it declared any, the HTTP routes a REMOTE caller would dispatch to), registers its
 * `behaviors` defaults (so `resolveBehavior(def.name, name)` can resolve them even from outside
 * this app's own `RuntimeContext` — see `behavior-registry.ts`), then runs `setup(ctx)` (if the
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
 * @param remoteCaller See `buildRuntimeContext`'s own doc — shared across every app `registerApp`
 * is called for in the same batch.
 */
export async function registerApp(
  def: NormalizedAppDefinition,
  resources: Map<string, unknown>,
  remoteCaller: RemoteCallerFactory = createRemoteCaller(),
): Promise<void> {
  await ProgramModule.defineApplication(def.name, async () => {
    if (def.routesPrefix !== null) {
      registerApplicationMount(def.name, def.routesPrefix)
    }
    registerNamespacedJobs(def)
    registerOperations(def, resources, remoteCaller)
    registerBehaviors(def)
    registerRemoteDispatchRoutes(def)
    await def.setup?.(buildSetupContext(def, resources, remoteCaller))
  })
}
