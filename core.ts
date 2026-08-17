/**
 * `@zanix/app/core` — zero-config Control Plane wiring, same category as
 * `@zanix/datamaster/core`/`@zanix/auth/core`. Side-effect-only: importing this registers
 * `ZanixControlPlaneProvider` under the `'controlPlane'` core-provider slot, which
 * `activateApps()` (from `@zanix/app/runtime`) auto-detects to resolve remote `ctx.remote()` calls
 * over real HTTP — without it, `ctx.remote()` stays local-only, at zero cost.
 *
 * ```ts
 * import '@zanix/app/core'
 * ```
 *
 * @module
 */
import 'modules/runtime/control-plane/core.ts'

export {
  /** Redis-backed Config Plane half of the Control Plane — hot-refresh of non-secret app config
   * via Redis Pub/Sub, no polling. */
  ControlPlaneConfig,
  /** Redis-backed Registry half of the Control Plane — the only place a `remote` app's live
   * endpoints are recorded, and the only place `ctx.remote()`/the Gateway will read them from. */
  ControlPlaneRegistry,
  /** Redis-backed leader election for scheduled jobs (Redis SETNX+EX). */
  LeaderElection,
  /** Resolves the `'controlPlane'` core-provider slot, or `undefined` (never throws) if
   * `@zanix/app/core` was never imported. */
  resolveControlPlaneProvider,
  /** DI-resolvable Control Plane — the idiomatic way to reach `ControlPlaneRegistry`/
   * `ControlPlaneConfig`/`LeaderElection` from anywhere in a Zanix service. */
  ZanixControlPlaneProvider,
} from 'modules/runtime/control-plane/mod.ts'
export type {
  /** Handle returned by `ControlPlaneConfig.subscribeConfig` — stops listening for further
   * updates and releases the dedicated Pub/Sub connection it opened. */
  ConfigSubscription,
  /** One live replica's registration data — the value stored under one instance key in Redis. */
  RegisteredInstance,
  /** Options accepted by `ControlPlaneRegistry.registerInstance`. */
  RegisterInstanceOptions,
} from 'modules/runtime/control-plane/mod.ts'
export type {
  /** An app running as its own process, discovered through the Control Plane's Registry. */
  RemoteDeploymentTarget,
} from 'typings/deployment.ts'
