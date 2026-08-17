import type { DependencyGraph } from 'typings/manifest.ts'
import { InternalError } from '@zanix/errors'
import { parse, parseRange, satisfies } from '@std/semver'

/**
 * Validates a full {@link DependencyGraph} — one aggregated pass, fail-fast, BEFORE anything is
 * constructed. Every rule reads the graph, never re-parses a manifest/`uses`/`resources` on its
 * own.
 *
 * Covers five cases, in this order:
 * 1. A `uses`/local `resources` key outside the app's own `dependencies` — a resource declared
 *    without a corresponding `dependencies` entry for that slot.
 * 2. A required dependency with no resolved key at all (no `uses`, no local `resources` under the
 *    slot's own name).
 * 3. A resolved key whose `type` doesn't match what the app's `dependencies` declared for that
 *    slot.
 * 4. A `mode: 'remote'` resolved key whose `requiredVersion` the target app's OWN `version`
 *    doesn't satisfy — checked ONLY
 *    when the target app is ALSO part of THIS SAME graph (`graph.apps`) and DID declare a
 *    `version`; skipped silently otherwise (see {@link RemoteResourceDeclaration.requiredVersion}'s
 *    own doc for why an actually cross-process target can't be checked here at all).
 *
 * @throws {InternalError} on the FIRST violation found — this function does not collect every
 * error in the graph, it aborts fail-fast on the first one: abort startup completely rather than
 * continue with a partially-invalid graph.
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
          {
            code: 'UNDECLARED_RESOURCE',
            meta: { source: 'zanix', appName, key },
          },
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
            {
              code: 'MISSING_REQUIRED_DEPENDENCY',
              meta: { source: 'zanix', appName, slot },
            },
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

      if (resolved.mode === 'remote' && resolved.requiredVersion) {
        const targetVersion = graph.apps.get(resolved.endpoint)?.version
        if (targetVersion) {
          checkRemoteResourceVersion(
            appName,
            slot,
            resolved.endpoint,
            resolved.requiredVersion,
            targetVersion,
          )
        }
      }
    }
  }
}

/**
 * The one place {@link RemoteResourceDeclaration.requiredVersion} actually gets checked — pulled
 * out of {@link validate}'s own loop only for readability; still part of the SAME fail-fast pass,
 * never a separate step a caller could skip.
 * @throws {InternalError} `INVALID_VERSION_RANGE` if either version string itself doesn't parse as
 * semver — an author error in the manifest, not a real cross-app mismatch.
 * @throws {InternalError} `REMOTE_RESOURCE_VERSION_MISMATCH` if both parse but don't satisfy.
 */
function checkRemoteResourceVersion(
  appName: string,
  slot: string,
  endpoint: string,
  requiredVersion: string,
  targetVersion: string,
): void {
  let satisfiesRange: boolean
  try {
    satisfiesRange = satisfies(
      parse(targetVersion),
      parseRange(requiredVersion),
    )
  } catch (error) {
    throw new InternalError(
      `Zanix App "${appName}": "dependencies.${slot}" declares "requiredVersion: ` +
        `${JSON.stringify(requiredVersion)}" for "${endpoint}", but either that range or ` +
        `"${endpoint}"'s own "version" ("${targetVersion}") isn't valid semver.`,
      {
        code: 'INVALID_VERSION_RANGE',
        cause: error,
        meta: {
          source: 'zanix',
          appName,
          slot,
          endpoint,
          requiredVersion,
          targetVersion,
        },
      },
    )
  }

  if (!satisfiesRange) {
    throw new InternalError(
      `Zanix App "${appName}": "dependencies.${slot}" requires "${endpoint}" to satisfy version ` +
        `"${requiredVersion}", but its actual declared version is "${targetVersion}".`,
      {
        code: 'REMOTE_RESOURCE_VERSION_MISMATCH',
        meta: {
          source: 'zanix',
          appName,
          slot,
          endpoint,
          requiredVersion,
          targetVersion,
        },
      },
    )
  }
}
