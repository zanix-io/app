import type {
  DependencyGraph,
  NormalizedAppDefinition,
  ResolvedResourceKey,
  ResourceBinding,
  RootResources,
} from 'typings/manifest.ts'

/**
 * Resolves one `(appName, slot)` pair to its fully-qualified key. Order:
 * 1. An explicit host `uses.<slot>` binding (a {@link ResourceBinding} for this app+slot) wins —
 *    resolved against that app's OWN `localResources` first, then `rootResources`.
 * 2. No binding: falls back to a local resource declared under the SAME name as `slot` (an app
 *    shadowing its own dependency slot needs no explicit `uses` at all).
 * 3. Still nothing: falls back to a root resource under the same name as `slot` (the shared
 *    default every app that doesn't override it gets).
 * 4. Still nothing: auto-bind — if EXACTLY ONE root resource's `type` matches
 *    `dependencies.<slot>.type`, infer the binding (ergonomics only; never weakens validation —
 *    zero or MORE than one match still falls through to step 5 unresolved, same as today,
 *    requiring an explicit `uses` fail-fast via `validate()`). Never considered when an explicit
 *    `uses.<slot>` binding was given but failed to resolve (step 1's own `undefined` branch) —
 *    a host that named something that doesn't exist gets a real error, never a silent guess.
 * 5. Unresolved — `undefined`. Whether that's an error depends on `dependencies.<slot>.required`,
 *    checked by `validate()`, not here (this function only resolves, never judges).
 */
function resolveKey(
  app: NormalizedAppDefinition,
  slot: string,
  bindings: ResourceBinding[],
  rootResources: RootResources,
): ResolvedResourceKey | undefined {
  const binding = bindings.find((b) => b.appName === app.name && b.slot === slot)

  if (binding) {
    const local = app.localResources[binding.resourceName]
    if (local) {
      return {
        qualifiedKey: `${app.name}:${binding.resourceName}`,
        type: local.type,
        options: local.options,
        ownerApp: app.name,
      }
    }
    const root = rootResources[binding.resourceName]
    if (root) {
      return {
        qualifiedKey: binding.resourceName,
        type: root.type,
        options: root.options,
        ownerApp: null,
      }
    }
    return undefined
  }

  const localBySlot = app.localResources[slot]
  if (localBySlot) {
    return {
      qualifiedKey: `${app.name}:${slot}`,
      type: localBySlot.type,
      options: localBySlot.options,
      ownerApp: app.name,
    }
  }

  const rootBySlot = rootResources[slot]
  if (rootBySlot) {
    return {
      qualifiedKey: slot,
      type: rootBySlot.type,
      options: rootBySlot.options,
      ownerApp: null,
    }
  }

  const dependencyType = app.dependencies[slot]?.type
  const matchingRootEntries = dependencyType
    ? Object.entries(rootResources).filter(([, resource]) => resource.type === dependencyType)
    : []
  if (matchingRootEntries.length === 1) {
    const [resourceName, resource] = matchingRootEntries[0]
    return {
      qualifiedKey: resourceName,
      type: resource.type,
      options: resource.options,
      ownerApp: null,
    }
  }

  return undefined
}

/**
 * Assembles the {@link DependencyGraph} — apps + root resources + host bindings + every
 * `${appName}:${slot}` resolved to its qualified key (see {@link resolveKey}). Purely
 * assembles — does NOT validate (that's `validate()`'s own, separate job, operating on this
 * graph as one canonical object instead of every rule re-parsing manifests/`uses`/`resources` on
 * its own).
 */
export function buildGraph(
  apps: NormalizedAppDefinition[],
  rootResources: RootResources,
  bindings: ResourceBinding[],
): DependencyGraph {
  const appsMap = new Map(apps.map((app) => [app.name, app]))
  const resolvedKeys = new Map<string, ResolvedResourceKey>()

  for (const app of apps) {
    for (const slot of Object.keys(app.dependencies)) {
      const resolved = resolveKey(app, slot, bindings, rootResources)
      if (resolved) resolvedKeys.set(`${app.name}:${slot}`, resolved)
    }
  }

  return { apps: appsMap, rootResources, bindings, resolvedKeys }
}
