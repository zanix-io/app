/**
 * Control Plane — Redis-backed remote app discovery (`ControlPlaneRegistry`) and
 * hot-refresh, non-secret config (`ControlPlaneConfig`). These two classes are the standalone
 * primitives the Gateway (`createGatewayPreHandler`), `ctx.remote()`'s `HttpRemoteAdapter`, and
 * the distributed lifecycle wiring (`announceRemoteInstance`/`activateApps`) all build on.
 *
 * @module
 */
export { ControlPlaneRegistry } from './registry.ts'
export { ControlPlaneConfig } from './config-plane.ts'
export { LeaderElection } from './leader-election.ts'
export type { ConfigSubscription, RegisteredInstance, RegisterInstanceOptions } from './types.ts'
export { resolveControlPlaneProvider, ZanixControlPlaneProvider } from './provider.ts'
