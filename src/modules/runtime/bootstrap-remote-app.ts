import type { ServeHandle, ServeOptions, ZanixAppDefinition } from 'modules/manifest/mod.ts'
import type { RemoteInstanceOptions } from './remote-lifecycle.ts'
import type { ResourceBinding } from 'typings/manifest.ts'
import logger from '@zanix/logger'
import { webServerManager } from '@zanix/server'
import { activateApps, deactivateApps } from './activate-apps.ts'
import { bootstrapAppServer } from './bootstrap-app-server.ts'

/** {@link bootstrapRemoteApp}'s options — same shape as {@link ServeOptions} (the local dev loop),
 * plus what a REAL standalone deployment needs and a dev loop deliberately never touches. */
export interface BootstrapRemoteAppOptions extends ServeOptions {
  /** Announces this instance to the Control Plane Registry so other Zanix Apps can reach it via
   * `ctx.remote()` — omit to run standalone without announcing (e.g. behind a Gateway that already
   * knows this instance's endpoint some other way). Scoped to this ONE app, unlike
   * `activateApps`'s own `remoteInstances`, which accepts a whole batch — {@link bootstrapRemoteApp}
   * only ever activates one. */
  remoteInstances?: RemoteInstanceOptions
}

/**
 * Bootstraps ONE Zanix App as its own standalone, production-facing remote process — the
 * DX/deploy pipeline track. Generated into a project's own
 * `serve.ts` by `zanix prepare --docker -p app` (see that command's own doc), never called by
 * `zanix new app`'s bare scaffold — a Zanix App is an installable MANIFEST first, and most never
 * need this at all (a host embeds them via `Zanix.start()`'s `apps` option instead).
 *
 * Deliberately NOT {@link ZanixAppDefinition.serve} with extra options bolted on: `serve()` is
 * documented as the author's own local dev loop and intentionally never announces to the Control
 * Plane or wires OS signal handling — retrofitting production concerns onto it would blur that
 * contract for every existing caller. This reuses the exact same `activateApps`/
 * `bootstrapAppServer` primitives `serve()` and `@zanix/core`'s own `Zanix.start()` already share,
 * so there is still only ONE real activation/serving implementation — just a second, genuinely
 * different caller of it.
 *
 * Graceful shutdown mirrors `@zanix/core`'s own `Zanix.start()`/`stop()` exactly: `SIGINT`/
 * `SIGTERM` trigger `deactivateApps` (this app's own `onStop` + resource release) BEFORE the web
 * servers themselves stop, and the listeners are removed before running so a second signal (or a
 * caller-invoked `stop()`) can never double-run the same shutdown.
 *
 * @param zanixAppDefinition The `defineZanixApp()` result to run standalone — passed straight
 * through to `activateApps` (never unwrapped), same as `serve()` does.
 * @param options See {@link BootstrapRemoteAppOptions}.
 * @returns The same {@link ServeHandle} shape `serve()` returns — `stop()` remains available for
 * tests/programmatic control, even though a real deployment's primary shutdown path is the OS
 * signal handlers registered here, not a manual call.
 */
export async function bootstrapRemoteApp(
  zanixAppDefinition: ZanixAppDefinition,
  options: BootstrapRemoteAppOptions = {},
): Promise<ServeHandle> {
  const definition = zanixAppDefinition.definition

  const bindings: ResourceBinding[] = (options.uses ?? []).map((binding) => ({
    appName: definition.name,
    ...binding,
  }))

  const activated = await activateApps(
    [zanixAppDefinition],
    options.resources ?? {},
    bindings,
    undefined,
    options.remoteInstances ? { [definition.name]: options.remoteInstances } : {},
  )
  const servers = await bootstrapAppServer(
    definition.name,
    options.server,
    true,
  )

  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    Deno.removeSignalListener('SIGINT', onSignal)
    Deno.removeSignalListener('SIGTERM', onSignal)
    try {
      await deactivateApps(activated)
    } finally {
      await webServerManager.stop(servers)
    }
  }

  const onSignal = async () => {
    logger.info(
      `Shutdown signal received, stopping "${definition.name}"...`,
      'noSave',
    )
    try {
      await stop()
      Deno.exit(0)
    } catch (error) {
      logger.error(`Graceful shutdown failed for "${definition.name}"`, error)
      Deno.exit(1)
    }
  }

  Deno.addSignalListener('SIGINT', onSignal)
  Deno.addSignalListener('SIGTERM', onSignal)

  return { activated, stop }
}
