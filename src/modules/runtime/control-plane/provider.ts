import { ProgramModule, ZanixProvider } from '@zanix/server'
import { ControlPlaneConfig } from './config-plane.ts'
import { ControlPlaneRegistry } from './registry.ts'
import { LeaderElection } from './leader-election.ts'
import type { ControlPlaneCacheModules } from '@zanix/datamaster/cache/types'

/**
 * DI-resolvable Control Plane — the idiomatic way to reach `ControlPlaneRegistry`/
 * `ControlPlaneConfig`/`LeaderElection` from anywhere in a Zanix service
 * (`this.providers.get('controlPlane')`, or `this.controlPlane` once a host's own base class
 * exposes it the same way `this.cache` already does), instead of constructing/threading a
 * connector by hand.
 *
 * Registered as the `'controlPlane'` core-provider slot ONLY when `@zanix/app/core` is imported
 * (see that module's own doc) — importing just `@zanix/app`/`@zanix/app/runtime` never registers
 * this, so a service that never opts in never pays for it.
 */
export class ZanixControlPlaneProvider extends ZanixProvider<{ cache: ControlPlaneCacheModules }> {
  #registry?: ControlPlaneRegistry
  #config?: ControlPlaneConfig
  #leaderElection?: LeaderElection

  // Named `controlPlaneRegistry`/`controlPlaneConfig`/`leaderElection`, not `registry`/`config` —
  // the latter two are already reserved, protected members of `CoreBaseClass` (the DI metadata
  // registry and the env/config accessor respectively); reusing them would silently shadow
  // framework internals.

  /** The Redis-backed remote app Registry — see `ControlPlaneRegistry`'s own doc. */
  public get controlPlaneRegistry(): ControlPlaneRegistry {
    if (!this.#registry) {
      this.#registry = new ControlPlaneRegistry(this.connectors.get('cache:redis'))
    }
    return this.#registry
  }

  /** The Redis-backed, hot-refresh Config Plane — see `ControlPlaneConfig`'s own doc. */
  public get controlPlaneConfig(): ControlPlaneConfig {
    if (!this.#config) this.#config = new ControlPlaneConfig(this.connectors.get('cache:redis'))
    return this.#config
  }

  /** Redis-backed leader election for scheduled jobs — see `LeaderElection`'s own doc. */
  public get leaderElection(): LeaderElection {
    if (!this.#leaderElection) {
      this.#leaderElection = new LeaderElection(this.connectors.get('cache:redis'))
    }
    return this.#leaderElection
  }
}

/**
 * Resolves the `'controlPlane'` core-provider slot, or `undefined` (never throws) if
 * `@zanix/app/core` was never imported — the one place this try/catch lives, shared by
 * `resolveDefaultDispatcher` (`http-remote-adapter.ts`) and `announceRemoteInstance`
 * (`remote-lifecycle.ts`) so both fall back identically.
 */
export function resolveControlPlaneProvider():
  | ZanixControlPlaneProvider
  | undefined {
  try {
    return ProgramModule.getProviders().get<ZanixControlPlaneProvider>(
      'controlPlane',
    )
  } catch {
    return undefined
  }
}
