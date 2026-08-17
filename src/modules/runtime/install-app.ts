import type { AppDefinition, ResourceBinding, RootResources } from 'typings/manifest.ts'
import { buildGraph, isZanixAppDefinition, normalize, validate } from 'modules/manifest/mod.ts'
import type { ZanixAppDefinition } from 'modules/manifest/mod.ts'
import { InternalError } from '@zanix/errors'
import type { ActivatedApps } from './activate-apps.ts'
import { registerApp } from './app-container.ts'
import { resolveResources } from './resolve-resources.ts'
import { runOnStart } from './lifecycle.ts'
import { HttpRemoteAdapter } from './http-remote-adapter.ts'
import { resolveControlPlaneProvider } from './control-plane/mod.ts'
import { announceRemoteInstance, type RemoteInstanceOptions } from './remote-lifecycle.ts'

/** Options for hot-installing one app via {@link installApp} — everything {@link activateApps}
 * itself takes per-batch, narrowed to what a SINGLE new app might need to add. */
export interface InstallAppOptions {
  /** New root-level resources this app needs that no earlier app already introduced — merged
   * into the batch's existing `rootResources`. Never used to redefine a key an earlier app
   * already resolved against (those stay exactly as they were; nothing about an already-active
   * app is ever recomputed by installing another one). */
  rootResources?: RootResources
  /** `uses` bindings for this app's OWN `dependencies` slots — same shape `activateApps`'
   * `bindings` takes, scoped to just this app (a binding naming a different `appName` is ignored,
   * since `buildGraph` already filters by `appName`). */
  bindings?: ResourceBinding[]
  /** Announce this app to the Control Plane Registry after its own `onStart` completes — same
   * timing/shape as `activateApps`' own `remoteInstances` entry for one app. Omit to activate it
   * purely embedded (or remote-served by something else entirely). */
  remoteInstance?: RemoteInstanceOptions
  /**
   * Caps how many DISTINCT resource instances this app may hold a reference to at once —
   * multi-tenancy isolation already works today by installing
   * the same app definition under a distinct name per tenant (e.g. `billing-acme`,
   * `billing-globex` — resources/config/routes/rate-limiting all already scope by app name, zero
   * new mechanism needed for that). What a HOST installing a possibly-untrusted tenant's app
   * genuinely can't get elsewhere is a hard ceiling on shared infrastructure consumption (Mongo
   * connections, Redis pools, ...) — see `ResourceRegistry.setQuota`'s own doc for exact semantics
   * (counts distinct `qualifiedKey`s referenced, including shared root resources, not construction
   * events). Omit for unlimited (today's default, unchanged for any existing caller).
   */
  maxResources?: number
}

/**
 * Hot-installs ONE additional app into an already-activated, already-running batch, scoped for
 * this iteration to routes + resources + operations. Composes
 * the SAME sequence `activateApps` uses for a whole batch (`buildGraph → validate →
 * resolveResources → registerApp → runOnStart`), but validated against the FULL merged graph
 * (every already-active app plus this new one — cheap and pure, so re-running it in full is
 * simpler and safer than trying to validate only the delta) while only RESOLVING/REGISTERING the
 * new app itself — every other app's own routes/resources/lifecycle are untouched.
 *
 * Deliberately out of scope for this iteration: the new app's `jobs`/`events` ARE namespaced into
 * job/cron metadata by the same
 * `registerApp` this calls, but an already-running AsyncMQ worker/cron provider snapshots that
 * metadata once at its own construction and never re-reads it — so a hot-installed app's jobs
 * simply never run until the next full process restart. Not a silent gap: this is the documented
 * v1 boundary.
 *
 * Serving this app's routes (if its manifest implies any) is still the caller's own job, exactly
 * like `activateApps` never serves either — call `bootstrapAppServer(def.name, server, false)`
 * with the returned `ActivatedApps` in hand, same as any other app.
 *
 * @param activated Whatever `activateApps` (or a previous `installApp`/`uninstallApp` call)
 * returned for the batch this new app joins.
 * @param def The app to install — raw `AppDefinition` (normalized here) or `defineZanixApp()`'s
 * own return value (used as-is).
 * @param options See {@link InstallAppOptions}.
 * @throws {InternalError} `APP_ALREADY_INSTALLED` if `def.name` is already active in `activated`.
 * @throws {InternalError} (from `validate()`) if the new app's contract is violated, OR if adding
 * it breaks an existing app's own contract (e.g. a `requiredVersion` now failing against this
 * app's own `version`) — thrown BEFORE resolving or registering anything, same fail-fast guarantee
 * `activateApps` itself gives for a whole batch.
 * @throws {InternalError} (from `ResourceRegistry.resolve`) `RESOURCE_QUOTA_EXCEEDED` if
 * `options.maxResources` is given and this app's own resources need more distinct instances than
 * that ceiling allows.
 * @returns A new `ActivatedApps` — the input `activated` is never mutated in place.
 */
export async function installApp(
  activated: ActivatedApps,
  def: AppDefinition | ZanixAppDefinition,
  options: InstallAppOptions = {},
): Promise<ActivatedApps> {
  const normalized = isZanixAppDefinition(def) ? def.definition : normalize(def)

  if (activated.apps.some((app) => app.name === normalized.name)) {
    throw new InternalError(
      `Zanix App "${normalized.name}" is already active in this process — uninstall it first.`,
      {
        code: 'APP_ALREADY_INSTALLED',
        meta: { source: 'zanix', appName: normalized.name },
      },
    )
  }

  const rootResources = {
    ...activated.rootResources,
    ...options.rootResources,
  }
  const bindings = [...activated.bindings, ...(options.bindings ?? [])]
  const apps = [...activated.apps, normalized]

  const graph = buildGraph(apps, rootResources, bindings)
  validate(graph)

  if (options.maxResources !== undefined) {
    activated.registry.setQuota(normalized.name, options.maxResources)
  }

  // Only this app's own `${appName}:${slot}` entries — every already-active app's qualifiedKey
  // was already resolved (and, if shared, already memoized in `activated.registry`); handing
  // `resolveResources` the full graph's `resolvedKeys` would just re-resolve everyone else's for
  // no reason (`registry.resolve` would return the same memoized promise, but at the cost of
  // re-registering `ownerApp` needlessly and re-touching remote resources for no reason).
  const deltaKeys = new Map(
    [...graph.resolvedKeys].filter(([appSlotKey]) => appSlotKey.startsWith(`${normalized.name}:`)),
  )
  const deltaResources = await resolveResources(
    { ...graph, resolvedKeys: deltaKeys },
    activated.registry,
    activated.dispatcher,
  )

  const resources = new Map(activated.resources)
  for (const [key, value] of deltaResources) resources.set(key, value)

  await registerApp(normalized, resources, activated.remoteCaller)
  await runOnStart([normalized], resources, activated.remoteCaller)

  const announced = [...activated.announced]
  if (options.remoteInstance) {
    const provider = resolveControlPlaneProvider()
    const registry = activated.dispatcher instanceof HttpRemoteAdapter
      ? activated.dispatcher.registry
      : provider?.controlPlaneRegistry
    if (!registry) {
      throw new InternalError(
        `options.remoteInstance was given for "${normalized.name}", but no ControlPlaneRegistry ` +
          "could be resolved — pass an HttpRemoteAdapter as this batch's dispatcher, or import " +
          "'@zanix/app/core'.",
        {
          code: 'CONTROL_PLANE_NOT_CONFIGURED',
          meta: { source: 'zanix', appName: normalized.name },
        },
      )
    }
    announced.push(
      await announceRemoteInstance(
        normalized,
        options.remoteInstance,
        registry,
        provider?.controlPlaneConfig,
      ),
    )
  }

  return {
    apps,
    resources,
    registry: activated.registry,
    remoteCaller: activated.remoteCaller,
    announced,
    rootResources,
    bindings,
    dispatcher: activated.dispatcher,
  }
}
