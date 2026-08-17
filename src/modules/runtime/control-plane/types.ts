/** One live replica's registration data — the value stored under one instance key in Redis, never
 * the aggregated `RemoteDeploymentTarget` that `ControlPlaneRegistry.getDeploymentTarget` merges
 * these into across every currently-live instance of one app. */
export interface RegisteredInstance {
  /** Shared by every replica of this app — see `RemoteDeploymentTarget.prefix`. */
  prefix: string
  /** This specific replica's address (host:port or full URL) — what
   * `HttpRemoteAdapter` calls directly. */
  endpoint: string
}

/** Options accepted by `ControlPlaneRegistry.registerInstance`. */
export interface RegisterInstanceOptions {
  /** Seconds before this registration expires if never renewed again. Defaults to `30`. */
  leaseTtlSeconds?: number
}

/** Handle returned by `ControlPlaneConfig.subscribeConfig` — stops listening for further updates
 * and releases the dedicated Pub/Sub connection it opened. */
export interface ConfigSubscription {
  /** Unsubscribes from every channel this subscription opened and closes the dedicated
   * connection. Never called automatically — the caller owns this handle's lifecycle. */
  close(): Promise<void>
}
