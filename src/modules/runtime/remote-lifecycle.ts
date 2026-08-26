import type { NormalizedAppDefinition } from 'typings/manifest.ts'
import type { ControlPlaneConfig, ControlPlaneRegistry } from './control-plane/mod.ts'
import { setConfigOverride } from './config-overrides.ts'
import { type MtlsDispatchOptions, startMtlsDispatchServer } from './mtls-dispatch-server.ts'
import logger from '@zanix/logger'
import type { AnnouncedRemoteInstance } from './activation-types.ts'

// `AnnouncedRemoteInstance` lives in `activation-types.ts`, not here — see that module's own doc
// for why: this file's own real (`startMtlsDispatchServer`) and type-only (`ControlPlaneConfig`/
// `ControlPlaneRegistry`, themselves resolving `@zanix/datamaster/cache`'s real `redis` import)
// imports would otherwise be dragged into `.`'s (`mod.ts`) reachable graph by a bare `import type
// {AnnouncedRemoteInstance} from './remote-lifecycle.ts'` — a type-only import still makes Deno
// resolve the imported module's full specifier graph (only the type itself is erased from the
// emitted output), so importing a type from a module with heavy real imports still materializes
// those imports' packages for anyone doing nothing more than importing the type. Re-exported here
// so every existing import of `AnnouncedRemoteInstance` FROM this file (this module's own return
// type, `modules/runtime/mod.ts`'s barrel) keeps working unchanged.
export type { AnnouncedRemoteInstance }

/** Default lease TTL for a registered instance — matches `ControlPlaneRegistry`'s own default. */
const DEFAULT_LEASE_TTL_SECONDS = 30

/** Options for announcing one `remote`-mode app instance to the Control Plane at instance
 * start. */
export interface RemoteInstanceOptions {
  /** This instance's own reachable base URL — what `HttpRemoteAdapter` composes
   * `/__zanix-ops/${appName}/...` on top of (e.g. `http://reviews-a.internal:8080/api`). Only the
   * host/deployment environment knows this; never derived automatically. */
  endpoint: string
  /** Unique to THIS replica. Defaults to a random UUID — pass a stable one (e.g. the container/
   * pod name) if your deployment benefits from it. */
  instanceId?: string
  /** Forwarded to `ControlPlaneRegistry.registerInstance`'s own option. Defaults to `30`. */
  leaseTtlSeconds?: number
  /** How often to renew the lease — must stay well under `leaseTtlSeconds`, or the registration
   * can expire between renewals. Defaults to a third of `leaseTtlSeconds`. */
  heartbeatIntervalMs?: number
  /** Starts a dedicated mTLS listener (`mtls-dispatch-server.ts`) for this instance's
   * `/__zanix-ops/...` surface ONLY — omit entirely to keep serving that surface exclusively
   * through the app's own regular (non-mTLS) `Deno.serve()` routes. See
   * `MtlsDispatchOptions`/`HttpRemoteAdapterTlsOptions` for what this does and doesn't achieve. */
  mtls?: MtlsDispatchOptions
}

/**
 * Announces one `remote`-mode app instance, run AFTER this app's own local `onStart` already
 * completed:
 *
 * 1. Registers `def.name`/`instanceId` in the Control Plane Registry (real endpoint, with a
 *    lease) — `HttpRemoteAdapter`'s own `ControlPlaneRegistry.getDeploymentTarget` starts seeing
 *    it immediately.
 * 2. Starts a heartbeat that renews the SAME registration on an interval — a live instance never
 *    lets its own lease expire on its own; only an actual crash/hang does.
 * 3. If `configPlane` is given, subscribes to every NON-secret config key this app declared —
 *    a push from the Config Plane updates `ctx.config.get(key)` immediately (`config-overrides.ts`),
 *    no restart. Secret keys are never subscribed here — secret config
 *    never flows over Pub/Sub — never passed through even if the caller's `configPlane` would
 *    otherwise accept them.
 * 4. If `options.mtls` is given, starts a dedicated mTLS-enforcing listener for this instance's
 *    `/__zanix-ops/...` surface (see `mtls-dispatch-server.ts`) — closed again by `stop()`.
 *
 * The FIRST registration (step 1) propagates a failure — an app that can't announce itself at
 * all should fail its own startup loudly. A heartbeat renewal failing later, mid-run, does NOT
 * (logged and swallowed) — a transient Control Plane blip should never crash an otherwise-healthy
 * process; if the outage outlasts the lease, the registration simply expires, correctly reflecting
 * reality, and the next successful renewal (if the instance survives) re-registers it.
 *
 * @param def The already-normalized, already-started app being announced.
 * @param options See {@link RemoteInstanceOptions}.
 * @param registry Where this instance registers/renews/deregisters itself.
 * @param configPlane Omit entirely to skip Config Plane hot-refresh for this instance.
 */
export async function announceRemoteInstance(
  def: NormalizedAppDefinition,
  options: RemoteInstanceOptions,
  registry: ControlPlaneRegistry,
  configPlane?: ControlPlaneConfig,
): Promise<AnnouncedRemoteInstance> {
  const instanceId = options.instanceId ?? crypto.randomUUID()
  const leaseTtlSeconds = options.leaseTtlSeconds ?? DEFAULT_LEASE_TTL_SECONDS
  const heartbeatIntervalMs = options.heartbeatIntervalMs ??
    (leaseTtlSeconds * 1000) / 3
  // `routesPrefix`'s own convention: the auto-default is the bare `name`, no leading
  // `/` — only an EXPLICIT `routes: { prefix }` may add one. `routes: false` (`routesPrefix ===
  // null`) falls back to that same bare-name convention, never inventing a different shape here.
  const entry = {
    prefix: def.routesPrefix ?? def.name,
    endpoint: options.endpoint,
  }

  await registry.registerInstance(def.name, instanceId, entry, {
    leaseTtlSeconds,
  })

  const heartbeat = setInterval(() => {
    registry.registerInstance(def.name, instanceId, entry, { leaseTtlSeconds })
      .catch((error) => {
        logger.error(
          `Zanix App "${def.name}" instance "${instanceId}" failed to renew its Control Plane ` +
            `lease — it will expire if this keeps failing.`,
          error,
          'noSave',
        )
      })
  }, heartbeatIntervalMs)

  const configKeys = Object.entries(def.config)
    .filter(([, declaration]) => !declaration.secret)
    .map(([key]) => key)

  const subscription = configKeys.length && configPlane
    ? await configPlane.subscribeConfig(def.name, configKeys, (key, value) => {
      setConfigOverride(def.name, key, value)
    })
    : undefined

  const mtlsServer = options.mtls ? startMtlsDispatchServer(options.mtls) : undefined

  return {
    appName: def.name,
    instanceId,
    stop: async () => {
      clearInterval(heartbeat)
      await subscription?.close()
      await mtlsServer?.close()
      await registry.deregisterInstance(def.name, instanceId).catch((error) => {
        logger.error(
          `Zanix App "${def.name}" instance "${instanceId}" failed to deregister cleanly — its ` +
            `lease will still expire on its own.`,
          error,
          'noSave',
        )
      })
    },
  }
}
