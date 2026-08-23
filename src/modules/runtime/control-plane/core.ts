import { Provider, registerCoreProviderSlot } from '@zanix/server'
import { ZanixControlPlaneProvider } from './provider.ts'

/**
 * Side-effect-only module that registers `ZanixControlPlaneProvider` under the `'controlPlane'`
 * core-provider slot — the same zero-config wiring `@zanix/datamaster/core`/`@zanix/auth/core`
 * already provide for `'cache'`/`'auth'`. Importing this (e.g. `import '@zanix/app/core'`) is the
 * ONLY thing a host needs to do to make `ctx.remote()` resolve a genuinely remote app: once
 * registered, `activateApps()` auto-detects this slot and uses it as the default
 * `HttpRemoteDispatcher` when none is passed explicitly. Never imported, `ctx.remote()` stays
 * local-only — no Redis connection opened for this reason, no cost paid.
 *
 * @module
 */

/**
 * The concrete class actually decorated `@Provider('controlPlane')` below — an empty subclass,
 * never anything more. `ZanixControlPlaneProvider` itself carries all the real behavior and is
 * what `registerCoreProviderSlot` registers as the slot's base type (same split
 * `@zanix/datamaster`'s `ZanixCacheProvider`/`ZanixCacheCoreProvider` already uses): decorating
 * `ZanixControlPlaneProvider` directly would fail its own `X.prototype instanceof X` check (a
 * class is never its own subclass) — a host that wants to fully replace the default behavior
 * extends `ZanixControlPlaneProvider` with their own subclass instead, exactly like this one.
 */
class ZanixControlPlaneCoreProvider extends ZanixControlPlaneProvider {}

registerCoreProviderSlot('controlPlane', ZanixControlPlaneProvider, {
  sourcePackage: '@zanix/app/core',
})

/**
 * Registers `ZanixControlPlaneCoreProvider` under the `'controlPlane'` core-provider slot. Already
 * ran once, automatically, at import time (see below) — exported (not just auto-run) so a caller
 * can re-register after clearing the `'type:provider'` registry
 * (`ProgramModule.targets.resetContainer(['type:provider'])`, `@zanix/server`) without needing a
 * fresh module evaluation of this file, kept consistent with every other `core.ts` loader's own
 * callable, re-invokable registration function across the Zanix ecosystem (see
 * `@zanix/datamaster`'s `storage/core.ts`'s own `registerSeaweedFSConnector` doc for the full
 * reasoning that pattern exists for).
 */
export const registerControlPlaneProvider = (): void => {
  Provider('controlPlane')(ZanixControlPlaneCoreProvider)
}

const zanixControlPlaneProviderCore: void = registerControlPlaneProvider()
export default zanixControlPlaneProviderCore
