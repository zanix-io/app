import type { AppSetupContext, NormalizedAppDefinition } from 'typings/manifest.ts'
import { buildRuntimeContext } from './build-runtime-context.ts'
import { resolveTarget } from './resolve-target.ts'

/**
 * Builds the `ctx` an app's `setup(ctx)` receives — `buildRuntimeContext`'s
 * `{resource, config}` plus the two registration-time-only members (`routes`/`resolve`) that
 * `onStart`/`onStop` deliberately never get, because composition has already finished by the
 * time those run (see `AppSetupContext`'s own doc).
 *
 * @param def The app whose `setup(ctx)` this builds for.
 * @param resources The shared `Map<`${appName}:${slot}`, instance>` from `resolveResources()`.
 */
export function buildSetupContext(
  def: NormalizedAppDefinition,
  resources: Map<string, unknown>,
): AppSetupContext {
  return {
    ...buildRuntimeContext(def, resources),
    routes: (register: () => void) => register(),
    resolve: <T>(Target: new (...args: never[]) => T) => resolveTarget(def.name, Target),
  }
}
