import type {
  AppDefinition,
  NormalizedAppDefinition,
  ResourceBinding,
  RootResources,
} from 'typings/manifest.ts'
// `ActivatedApps`/`ZanixAppServerOptions` imported from their own narrow defining files, never
// from the `modules/runtime/mod.ts` barrel — this file is reached by `defineZanixApp` itself
// (`mod.ts`'s own always-executed export), so a bare `import type {...} from
// 'modules/runtime/mod.ts'` would resolve that barrel's FULL export table, dragging in
// `activate-apps.ts`'s real `control-plane`/`http-remote-adapter` imports (and, through them,
// `@zanix/datamaster/cache`'s real `redis`) purely as a side effect of a type-only import —
// confirmed via a real `deno info` reachability check, not assumed. `import type` only erases the
// type itself from the emitted output; it still makes Deno resolve the target module's full
// specifier graph, so a type-only import from a barrel with heavy real imports still materializes
// those imports' npm packages. See `activation-types.ts`'s own doc for how the types are split out
// to avoid this.
import type { ActivatedApps } from 'modules/runtime/activation-types.ts'
import type { ZanixAppServerOptions } from 'modules/runtime/bootstrap-app-server.ts'
import type { ServerID } from '@zanix/server'
import { normalize } from './normalize.ts'

/**
 * The ONLY thing that identifies an object as having come from {@link defineZanixApp}. Exported
 * (not module-private) purely because `deno doc --lint` requires every type referenced from a
 * public interface to itself be public — nothing outside this module is meant to read or set it
 * directly; use {@link isZanixAppDefinition} instead. A `Symbol` (not a string property) so it
 * can never collide with a legacy `AppBootstrapOptions` (`{rootDir, server}`) entry by accident,
 * no matter what field names that shape happens to use — the distinction between the two must be
 * structural, never a field-shape heuristic that a coincidental rename could silently break.
 */
export const ZANIX_APP_DEFINITION_BRAND: symbol = Symbol(
  'zanix-app-definition',
)

/** {@link ZanixAppDefinition.serve}'s options — the author's OWN local dev loop, never what a
 * real host passes (a host goes through `SetupOptions.apps`/`ZanixAppBootstrapOptions` instead).
 */
export interface ServeOptions {
  /** Root resources this one app's `dependencies` can bind against — same shape as
   * `SetupOptions.resources`, scoped to just this app since nothing else is running. */
  resources?: RootResources
  /** This app's own resource bindings — same shape as `ZanixAppBootstrapOptions.uses`. */
  uses?: Array<Omit<ResourceBinding, 'appName'>>
  /** Per-type server config — omit to register (jobs/resources/lifecycle) without serving any
   * HTTP surface, same meaning as `ZanixAppBootstrapOptions.server`. */
  server?: ZanixAppServerOptions
}

/** What {@link ZanixAppDefinition.serve} returns — enough to shut this one app back down,
 * mirroring `Zanix.stop()`'s own ordering (`onStop` + resource `close()` before the servers
 * themselves stop) without needing `@zanix/core` at all. */
export interface ServeHandle {
  /** Everything `activateApps` produced for this one app — its resolved resources, the registry
   * that owns them, etc. */
  readonly activated: ActivatedApps
  /** Runs this app's own `onStop`, then closes its resources, then stops whatever servers
   * `serve()` started — in that order, same as `deactivateApps`'s own doc already guarantees. */
  stop(): Promise<void>
}

/** What {@link defineZanixApp} returns — the only shape `Zanix.start()`'s `apps` option accepts
 * alongside the legacy `AppBootstrapOptions` form. */
export interface ZanixAppDefinition {
  /** Present and `true` if and only if this object came from {@link defineZanixApp} — check via
   * {@link isZanixAppDefinition} rather than reading this directly. */
  readonly [ZANIX_APP_DEFINITION_BRAND]: true
  /** The normalized manifest — see {@link NormalizedAppDefinition}. */
  readonly definition: NormalizedAppDefinition
  /** Runs THIS app alone, in isolation — the author's own local dev loop, never what a real host
   * does (a host installing this app for real goes through `Zanix.start()`'s `apps` option
   * instead, alongside whatever else it's running). See {@link ServeOptions}/{@link ServeHandle}.
   *
   * Implemented via a lazy `import('@zanix/app/runtime')` — the same `activateApps`/
   * `bootstrapAppServer` `@zanix/core`'s own `Zanix.start()` calls for a `ZanixAppBootstrapOptions`
   * entry, never a second, parallel implementation — so this package's `.` entry point pulls in
   * `@zanix/server` only if `serve()` is actually called, never merely by defining a manifest.
   */
  serve(options?: ServeOptions): Promise<ServeHandle>
}

/**
 * Authors a Zanix App manifest — the ONLY standard way to create one.
 * `defineZanixApp({ name: 'x' })` alone is valid; every other field is optional.
 *
 * Normalizes the manifest and validates what it can WITHOUT any host context (currently: `name`'s
 * format, and that a `secret` config entry never carries a literal `default`) — cross-app/host
 * checks (`uses`/`dependencies` contract, collisions) need the full graph and happen later, in
 * `AppContainer.validate()`.
 *
 * @throws {InternalError} on a malformed `name`, or a `secret: true` config entry with a literal
 * `default` — see {@link normalize}.
 */
export function defineZanixApp(def: AppDefinition): ZanixAppDefinition {
  const definition = normalize(def)

  const zanixAppDefinition: ZanixAppDefinition = {
    [ZANIX_APP_DEFINITION_BRAND]: true,
    definition,
    serve: async (options = {}) => {
      // Deliberately non-literal: Deno's own module graph builder (and, transitively, the
      // Vite/Rolldown scan `zanix space build` runs on top of it) follows a dynamic `import()`
      // whose argument it can resolve as a string literal at PARSE time, regardless of whether
      // that branch ever actually executes — a literal `import('modules/runtime/mod.ts')` here
      // would drag the whole `./runtime` barrel (`@zanix/server`, `control-plane`,
      // `@zanix/datamaster/cache`'s real `redis`) into `.`'s reachable graph for every consumer
      // that merely defines a manifest and never calls `serve()` — confirmed via a real `deno
      // info` reachability check. See `register-jobs.ts`'s own doc for the same non-literal-
      // specifier technique applied to keep an external npm-backed package's import lazy.
      const runtimeSpecifier = 'modules/runtime/mod.ts'
      const {
        activateApps,
        bootstrapAppServer,
        deactivateApps,
        webServerManager,
      } = await import(
        runtimeSpecifier
      )

      const bindings: ResourceBinding[] = (options.uses ?? []).map((
        binding,
      ) => ({
        appName: definition.name,
        ...binding,
      }))
      // Passing the FULL wrapper (never just `definition`) — `activateApps` recognizes it via
      // `isZanixAppDefinition` and uses it as-is, so this never re-normalizes what's already
      // normalized.
      const activated = await activateApps(
        [zanixAppDefinition],
        options.resources ?? {},
        bindings,
      )
      const servers: ServerID[] = await bootstrapAppServer(
        definition.name,
        options.server,
        true,
      )

      return {
        activated,
        stop: async () => {
          try {
            await deactivateApps(activated)
          } finally {
            await webServerManager.stop(servers)
          }
        },
      }
    },
  }

  return zanixAppDefinition
}

/** Structural check for whether `value` came from {@link defineZanixApp} — how a host
 * distinguishes the new manifest form from the legacy `AppBootstrapOptions` shape in
 * `SetupOptions.apps`, without relying on field-shape heuristics. */
export function isZanixAppDefinition(
  value: unknown,
): value is ZanixAppDefinition {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[ZANIX_APP_DEFINITION_BRAND] === true
  )
}
