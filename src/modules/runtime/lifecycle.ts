import type { NormalizedAppDefinition } from 'typings/manifest.ts'
import { buildRuntimeContext } from './build-runtime-context.ts'

/**
 * Runs every app's `onStart(ctx)`, SEQUENTIALLY, in declaration order (`defs`' own array order)
 * — never in parallel. Two apps sharing the same resource (`uses.database` pointing at the same
 * root resource) could step on each other if their `onStart` ran concurrently; determinism over
 * speed for a boot sequence that must land in a reproducible state. If one `onStart` throws, this
 * aborts immediately — every app before it in the array already completed its own, every app
 * after it never runs.
 *
 * @param defs Every app being started, in the exact order they should run.
 * @param resources The shared resolved-resources map from `resolveResources()`.
 */
export async function runOnStart(
  defs: NormalizedAppDefinition[],
  resources: Map<string, unknown>,
): Promise<void> {
  for (const def of defs) {
    if (!def.onStart) continue
    // deno-lint-ignore no-await-in-loop
    await def.onStart(buildRuntimeContext(def, resources))
  }
}

/**
 * Runs every app's `onStop(ctx)`, IN PARALLEL (`Promise.allSettled`) — the opposite of
 * `runOnStart`'s sequencing, deliberately: the process is going down regardless, so completing
 * the most cleanup possible matters more than a reproducible order. One app's `onStop` throwing
 * never stops another's from running.
 *
 * Resources are still open while this runs — whoever calls this is expected to call
 * `ResourceRegistry.close()` only AFTER this resolves, never before (see `ResourceRegistry`'s own
 * doc on `close()` timing); this function itself never touches the registry.
 *
 * @param defs Every app being stopped — order doesn't matter, since this runs them concurrently.
 * @param resources The shared resolved-resources map from `resolveResources()` — still valid;
 * not yet closed.
 * @throws {AggregateError} if one or more `onStop` handlers rejected/threw — every failure is
 * aggregated into a single error instead of only surfacing the first one.
 */
export async function runOnStop(
  defs: NormalizedAppDefinition[],
  resources: Map<string, unknown>,
): Promise<void> {
  const results = await Promise.allSettled(
    defs.map((def) => {
      const { onStop } = def
      // `Promise.resolve().then(...)` — not a direct call — because `onStop` isn't required to
      // be `async`; a SYNCHRONOUS throw from a plain function passed straight to `.map()` would
      // escape right here, before `Promise.allSettled` even runs, instead of becoming one of the
      // settled results it's supposed to catch.
      return Promise.resolve().then(() => onStop && onStop(buildRuntimeContext(def, resources)))
    }),
  )

  const errors = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason)

  if (errors.length) {
    throw new AggregateError(errors, `${errors.length} onStop() handler(s) failed.`)
  }
}
