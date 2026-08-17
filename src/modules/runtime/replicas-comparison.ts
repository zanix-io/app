import type { NormalizedAppDefinition } from 'typings/manifest.ts'
import type { ControlPlaneRegistry } from './control-plane/mod.ts'

/** What {@linkcode compareReplicas} returns. */
export interface ReplicasComparison {
  /** `def.runtime.replicas` as declared in the manifest — `null` if the author never declared
   * one. `runtime.replicas` is only ever the author's own DEFAULT suggestion,
   * never something Zanix enforces or acts on by itself. */
  declared: number | null
  /** How many live instances of this app the Control Plane Registry currently reports — `0` if
   * none are registered at all, never `undefined`, so a caller never has to null-check this side. */
  observed: number
  /** `true` whenever there's nothing to compare (`declared === null`) or `declared === observed`;
   * `false` otherwise. Never itself a judgment of "healthy"/"unhealthy" — a deploy mid-rollout is
   * expected to mismatch briefly; what a caller does with `false` (log, alert, page) is entirely
   * up to it. */
  matches: boolean
}

/**
 * Compares a manifest's own `runtime.replicas` against what the Control Plane Registry actually
 * observes right now. Purely a
 * diagnostic/observability signal, never enforcement: this function never starts, stops, or
 * otherwise acts on a replica count mismatch — Zanix Distributed Apps Runtime doesn't reimplement
 * a cloud provider's scheduler. A host
 * wires the result into whatever it already uses for alerting (`@zanix/notifications`, a health
 * endpoint, a log line) — this function's only job is producing the two numbers to compare.
 *
 * @param def The app to check — `def.name` is what's looked up in the Registry.
 * @param registry Where live instances are actually recorded — the SAME `ControlPlaneRegistry` a
 * host's `HttpRemoteAdapter`/`announceRemoteInstance` already use.
 */
export async function compareReplicas(
  def: NormalizedAppDefinition,
  registry: ControlPlaneRegistry,
): Promise<ReplicasComparison> {
  const target = await registry.getDeploymentTarget(def.name)
  const observed = target?.endpoints.length ?? 0
  const declared = def.runtime.replicas

  return {
    declared,
    observed,
    matches: declared === null || declared === observed,
  }
}
