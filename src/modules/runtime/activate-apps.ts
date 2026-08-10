import type {
  AppDefinition,
  NormalizedAppDefinition,
  ResourceBinding,
  RootResources,
} from 'typings/manifest.ts'
import { buildGraph, normalize, validate } from 'modules/manifest/mod.ts'
import { isZanixAppDefinition, type ZanixAppDefinition } from 'modules/manifest/mod.ts'
import { registerApp } from './app-container.ts'
import { ResourceRegistry } from './resource-registry.ts'
import { resolveResources } from './resolve-resources.ts'
import { runOnStart, runOnStop } from './lifecycle.ts'

/**
 * Everything {@link activateApps} produced — enough for {@link deactivateApps} to shut the same
 * set of apps back down without the caller re-deriving or re-passing anything.
 */
export interface ActivatedApps {
  /** The normalized apps that were activated, in the same order they were declared. */
  readonly apps: NormalizedAppDefinition[]
  /** The shared `Map<`${appName}:${slot}`, instance>` every app's resources resolved into —
   * still open; only {@link deactivateApps} closes it. */
  readonly resources: Map<string, unknown>
  /** The registry that owns `resources`' construction/close lifecycle. */
  readonly registry: ResourceRegistry
}

/**
 * Wires the reference sequence for composing a set of Zanix Apps into the running process —
 * `normalize → buildGraph → validate → resolveResources → registerApp` (sequentially, in
 * declaration order — never concurrently, since every call mutates the same process-wide route/
 * DI/job registries) `→ runOnStart` (across every app). Every step here is one of this package's
 * own already-tested primitives; this function adds no logic of its own beyond calling them in
 * the one correct order, so whoever composes a full set of apps (today: nobody yet: this is meant
 * for `@zanix/core`'s own `Zanix.start()` once it processes `apps` through `defineZanixApp`
 * manifests instead of only its current file-based auto-discovery) never has to re-derive it by
 * hand.
 *
 * Still NOT this function's job: deciding what triggers a re-activation, or loading `rootDir`/
 * `package` manifest files (see `registerApp`'s own doc) — this only composes an already-given
 * list of apps.
 *
 * @param defs Every app to activate, in the order they should register — either the raw
 * `AppDefinition` shape (normalized here) or `defineZanixApp()`'s own return value (already
 * normalized; used as-is, via {@link isZanixAppDefinition}, never re-normalized).
 * @param rootResources The host's own root-level resources (`SetupOptions.resources`, once a host
 * exposes one) — defaults to none.
 * @param bindings The host's `uses` bindings, resolving each app's `dependencies` slot to a
 * concrete root/local resource — defaults to none.
 * @throws {InternalError} (from `validate()`) if any app's contract is violated, BEFORE
 * constructing or registering anything.
 */
export async function activateApps(
  defs: (AppDefinition | ZanixAppDefinition)[],
  rootResources: RootResources = {},
  bindings: ResourceBinding[] = [],
): Promise<ActivatedApps> {
  const apps = defs.map((def) => isZanixAppDefinition(def) ? def.definition : normalize(def))
  const graph = buildGraph(apps, rootResources, bindings)
  validate(graph)

  const registry = new ResourceRegistry()
  const resources = await resolveResources(graph, registry)

  for (const def of apps) {
    // deno-lint-ignore no-await-in-loop
    await registerApp(def, resources)
  }

  await runOnStart(apps, resources)

  return { apps, resources, registry }
}

/**
 * The exact reverse of {@link activateApps}: `runOnStop` (across every app, while `resources` is
 * still open) `→ registry.close()` (only once every `onStop` has settled) — same ordering
 * guarantee `runOnStop`'s own doc already documents, just applied to the whole set activated
 * together.
 *
 * @param activated Whatever {@link activateApps} returned for this same set of apps.
 * @throws {AggregateError} (from `runOnStop`) if one or more `onStop` handlers failed — `resources`
 * are still closed regardless, in `finally`-equivalent fashion.
 */
export async function deactivateApps(activated: ActivatedApps): Promise<void> {
  try {
    await runOnStop(activated.apps, activated.resources)
  } finally {
    await activated.registry.close()
  }
}
