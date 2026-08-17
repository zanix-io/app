import type { ZanixCacheConnectorGeneric } from '@zanix/server'
import type { ConfigSubscription } from './types.ts'

const VALUE_KEY_PREFIX = 'zanix:control-plane:config'

function valueKey(appName: string, configKey: string): string {
  return `${VALUE_KEY_PREFIX}:${appName}:${configKey}`
}

/** Channel name is intentionally unprefixed/un-namespaced beyond `appName`/`configKey` — this is
 * the literal channel a subscribing instance listens to, so it must match exactly on both sides. */
function channelName(appName: string, configKey: string): string {
  return `config:${appName}:${configKey}`
}

/**
 * Redis-backed Config Plane half of the Control Plane — hot-refresh of
 * non-secret app config via Redis Pub/Sub, no polling.
 *
 * Handles only NON-SECRET config. A manifest `config.<key>.secret: true` entry must
 * never be passed to `setConfig`/`subscribeConfig`: secret values never flow over Pub/Sub by
 * design. A secret's own rotation (a dual current/previous credential window) is a separate,
 * not-yet-built concern — nothing here enforces the secret/non-secret distinction itself, since no
 * manifest-aware caller exists yet to pass one.
 */
export class ControlPlaneConfig {
  #connector: ZanixCacheConnectorGeneric<'redis'>

  /** Wraps an already-constructed Redis cache connector — this class never constructs its own;
   * the host decides connection details exactly as it would for any other `ZanixCacheConnector`.
   * @param connector The Redis cache connector to read/write/publish config through. */
  constructor(connector: ZanixCacheConnectorGeneric<'redis'>) {
    this.#connector = connector
  }

  /**
   * Writes `value` for `appName`'s `configKey` and publishes it to every current subscriber —
   * a cold `getConfig` call afterward (e.g. an instance that starts up later) still sees it,
   * since the write itself has no TTL and isn't cleared by publishing.
   */
  public async setConfig(
    appName: string,
    configKey: string,
    value: unknown,
  ): Promise<void> {
    await this.#connector.set(valueKey(appName, configKey), value)
    const client = await this.#connector.getClient()
    await client.publish(
      channelName(appName, configKey),
      JSON.stringify(value),
    )
  }

  /** Reads `appName`'s `configKey` as currently stored — the value an instance should read once,
   * at startup, before {@linkcode ControlPlaneConfig.subscribeConfig} takes over for subsequent
   * changes. */
  public getConfig<T = unknown>(
    appName: string,
    configKey: string,
  ): Promise<T | undefined> {
    return this.#connector.get<T>(valueKey(appName, configKey))
  }

  /**
   * Subscribes to hot-refresh updates for exactly the `configKeys` given — never every key
   * `appName` has: each remote instance subscribes exactly to the channels for the config keys it
   * declared in its own manifest, none other. Opens a dedicated
   * connection (`duplicate()` of the underlying Redis client): a connection used for Pub/Sub can't
   * also issue normal commands, so it must never be the same connection `setConfig`/`getConfig`
   * use.
   *
   * @param appName The app whose config keys are being watched.
   * @param configKeys Exactly the keys to watch — never `secret: true` keys (see class doc).
   * @param onUpdate Called with the already-parsed new value each time `configKey` changes.
   * @returns A handle whose `close()` unsubscribes and releases the dedicated connection —
   * callers own its lifecycle; nothing here closes it automatically.
   */
  public async subscribeConfig(
    appName: string,
    configKeys: string[],
    onUpdate: (configKey: string, value: unknown) => void,
  ): Promise<ConfigSubscription> {
    const client = await this.#connector.getClient()
    const subscriber = client.duplicate()
    await subscriber.connect()

    await Promise.all(
      configKeys.map((configKey) =>
        subscriber.subscribe(channelName(appName, configKey), (message) => {
          onUpdate(configKey, JSON.parse(message))
        })
      ),
    )

    return {
      close: async () => {
        await subscriber.unsubscribe()
        await subscriber.close()
      },
    }
  }
}
