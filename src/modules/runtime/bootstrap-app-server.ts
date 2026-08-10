import type { BootstrapServerOptions, HealthOptions, ServerID, WebServerTypes } from '@zanix/server'
import { bootstrapServers } from '@zanix/server'

/**
 * Per-type server config for ONE Zanix App — same shape as `@zanix/server`'s own
 * `BootstrapServerOptions`, minus `application`: this app's own manifest `name` supplies that
 * automatically — passing a different one here would silently misattribute every route to the
 * wrong Application, so it's a compile-time error instead.
 *
 * `health` is a sibling of the per-type fields (not nested under one), same as on
 * `BootstrapServerOptions` itself — see `bootstrapAppServer`'s own doc for why it needs its own,
 * separate forwarding path rather than flowing through the per-type loop below.
 */
export type ZanixAppServerOptions =
  & Partial<{ [K in WebServerTypes]: Omit<NonNullable<BootstrapServerOptions[K]>, 'application'> }>
  & { health?: boolean | HealthOptions }

/**
 * Actually SERVES one Zanix App's already-mounted routes — a `bootstrapServers()` call scoped to
 * `appName`'s own Application, one per declared server type. A manifest carries no port/listener
 * config of its own (see `registerApp`'s own doc), so this is the missing piece between
 * "registered" (`activateApps`/`registerApp`) and "actually reachable". Does nothing, returning
 * `[]`, if `server` is `undefined` — an app that only needs jobs/resources/lifecycle, no HTTP
 * surface, is a legitimate, common case, not an error.
 *
 * Shared by `@zanix/core`'s own `Zanix.start()` (one call per named `apps` entry that declares
 * `server`) and this package's own `ZanixAppDefinition.serve()` (one call, for itself, in a
 * standalone dev loop) — the exact same sequence, never duplicated between the two.
 *
 * @param appName The app's own manifest `name` — never a host-chosen alias (see
 * `ZanixAppServerOptions`'s own doc on why `application` itself isn't accepted here).
 * @param server Per-type config, or `undefined` to serve nothing.
 * @param finalize Forwarded to `bootstrapServers` — `false` when more `bootstrapServers` calls
 * follow in the same boot sequence (e.g. `@zanix/core` composing several apps), `true` when this
 * is the only/last one (e.g. a standalone dev loop).
 */
export async function bootstrapAppServer(
  appName: string,
  server: ZanixAppServerOptions | undefined,
  finalize: boolean,
): Promise<ServerID[]> {
  if (!server) return []

  // `health` pulled out BEFORE the per-type loop below, and set directly rather than through it —
  // it isn't a `WebServerTypes` entry (`Object.entries(server)` would otherwise hand it to the
  // loop as `[type, typeConfig]`, which then spreads it as if it were per-type server options,
  // e.g. `{ ...false, application: appName }`, silently mangling a real `boolean | HealthOptions`
  // value into an unrelated object). Real bug this fixes: any Zanix App server (a named `apps`
  // entry, or `@zanix/admin`'s own embedded/`ZanixAdminHub` server, both of which route through
  // this function) previously had no way to actually disable/configure health at all — its value
  // was silently discarded before ever reaching `bootstrapServers()`.
  const { health, ...typeConfigs } = server

  const namedServers: BootstrapServerOptions = { health }
  for (const [type, typeConfig] of Object.entries(typeConfigs)) {
    namedServers[type as keyof BootstrapServerOptions] = {
      ...typeConfig,
      application: appName,
      // deno-lint-ignore no-explicit-any
    } as any
  }

  return await bootstrapServers(namedServers, { finalize })
}
