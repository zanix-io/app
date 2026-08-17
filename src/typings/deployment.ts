/**
 * Cross-process routing target for one app — pure data, no I/O. `AppContainer`'s in-process
 * `applicationMountRegistry` (owned by `@zanix/server`) already answers "where does `name` mount
 * inside THIS process"; `DeploymentTarget` answers the broader question once an app can also run
 * as its own process — where the Control Plane's Registry (`@zanix/app/runtime`) and, later, the
 * Gateway resolve `ctx.remote(name)` against.
 *
 * @module
 */

/** An app running inside the same process as its caller — the only mode Zanix Apps had before a
 * cross-process Control Plane existed. Resolved from the local `applicationMountRegistry`, never
 * from Redis. */
export interface EmbeddedDeploymentTarget {
  /** Discriminant — always `'embedded'` for this variant. */
  mode: 'embedded'
  /** Same value `getApplicationMountPrefix` already returns for this app. */
  mountPrefix: string
}

/** An app running as its own process, discovered through the Control Plane's Registry. */
export interface RemoteDeploymentTarget {
  /** Discriminant — always `'remote'` for this variant. */
  mode: 'remote'
  /** Routing prefix shared by every replica of this app — namespacing is per-app, not
   * per-instance. */
  prefix: string
  /** Currently live replica endpoints, as observed by the Registry right now — never a
   * declared/expected count (see `runtime.replicas` in the manifest for that). Empty only in the
   * instant between two live replicas' leases expiring and a fresh one renewing; callers that see
   * an empty array should treat the app as momentarily undiscoverable, not as an error. */
  endpoints: string[]
}

/** Where a request for `name` should actually go — `'embedded'` (in-process mount) or
 * `'remote'` (its own process, possibly replicated). */
export type DeploymentTarget =
  | EmbeddedDeploymentTarget
  | RemoteDeploymentTarget
