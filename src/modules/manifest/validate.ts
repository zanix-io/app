import type { DependencyGraph } from 'typings/manifest.ts'
import { InternalError } from '@zanix/errors'

/**
 * Validates a full {@link DependencyGraph} — one aggregated pass, fail-fast, BEFORE anything is
 * constructed. Every rule reads the graph, never re-parses a manifest/`uses`/`resources` on its
 * own.
 *
 * Covers four cases, in this order:
 * 1. A `uses`/local `resources` key outside the app's own `dependencies` ("recurso no
 *    declarado" / "`uses` sin `dependencies` correspondiente" — same check, two names in the
 *    design doc for the same rule).
 * 2. A required dependency with no resolved key at all (no `uses`, no local `resources` under the
 *    slot's own name).
 * 3. A resolved key whose `type` doesn't match what the app's `dependencies` declared for that
 *    slot.
 *
 * @throws {InternalError} on the FIRST violation found — this function does not collect every
 * error in the graph, it aborts fail-fast on the first one (consistent with "Rollback en
 * startup": abort completely rather than continue with a partially-invalid graph).
 */
export function validate(graph: DependencyGraph): void {
  for (const [appName, app] of graph.apps) {
    const declaredSlots = new Set(Object.keys(app.dependencies))

    for (const key of Object.keys(app.localResources)) {
      if (!declaredSlots.has(key)) {
        throw new InternalError(
          `Zanix App "${appName}" declares a local resource "${key}" that is not listed in its ` +
            `own "dependencies" — an app can only declare local resources for slots it itself ` +
            `declared needing.`,
          { code: 'UNDECLARED_RESOURCE', meta: { source: 'zanix', appName, key } },
        )
      }
    }

    for (const binding of graph.bindings) {
      if (binding.appName !== appName) continue
      if (!declaredSlots.has(binding.slot)) {
        throw new InternalError(
          `Host declares "uses.${binding.slot}" for app "${appName}", but that app's manifest ` +
            `never listed "${binding.slot}" in its own "dependencies".`,
          {
            code: 'UNKNOWN_DEPENDENCY_SLOT',
            meta: { source: 'zanix', appName, slot: binding.slot },
          },
        )
      }
    }

    for (const [slot, dep] of Object.entries(app.dependencies)) {
      const resolved = graph.resolvedKeys.get(`${appName}:${slot}`)

      if (!resolved) {
        if (dep.required) {
          throw new InternalError(
            `Zanix App "${appName}" requires "dependencies.${slot}" (type "${dep.type}") but no ` +
              `"uses.${slot}" binding nor a local "resources.${slot}" was provided.`,
            { code: 'MISSING_REQUIRED_DEPENDENCY', meta: { source: 'zanix', appName, slot } },
          )
        }
        continue
      }

      if (resolved.type !== dep.type) {
        throw new InternalError(
          `Zanix App "${appName}": "dependencies.${slot}" declares type "${dep.type}", but the ` +
            `resource it resolved to ("${resolved.qualifiedKey}") is type "${resolved.type}".`,
          {
            code: 'DEPENDENCY_TYPE_MISMATCH',
            meta: {
              source: 'zanix',
              appName,
              slot,
              expectedType: dep.type,
              actualType: resolved.type,
              qualifiedKey: resolved.qualifiedKey,
            },
          },
        )
      }
    }
  }
}
