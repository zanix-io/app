import type {
  AppDefinition,
  BehaviorOverride,
  NormalizedAppDefinition,
  ResourceBinding,
  RootResources,
} from 'typings/manifest.ts'
import { InternalError } from '@zanix/errors'
import { buildGraph, normalize, validate } from 'modules/manifest/mod.ts'
import { isZanixAppDefinition, type ZanixAppDefinition } from 'modules/manifest/mod.ts'
import { registerApp } from './app-container.ts'
import { ResourceRegistry } from './resource-registry.ts'
import { resolveResources } from './resolve-resources.ts'
import { runOnStart, runOnStop } from './lifecycle.ts'
import { setBehaviorOverride } from './behavior-registry.ts'
import { createRemoteCaller, type HttpRemoteDispatcher } from './remote-caller.ts'
import { HttpRemoteAdapter, resolveDefaultDispatcher } from './http-remote-adapter.ts'
import { resolveControlPlaneProvider } from './control-plane/mod.ts'
import { announceRemoteInstance, type RemoteInstanceOptions } from './remote-lifecycle.ts'
import type { ActivatedApps, AnnouncedRemoteInstance } from './activation-types.ts'

// `ActivatedApps` lives in `activation-types.ts`, not here — see that module's own doc for why:
// this file's own real value-level imports (`control-plane/mod.ts`, `http-remote-adapter.ts`)
// would otherwise be dragged into `.`'s (`mod.ts`) reachable graph by a bare `import type
// {ActivatedApps} from './activate-apps.ts'` — a type-only import still makes Deno resolve the
// imported module's full specifier graph (only the type itself is erased from the emitted
// output), so importing a type from a module with heavy real imports still materializes those
// imports' packages for anyone doing nothing more than importing the type. Re-exported here so
// every existing import of `ActivatedApps` FROM this file (this module's own return type,
// `modules/runtime/mod.ts`'s barrel) keeps working unchanged.
export type { ActivatedApps }

/**
 * Wires the reference sequence for composing a set of Zanix Apps into the running process —
 * `normalize → buildGraph → validate → resolveResources → registerApp` (sequentially, in
 * declaration order — never concurrently, since every call mutates the same process-wide route/
 * DI/job registries) `→ runOnStart` (across every app). Every step here is one of this package's
 * own already-tested primitives; this function adds no logic of its own beyond calling them in
 * the one correct order, so whoever composes a full set of apps (today: nobody yet: this is meant
 * for `@zanix/core`'s own `Zanix.start()` once it processes `apps` through `defineZanixApp`
 * manifests instead of only its current file-based auto-discovery) never has to re-derive it by
 * hand.
 *
 * Still NOT this function's job: deciding what triggers a re-activation, or loading `rootDir`/
 * `package` manifest files (see `registerApp`'s own doc) — this only composes an already-given
 * list of apps.
 *
 * @param defs Every app to activate, in the order they should register — either the raw
 * `AppDefinition` shape (normalized here) or `defineZanixApp()`'s own return value (already
 * normalized; used as-is, via {@link isZanixAppDefinition}, never re-normalized).
 * @param rootResources The host's own root-level resources (`SetupOptions.resources`, once a host
 * exposes one) — defaults to none.
 * @param bindings The host's `uses` bindings, resolving each app's `dependencies` slot to a
 * concrete root/local resource — defaults to none.
 * @param dispatcher Handles a `ctx.remote()` call whose target isn't running in this same process
 * — `HttpRemoteAdapter` in v1. Omitted (the default), this
 * auto-detects the `'controlPlane'` core-provider slot (registered only if `@zanix/app/core` was
 * imported — see that module's own doc) and uses it; if that slot was never registered either,
 * every `ctx.remote()` call in this batch resolves local-only, and a call to a genuinely absent
 * app throws a clear configuration error instead of silently doing nothing.
 * @param remoteInstances Keyed by `appName` — announces that app to the Control Plane Registry
 * AFTER its own local `onStart` completes.
 * Presence of an entry here IS the host's decision to run that app in `remote` mode for THIS
 * process (the manifest's own `runtime.mode` is only ever the author's default suggestion — see
 * `RuntimeModeOptions`'s own doc); an app never listed here is never announced, regardless of what
 * its manifest declares. Defaults to none — no app announced, no Control Plane write, at zero cost.
 * @param behaviors The host's own overrides for a target app's `behaviors` — see
 * {@link BehaviorDeclaration} for when an app declares one instead of a `resources` slot. Unlike
 * `bindings` (which names an alternative RESOURCE to resolve), each entry carries the replacement
 * implementation directly — there's no construction step to defer. Defaults to none — every
 * `ctx.behavior(name)` call then resolves to that app's own declared default, exactly as if this
 * parameter didn't exist.
 * @throws {InternalError} (from `validate()`) if any app's contract is violated, BEFORE
 * constructing or registering anything; (here) if `remoteInstances` names an app not present in
 * `defs`, if no `ControlPlaneRegistry` can be resolved (`dispatcher` isn't an `HttpRemoteAdapter`
 * and `@zanix/app/core` was never imported) while `remoteInstances` is non-empty, or if `behaviors`
 * names an app not present in `defs` or a behavior name that app never declared in its own
 * `behaviors` — same "fail fast, before anything is constructed" posture `validate()` already has
 * for `bindings`.
 */
export async function activateApps(
  defs: (AppDefinition | ZanixAppDefinition)[],
  rootResources: RootResources = {},
  bindings: ResourceBinding[] = [],
  dispatcher: HttpRemoteDispatcher | undefined = resolveDefaultDispatcher(),
  remoteInstances: Record<string, RemoteInstanceOptions> = {},
  behaviors: BehaviorOverride[] = [],
): Promise<ActivatedApps> {
  const apps = defs.map((def) => isZanixAppDefinition(def) ? def.definition : normalize(def))
  const graph = buildGraph(apps, rootResources, bindings)
  validate(graph)

  for (const override of behaviors) {
    const app = apps.find((candidate) => candidate.name === override.appName)
    if (!app) {
      throw new InternalError(
        `behaviors override names app "${override.appName}", which isn't in this activation's ` +
          `own list of apps.`,
        {
          code: 'UNKNOWN_BEHAVIOR_OVERRIDE_APP',
          meta: { source: 'zanix', appName: override.appName },
        },
      )
    }
    if (!(override.name in app.behaviors)) {
      throw new InternalError(
        `behaviors override names "${override.name}" for app "${override.appName}", which that ` +
          `app never declared in its own \`behaviors\`.`,
        {
          code: 'UNKNOWN_BEHAVIOR_OVERRIDE_NAME',
          meta: {
            source: 'zanix',
            appName: override.appName,
            name: override.name,
          },
        },
      )
    }
    setBehaviorOverride(
      override.appName,
      override.name,
      override.implementation,
    )
  }

  const registry = new ResourceRegistry()
  const resources = await resolveResources(graph, registry, dispatcher)
  const remoteCaller = createRemoteCaller(dispatcher)

  for (const def of apps) {
    // deno-lint-ignore no-await-in-loop
    await registerApp(def, resources, remoteCaller)
  }

  await runOnStart(apps, resources, remoteCaller)

  const announced = await announceConfiguredInstances(
    apps,
    remoteInstances,
    dispatcher,
  )

  return {
    apps,
    resources,
    registry,
    remoteCaller,
    announced,
    rootResources,
    bindings,
    dispatcher,
  }
}

/**
 * Announces every app named in `remoteInstances`, in declaration order — a no-op returning `[]`
 * if `remoteInstances` is empty (never resolves a `ControlPlaneRegistry`/`ControlPlaneConfig` in
 * that case, so a batch with no `remote` apps never touches the Control Plane at all).
 */
async function announceConfiguredInstances(
  apps: NormalizedAppDefinition[],
  remoteInstances: Record<string, RemoteInstanceOptions>,
  dispatcher: HttpRemoteDispatcher | undefined,
): Promise<AnnouncedRemoteInstance[]> {
  const entries = Object.entries(remoteInstances)
  if (!entries.length) return []

  const provider = resolveControlPlaneProvider()
  const registry = dispatcher instanceof HttpRemoteAdapter
    ? dispatcher.registry
    : provider?.controlPlaneRegistry
  if (!registry) {
    throw new InternalError(
      'remoteInstances was given, but no ControlPlaneRegistry could be resolved — pass an ' +
        "HttpRemoteAdapter as dispatcher, or import '@zanix/app/core'.",
      { code: 'CONTROL_PLANE_NOT_CONFIGURED', meta: { source: 'zanix' } },
    )
  }
  const configPlane = provider?.controlPlaneConfig

  const pairs = entries.map(([appName, options]) => {
    const def = apps.find((app) => app.name === appName)
    if (!def) {
      throw new InternalError(
        `remoteInstances declared "${appName}", but no such app was activated in this batch.`,
        {
          code: 'UNKNOWN_REMOTE_INSTANCE_APP',
          meta: { source: 'zanix', appName },
        },
      )
    }
    return { def, options }
  })

  return await Promise.all(
    pairs.map(({ def, options }) => announceRemoteInstance(def, options, registry, configPlane)),
  )
}

/**
 * The exact reverse of {@link activateApps}: first, every announced instance is stopped
 * (deregistered from the Control Plane, best-effort) — an
 * instance deregisters BEFORE its own `onStop` runs, so a Gateway stops routing to it before it
 * starts closing resources. Only then does `runOnStop` (across every app, while `resources` is
 * still open) `→ registry.close()` (only once every `onStop` has settled) run — same ordering
 * guarantee `runOnStop`'s own doc already documents, just applied to the whole set activated
 * together.
 *
 * @param activated Whatever {@link activateApps} returned for this same set of apps.
 * @throws {AggregateError} (from `runOnStop`) if one or more `onStop` handlers failed — `resources`
 * are still closed regardless, in `finally`-equivalent fashion. A failed deregistration never
 * throws (best-effort — see `announceRemoteInstance`'s own doc).
 */
export async function deactivateApps(activated: ActivatedApps): Promise<void> {
  await Promise.allSettled(
    activated.announced.map((instance) => instance.stop()),
  )

  try {
    await runOnStop(
      activated.apps,
      activated.resources,
      activated.remoteCaller,
    )
  } finally {
    await activated.registry.close()
  }
}
