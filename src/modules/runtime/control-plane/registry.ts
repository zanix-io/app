import type { ZanixCacheConnectorGeneric } from '@zanix/server'
import type { RegisteredInstance, RegisterInstanceOptions } from './types.ts'
import type { RemoteDeploymentTarget } from 'typings/deployment.ts'

const KEY_PREFIX = 'zanix:control-plane:registry'
const DEFAULT_LEASE_TTL_SECONDS = 30

function instanceKey(appName: string, instanceId: string): string {
  return `${KEY_PREFIX}:instance:${appName}:${instanceId}`
}

function indexKey(appName: string): string {
  return `${KEY_PREFIX}:index:${appName}`
}

/**
 * Redis-backed Registry half of the Control Plane — the only place a
 * `remote` app's live endpoints are recorded, and the only place `ctx.remote()`/the Gateway
 * read them from. Never touched by an `embedded` app — that mode keeps resolving purely
 * through `@zanix/server`'s in-process `applicationMountRegistry`, unaffected by any of this.
 *
 * One Redis key per REPLICA (`appName:instanceId`), each with its own TTL, rather than one shared
 * key per app: a single shared key would tie every replica's liveness to whichever one last
 * renewed it, hiding the other replicas' deaths behind that one survivor's heartbeat. A per-app
 * Redis SET indexes which `instanceId`s currently exist for `appName`; `SADD`/`EXPIRE` are
 * independent in Redis, so the index can outlive an individual instance key's TTL — it's pruned
 * lazily, at read time, never eagerly.
 */
export class ControlPlaneRegistry {
  #connector: ZanixCacheConnectorGeneric<'redis'>

  /** Wraps an already-constructed Redis cache connector — this class never constructs its own;
   * the host decides connection details (URL, retries, TTL offsets) exactly as it would for any
   * other `ZanixCacheConnector`.
   * @param connector The Redis cache connector to read/write the registry through. */
  constructor(connector: ZanixCacheConnectorGeneric<'redis'>) {
    this.#connector = connector
  }

  /**
   * Registers, or renews, one replica's endpoint. There is no separate "renew" call — a live
   * replica calls this again, with the same `appName`/`instanceId`, before its previous
   * `leaseTtlSeconds` elapses. A replica that stops calling this simply falls out of
   * {@linkcode ControlPlaneRegistry.getDeploymentTarget} once its lease expires — no explicit
   * failure detection needed on this side.
   *
   * @param appName The app this replica belongs to — shared across every replica.
   * @param instanceId Unique to THIS replica (e.g. a process/container id) — never reused by a
   * different, concurrently-live replica of the same app.
   * @param entry `prefix` (shared by every replica of `appName`) plus this replica's own
   * `endpoint`.
   * @param options See {@linkcode RegisterInstanceOptions}.
   */
  public async registerInstance(
    appName: string,
    instanceId: string,
    entry: RegisteredInstance,
    options: RegisterInstanceOptions = {},
  ): Promise<void> {
    const { leaseTtlSeconds = DEFAULT_LEASE_TTL_SECONDS } = options
    const client = await this.#connector.getClient()
    await client.sAdd(indexKey(appName), instanceId)
    await this.#connector.set(instanceKey(appName, instanceId), entry, {
      exp: leaseTtlSeconds,
    })
  }

  /**
   * Removes one replica's registration immediately, best-effort — used on graceful shutdown,
   * deregistering before `onStop` runs, so the Gateway stops
   * routing to it before its lease would otherwise have to expire on its own.
   *
   * @param appName The app this replica belongs to.
   * @param instanceId The replica being removed.
   */
  public async deregisterInstance(
    appName: string,
    instanceId: string,
  ): Promise<void> {
    const client = await this.#connector.getClient()
    await this.#connector.delete(instanceKey(appName, instanceId))
    await client.sRem(indexKey(appName), instanceId)
  }

  /**
   * Aggregates every currently-live replica of `appName` into one `RemoteDeploymentTarget`.
   *
   * `undefined` means "no live replica right now" — never an error; a caller in that state should
   * treat `appName` as momentarily undiscoverable (see `RemoteDeploymentTarget.endpoints`'s own
   * doc), not throw.
   *
   * Index members whose instance key already expired are pruned from the index as a side effect of
   * this call (best-effort `SREM`) — a failed prune never affects the return value, and the same
   * stale member is simply pruned again on the next call.
   *
   * @param appName The app to look up.
   */
  public async getDeploymentTarget(
    appName: string,
  ): Promise<RemoteDeploymentTarget | undefined> {
    const client = await this.#connector.getClient()
    const instanceIds = await client.sMembers(indexKey(appName))
    if (!instanceIds.length) return undefined

    const entries = await Promise.all(
      instanceIds.map(async (instanceId) => ({
        instanceId,
        entry: await this.#connector.get<RegisteredInstance>(
          instanceKey(appName, instanceId),
        ),
      })),
    )

    const live = entries.filter(
      (
        candidate,
      ): candidate is { instanceId: string; entry: RegisteredInstance } => Boolean(candidate.entry),
    )
    const stale = entries.filter((candidate) => !candidate.entry).map((
      candidate,
    ) => candidate.instanceId)
    if (stale.length) {
      await client.sRem(indexKey(appName), stale).catch(() => {})
    }

    if (!live.length) return undefined

    return {
      mode: 'remote',
      prefix: live[0].entry.prefix,
      endpoints: live.map((candidate) => candidate.entry.endpoint),
    }
  }
}
