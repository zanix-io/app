import type { NormalizedAppDefinition, ResourceBinding, RootResources } from 'typings/manifest.ts'
import type { HttpRemoteDispatcher, RemoteCallerFactory } from './remote-caller.ts'
import type { ResourceRegistry } from './resource-registry.ts'

/**
 * Pure result shapes for {@link activateApps}/{@link announceRemoteInstance} — split out of
 * `activate-apps.ts`/`remote-lifecycle.ts` (where each function itself lives) so `.`'s own
 * `mod.ts` can re-export them without resolving either file's real, heavy value-level imports
 * (`control-plane/mod.ts`, `http-remote-adapter.ts`). Every type this file itself imports is
 * already narrow (`remote-caller.ts`/`resource-registry.ts`/`typings/manifest.ts` carry no
 * `npm:`-backed dependency of their own) — a type-only import still makes Deno resolve the target
 * module's full specifier graph (only the type itself is erased at build time), so a type living
 * next to a heavy implementation, rather than beside its own narrow dependencies, still
 * materializes that implementation's whole graph for anything that imports the type alone.
 *
 * @module
 */

/**
 * Everything {@link activateApps} produced — enough for {@link deactivateApps} to shut the same
 * set of apps back down without the caller re-deriving or re-passing anything, and enough for
 * `installApp`/`uninstallApp` (hot install/uninstall) to extend or shrink this same set later,
 * against a still-running process, without re-deriving `rootResources`/`bindings` either.
 */
export interface ActivatedApps {
  /** The normalized apps that were activated, in the same order they were declared. */
  readonly apps: NormalizedAppDefinition[]
  /** The shared `Map<`${appName}:${slot}`, instance>` every app's resources resolved into —
   * still open; only {@link deactivateApps} closes it. */
  readonly resources: Map<string, unknown>
  /** The registry that owns `resources`' construction/close lifecycle. */
  readonly registry: ResourceRegistry
  /** The `ctx.remote` factory every activated app's context was built with — {@link
   * deactivateApps} reuses it so `onStop` gets the exact same `ctx.remote` `onStart` did. */
  readonly remoteCaller: RemoteCallerFactory
  /** Every instance announced to the Control Plane via `remoteInstances` — {@link deactivateApps}
   * stops (deregisters) each of these BEFORE running `onStop`. Empty if `remoteInstances` was
   * never given. */
  readonly announced: AnnouncedRemoteInstance[]
  /** The exact `rootResources` this batch was composed against — `installApp` merges a new app's
   * own additions into this same object rather than starting from an empty one, so a hot-installed
   * app can still resolve to a root resource an EARLIER app already shares. */
  readonly rootResources: RootResources
  /** The exact `bindings` (host `uses`) this batch was composed against — same reuse reasoning as
   * `rootResources`. */
  readonly bindings: ResourceBinding[]
  /** The dispatcher every activated app's `mode: 'remote'` resources resolve through — `installApp`
   * passes this straight to `resolveResources` for the new app's own delta, unchanged. */
  readonly dispatcher: HttpRemoteDispatcher | undefined
}

/** What {@link announceRemoteInstance} returns — everything {@link deactivateApps} needs to
 * cleanly reverse the announcement, symmetric with how it was made. */
export interface AnnouncedRemoteInstance {
  /** The app this announcement belongs to. */
  appName: string
  /** The identity this instance registered under — either `options.instanceId` or the
   * randomly-generated one, if none was given. */
  instanceId: string
  /** Stops the heartbeat, closes the Config Plane subscription (if any), and deregisters this
   * instance — best-effort: a deregistration failure is swallowed, never thrown, since the
   * process is already tearing down regardless (same reasoning `ResourceRegistry.close()` and
   * `runOnStop` already apply). */
  stop(): Promise<void>
}
