# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/en/1.0.0/) and this project
adheres to [Semantic Versioning](http://semver.org/spec/v2.0.0.html).

## [1.0.2] - 2026-09-03

### Fixed

- Fix duplicates. `auth` version major to `^1.0.0`.

## [1.0.0] - 2026-09-02

### Added

- **`resolveResource<T = unknown>(appName, slot): T | undefined`** (`./runtime`,
  `resource-instance-registry.ts`) — resolves an already-constructed resource instance OUTSIDE any
  `RuntimeContext`, the resource-side counterpart to `resolveBehavior`. `ctx.resource(slot)` reads a
  `Map` threaded purely functionally through `activateApps()`/`installApp()`/`uninstallApp()` (each
  returns a fresh `Map`, never mutating the one it received), so nothing outside a `setup`/
  `onStart`/`onStop`/`operations` closure could reach a resolved resource before — a
  `ZanixInteractor` handling a request, for instance, has no `ctx` of its own to call
  `ctx.resource()` from. `resolveResources()` now also mirrors every entry it produces into a
  process-wide `${appName}:${slot} -> instance` overlay (covering both a full `activateApps()` batch
  and an `installApp()` delta), which `resolveResource` reads from. `uninstallApp` and
  `deactivateApps` clear an app's own entries from that overlay right after its resources actually
  close, so `resolveResource` never returns an instance that may already be unusable. `T` is
  manually specified, not inferred (`slot` is just a string, with no type-carrying shape to infer
  from) — same ergonomic-cast reasoning as `resolveBehavior<T>`.
- **`resolveConfig<T = unknown>(appName, key): T | undefined`** (`./runtime`, `config-overrides.ts`)
  — resolves a config override-or-default OUTSIDE any `RuntimeContext`, the config-side counterpart
  to `resolveBehavior`/`resolveResource`. `ctx.config.get(key)` used to read the manifest's own
  `def.config[key]?.default` directly from closure, so nothing outside a
  `setup`/`onStart`/`onStop`/`operations` closure could resolve a single config value — a
  `ZanixInteractor` handling a request has no `ctx` of its own to call `ctx.config.get()` from, the
  same gap `resolveBehavior` already closed for `behaviors`. `registerApp()` now also registers
  every declared `config` default into a process-wide `${appName}:${key} -> default` registry (via
  the new `registerConfigDefaults`, called alongside the existing `registerBehaviors`);
  `ctx.config.get` now delegates entirely to `resolveConfig`, so the two entry points can never
  resolve differently. `T` is manually specified, not inferred (`key` is just a string, with no
  type-carrying shape to infer from) — same ergonomic-cast reasoning as
  `resolveBehavior<T>`/`resolveResource<T>`.

### Fixed

- `ResourceFactory` (`@zanix/app/runtime`, `resource-types.ts`) rejected any factory returning a
  real `@zanix/server` connector. `CloseableResource` requires a PUBLIC `close()`, but
  `ZanixConnector.close()` — inherited by `RestClient` and every connector built on it, including
  `@zanix/auth`'s `OAuth2Connector`/`GoogleOAuth2Connector`/`GitHubOAuth2Connector` — is declared
  `protected` (internal framework lifecycle, never meant to be called outside the
  `@Connector`/`TargetContainer` path). A `protected` member is invisible to a structural check
  against a public-only type, so `deno check` genuinely rejected
  `(options) =>
  new GoogleOAuth2Connector(options)` as a `ResourceFactory` (`TS2322`) — the only
  way to register such a connector as a swappable resource was to wrap it in a plain
  `{ connector, close: () => {}
  }` object by hand at every call site. `ResourceFactory`'s return
  type now also accepts a `ZanixConnector` instance directly: assigning a subclass to its own base
  class is ordinary inheritance-based assignability, where `protected` is no obstacle, so this
  needed no runtime change — `ResourceRegistry`/`resolveResources` already closed and health-gated a
  `ZanixConnector` instance correctly; only the type a factory is checked against was too narrow to
  admit one.

## [0.2.1] - 2026-08-26

### Fixed

- `@zanix/app/runtime` (`activateApps`/`registerApp`) statically, unconditionally imported
  `@zanix/asyncmq`, `@zanix/datamaster`, and `@zanix/auth` — even for a Zanix App manifest that
  declares no `jobs`/`resources`/remote-callable `operations` at all (e.g. a bare `@zanix/space` app
  using only `bootstrapRemoteApp`). This dragged `mongoose`/`mongodb`/`bson`, `redis`/`@redis/*`,
  and `amqplib` (and, transitively, `@zanix/datamaster`'s own S3 `@aws-sdk/client-s3` tree) into the
  module graph of ANY consumer that merely imported `@zanix/app/runtime` — confirmed via
  `deno
  info`'s own module graph and a real `Initialize mongoose/redis/amqplib/@aws-sdk/*`
  package-materialization trace in a clean checkout. Beyond cold-cache download cost, a bundler
  resolving this entry point (e.g. `zanix space build`'s Vite/Rolldown pipeline, and — separately,
  confirmed by a real end-to-end `zanix space build` run against a locally-linked fixed checkout —
  Deno's own `nodeModulesDir: "auto"` npm-install-style resolution) walked the same declared
  dependency, so this made every `zanix space build` for a project with zero jobs/resources/remote
  operations resolve a dependency tree dozens of times larger than necessary. Two layers, both
  needed — confirmed empirically, not assumed:
  - **Call sites**: `register-jobs.ts` (`@zanix/asyncmq`), `resource-types.ts`
    (`@zanix/datamaster`'s `mongo`/`redis` resource types),
    `http-remote-adapter.ts`/`mtls-dispatch-server.ts`/ `remote-dispatch-route.ts`/`mcp-route.ts`
    (`@zanix/auth`): each now reaches its package through a deliberately non-literal,
    fully-qualified `jsr:...` `import()` specifier (a shared constant in the new
    `lazy-specifiers.ts`, never a bare alias), evaluated only when a manifest genuinely declares the
    corresponding capability (checked BEFORE the import, not after). Every whole-module
    `typeof import('pkg')` type alias this fix originally used was replaced with a narrow,
    hand-declared local interface for exactly the few bindings each file actually destructures —
    confirmed real, not theoretical: a `typeof import(...)` alias, though erased from emitted JS,
    still forced a type-checker (and this specific Vite/Deno-loader pipeline) to resolve the target
    package's own FULL export surface, materializing its dependencies anyway. No new opt-in import
    is required for existing `jobs`/`resources`/`operations` usage to keep working — this was
    deliberately NOT solved with a narrower opt-in subpath (e.g. widening `@zanix/app/core`), since
    that would have required every consumer already using `operations` to add a new import merely to
    keep working, breaking a real, functional-test-verified behavior
    (`service-token-exchange-validation.test.ts`) that never needed one before.
  - **`deno.jsonc`'s own `imports` map**: `@zanix/asyncmq`/`@zanix/datamaster`/`@zanix/auth` are now
    absent from it entirely (moved to a `scopes` entry for `./src/@tests/` only, where this
    package's own test suite still constructs real connectors directly) — confirmed via a controlled
    `zanix space build` experiment that a bare alias declared here is, on its own, enough to trigger
    `nodeModulesDir: "auto"`-style materialization regardless of whether any reachable code
    references it, or through what specifier form.
  - `getResourceFactory` (`resource-types.ts`, re-exported from `@zanix/app/runtime`) stays `sync`,
    returning `ResourceFactory | undefined` exactly as before — resolving WHICH factory applies to a
    `type` never itself needs an `await`; only actually INVOKING the returned factory does
    (unchanged call-site shape in `resolve-resources.ts`). An earlier draft of this fix made this
    function `async` (a real, then-documented semver-minor break) while its `'mongo'`/`'redis'`
    resolution used a hand-rolled `await import(...)`; adopting `@zanix/utils`'s own `lazyClass`
    (see below) let this revert to the original sync signature — `lazyClass` returns an async
    FACTORY, so only the factory's own invocation is async, not choosing it.
  - **`register-jobs.ts`/`resource-types.ts`/`http-remote-adapter.ts`/`mtls-dispatch-server.ts` now
    use `@zanix/utils`'s own `lazyFunction`/`lazyClass`/`lazyValue` helpers** (`@zanix/helpers`,
    superseding the hand-rolled `await import(specifier) as NarrowInterface` boilerplate the first
    draft of this fix used at each call site) — `resource-types.ts`'s `'mongo'`/`'redis'` factories
    via `lazyClass`, `http-remote-adapter.ts`'s `createServiceAuthClient` via `lazyFunction`,
    `mtls-dispatch-server.ts`'s
    `getSecretByToken`/`verifyJWT`/`exchangeServiceCredential`/`DEFAULT_AUTH_ISSUER` via
    `lazyFunction`/`lazyValue`. Two call sites deliberately did NOT adopt the generic helper, each
    documented in place with why: `register-jobs.ts` keeps its own narrow `AsyncmqExports` interface
    (consistent with `typings/manifest.ts`'s own temporary-local-type stopgap above, not a separate
    decision); `mcp-route.ts`/`remote-dispatch-route.ts` keep their own `AuthExports` + raw
    `await import(...)` because `AuthTokenValidation` is applied as a real class DECORATOR, which
    needs the decorator function SYNCHRONOUSLY at class-declaration time — `lazyFunction`'s wrapper
    always returns a `Promise` (it awaits internally on every call), which a decorator position can
    never accept.
  - **`deno.jsonc`'s `@zanix/helpers` entry is a TEMPORARY local path override**
    (`../utils/src/modules/helpers/mod.ts`, plus a paired `scopes` entry for `../utils/src/` and a
    `compilerOptions.types` addition — both documented in place, both removed together), matching
    `cli/deno.jsonc`'s own established pattern for a not-yet-published dependency: real JSR
    currently only has `@zanix/utils` v3.x, which has no `lazyFunction`/`lazyClass`/`lazyValue`
    exports at all. Revert to a real `jsr:@zanix/utils@^4.0.0/helpers` specifier (dropping the local
    override, the paired `scopes` entry, and the `compilerOptions.types` addition together) once
    `@zanix/utils` v4 is actually published. Validated with the link active: `deno fmt`/
    `lint`/`check` clean, full suite green (280/280).
  - `runtime.ts`'s own module doc, which used to document `@zanix/asyncmq`/`@zanix/datamaster`/
    `@zanix/auth` as unconditional dependencies "as more lands", is corrected to describe the
    actual, now-conditional shape.
  - **A residual gap this same fix originally left open — now closed, after a second, deeper
    finding, with a TEMPORARY (not final-design) fix**: `typings/manifest.ts`'s `JobDefinitionEntry`
    (`AppDefinition.jobs`' own shape) used to `import type` `@zanix/asyncmq`'s real
    `JobProcess`/`CronJobDefinitionBase`/`Job` types directly (a fully-qualified specifier, not a
    bare alias), on the assumption that a pure `import type` — erased entirely at build time — costs
    nothing beyond type-checking. Confirmed real via an isolated `deno check` repro that it does
    NOT: for a JSR package whose own graph has real npm dependencies (`@zanix/asyncmq` needs
    `@zanix/datamaster`, hence `mongoose`/`mongodb`/`bson`/`redis`/`@redis/*`),
    `nodeModulesDir:
    "auto"` materializes that whole tree just from resolving the TYPE — the
    same npm-install mechanism already documented above for VALUE-level bare aliases, not limited to
    them. `@zanix/asyncmq` currently has no narrow subpath exposing `Job`/`CronJobDefinitionBase`/
    `JobProcess`/`registerJob`/`registerCronJob` without also pulling in its RabbitMQ connector/
    providers/subscribers (its only entry points are `.`/`/worker`/`/core`/`/dlq`), so there is
    currently no safe target to `import type` from at all. Stopgap fix: hand-rolled
    `Job`/`ProcessingQueues`/`JobProcess`/`CronJobDefinitionBase` as LOCAL, structural types in
    `typings/manifest.ts` itself — no `@zanix/asyncmq` (or `@zanix/server`, equally unsafe for this
    module, which is shared by `@zanix/app`'s dependency-free `.` entry point) reference anywhere,
    type or value. Confirmed via an isolated repro of the exact current file: materializes NOTHING —
    no `node_modules` directory even created. `job-leader-election.ts` re-uses this same local `Job`
    type via `typings/manifest.ts` (never its own `@zanix/asyncmq` import), preserving the
    established `modules/` → `typings/` dependency direction. `lazy-specifiers-sync.test.ts`
    (rewritten accordingly) guards the current invariant — that neither file reintroduces a real
    reference to either package. **Explicitly NOT accepted as the final design** — a real,
    unaccepted-long-term drift risk exists as long as this local mirror stands in for the real type;
    revert to a real `import type` once `@zanix/asyncmq` ships a narrow subpath for its
    job-registration surface (tracked in that package's own repo, not this one).

- **The stopgap above is now resolved for real**: `@zanix/asyncmq@0.8.0` shipped the narrow `./jobs`
  subpath (`registerJob`/`registerCronJob` + `Job`/`BaseJob`/`JobDefinition`/`JobProcess`/
  `CronJobDefinition`/`CronJobDefinitionBase`/`ProcessingQueues` — no RabbitMQ connector, no
  `@zanix/database`). `typings/manifest.ts` now `import type`s the real types from
  `@zanix/asyncmq/jobs` and re-exports them verbatim — the hand-rolled local mirror block and
  `lazy-specifiers-sync.test.ts` (the regression guard for that stopgap) are both deleted; there is
  no local copy of `@zanix/asyncmq`'s job/cron contract left anywhere in this package.
  `job-leader-election.ts` is unaffected — it still gets `Job` through `typings/manifest.ts`, now
  the real type instead of the local mirror. `register-jobs.ts`'s own `ASYNCMQ_SPECIFIER` (the
  VALUE-level, lazy, non-literal `import()` target) now also points at `./jobs` instead of the bare
  root, since the root no longer re-exports `registerJob`/`registerCronJob` at all (moved, not
  duplicated) — its narrow `AsyncmqExports` interface stays as-is regardless, since what requires it
  (a non-literal dynamic `import()` specifier, which TypeScript can't infer a shape from) is
  independent of whether the target subpath itself is narrow. Confirmed via an isolated repro that
  `@zanix/asyncmq/jobs` stays free of `amqplib`/`mongoose`/`redis`/`@aws-sdk/*` either way — this
  package's `.` entry point does now transitively depend on `@zanix/server` (`./jobs`'s own
  `Job`/`JobProcess` need its `MessageQueue`/`HandlerContext`/provider-getter types), which, as of
  `@zanix/server`'s currently published version, carries its own separate, already-tracked leak
  (`graphql`, a `redis` type reference) unrelated to this change — see `typings/manifest.ts`'s own
  doc. **TEMP**: `deno.jsonc`'s `@zanix/asyncmq/jobs` entry is a local path override
  (`../asyncmq/src/modules/jobs/mod.ts`, plus a paired `scopes` entry for `../asyncmq/src/`) — real
  JSR doesn't have `@zanix/asyncmq` 0.8.0 published yet. Revert to a real
  `jsr:@zanix/asyncmq@^0.8.0/jobs` specifier (dropping the override and its paired scope) once it
  publishes. `deno fmt`/`lint`/`check` clean, full suite green (277/277).

- **Exhaustive per-subpath audit of `.`/`./runtime`/`./core`, confirming the fixes above**: an
  isolated repro per subpath (a consumer importing only that one, `node_modules/.deno` inspected
  directly rather than `deno info`'s own graph, which omits type-only edges) confirms none of the
  three reaches `amqplib`/`mongoose`/`mongodb`/`bson`/`@aws-sdk/*` — only `graphql`/`redis`/
  `@redis/*`, all from `@zanix/server`'s own already-tracked, unrelated leak (present against the
  real, currently published `@zanix/server`; all three subpaths need its root for real, either
  directly or through `@zanix/asyncmq/jobs`'s own types). **Measured, not assumed, whether this
  clears once `@zanix/server` publishes**: a second repro pointed `@zanix/server` at that package's
  own local, unpublished checkout — the same TEMP relative-link shape already used for
  `@zanix/helpers`/`@zanix/asyncmq/jobs` above, applied at BOTH the levels that resolve
  `@zanix/server` (this package's own top-level `imports`, and `@zanix/asyncmq`'s, via a matching
  `../asyncmq/src/` `scopes` entry — omitting the second one leaves `@zanix/asyncmq`'s own
  `jsr:@zanix/server@^3.0.0` pin resolving the real published version regardless of this package's
  own override, since Deno treats a linked local package's own directory as governed by its own
  import map first). With both in place, and `deno.lock` deleted before each repro (the same
  discipline as above — a stale lockfile's own `npm` section otherwise gets synced into
  `node_modules` regardless of current reachability): all three subpaths' `node_modules/.deno` come
  back completely empty — zero npm packages, `graphql`/`redis` included. `deno check` against that
  local checkout does report 21 real `TS18046`/`TS7006` errors in
  `modules/runtime/control-plane/registry.ts` (a real, separate, already-anticipated
  breaking-type-change fallout: that file's own code assumes `ZanixCacheConnectorGeneric['redis']`'s
  `getClient()` still returns a Redis-shaped client, `@zanix/server`'s own fix having changed it to
  `Promise<unknown>` — a follow-up for whenever `@zanix/server` actually publishes it, not a
  materialization issue) — module RESOLUTION itself completes cleanly either way, before type errors
  are ever reported, so this doesn't affect the `node_modules` measurement. Confirmed via the
  resolved value graph too (`deno info`: 466 unique dependencies, zero `npm:/` entries) that
  `@zanix/server`'s own `getMainHandler` no longer statically imports its GraphQL handler module —
  it goes through a registry indirection
  (`registerGraphqlHandlerFactory`/`getGraphqlHandlerFactory`) that keeps the real `graphql` npm
  package out of the reachable graph for a non-GraphQL consumer. **Both TEMP links were removed
  again immediately after this measurement** — this was a one-time verification, not a change to
  keep; `@zanix/server`'s own `imports` entry here stays the real `jsr:@zanix/server@^3.0.0` until
  that package actually publishes its fix. One real, if currently inert, gap found and closed along
  the way: `mod.ts`'s own six re-exported runtime types (`ActivatedApps`/`AnnouncedRemoteInstance`/
  `HttpRemoteDispatcher`/`RemoteCallerFactory`/`ResourceRegistry`/`ZanixAppServerOptions`) were
  `import type`'d from the `./runtime` barrel (`modules/runtime/mod.ts`) rather than from each
  type's own defining file — resolving them therefore forced resolution of every OTHER file the
  barrel re-exports too (`mcp-route.ts`, `mtls-dispatch-server.ts`, `gateway.ts`, ...), none of
  which happens to add a new npm dependency today, but any one of them could tomorrow without `.`'s
  own doc comment or exports changing at all. Each type now comes from its own defining file
  instead, so `.`'s real type-reachability matches what its six exports actually need. Confirmed via
  a repro before and after: identical `node_modules/.deno` contents either way (today), full
  `deno check`/`lint`/`fmt` clean, full suite green (277/277).

- **The 21 `TS18046`/`TS7006` errors anticipated above are now fixed, ahead of `@zanix/server`
  actually publishing `4.0.0`**: `modules/runtime/control-plane/registry.ts`/`leader-election.ts`/
  `config-plane.ts` assumed `ZanixCacheConnectorGeneric<'redis'>`'s `getClient()` still returned a
  Redis-shaped client — true only by accident, on the currently pinned, published `^3.0.0` line (its
  own now-tracked `npm:redis@...` literal leak), and no longer true once `4.0.0` narrows that
  default to `Promise<unknown>` for real. The Control Plane is unconditionally Redis-backed by
  design (`SADD`, `SET ... NX EX`, `EVAL`, `PUBLISH`/`SUBSCRIBE`, ...) — raw commands
  `@zanix/server`'s own generic cache API never covers — so all three files now type their connector
  as `ControlPlaneRedisConnector` (new, `modules/runtime/control-plane/types.ts`):
  `@zanix/datamaster`'s real `ZanixRedisConnector`, whose own `getClient` override already supplies
  the concrete `RedisClientType` default regardless of `@zanix/server`'s own loose fallback.
  `ZanixControlPlaneProvider` (`provider.ts`) now resolves this connector via
  `this.connectors.get('cache:redis')`, typed through a new `ControlPlaneCoreModules` interface —
  the same `CoreModules`/`ZanixConnectorsGetter` mechanism `@zanix/server` itself documents for a
  string key outside its 6 pre-typed slots — instead of the untyped `this.cache.redis`. `deno.jsonc`
  gains one new, narrow, PERMANENT alias, `@zanix/datamaster/cache`
  (`jsr:@zanix/datamaster@^1.0.0/cache`) — confirmed `mongoose`/`@aws-sdk/*`-free, same audit method
  as the entries above. Unlike every other `@zanix/datamaster` reference in this package, this one
  is reached unconditionally (the Control Plane has no lazy/conditional gate the way the
  `mongo`/`redis` resource types do), so `redis` itself becomes a real, deliberate dependency of
  every `@zanix/app/runtime` consumer from here on — an accepted cost of this specific, always-Redis
  feature, not a leak. **A second, previously undocumented instance of the same "a linked local
  package's own directory resolves `@zanix/server` through its own import map first" gotcha already
  known for `@zanix/asyncmq`** turned up verifying this fix: `@zanix/datamaster` is fetched for real
  from JSR for this new alias (no local override needed for the PERMANENT fix), so its own
  internally-resolved `@zanix/server` reference is fixed at ITS publish time, independent of this
  package's own `@zanix/server` pin — verifying the fix against `@zanix/server`'s local, unpublished
  checkout therefore ALSO needed a matching TEMP local override for `@zanix/datamaster/cache` itself
  (pointing at that package's own local checkout, which already carries the identical TEMP
  `@zanix/server` link), removed again immediately after the measurement, same as every other TEMP
  link in this file. The already-tracked `@zanix/asyncmq`-side instance of this gotcha does NOT
  apply to these three files specifically — none of them reach `@zanix/server` through
  `@zanix/asyncmq`'s own local tree; each imports it directly. Validated with both TEMP links
  active: `deno check` clean against the local `4.0.0` checkout, zero `TS18046`/`TS7006` left. Both
  reverted immediately after; the real `@zanix/server` pin here stays `jsr:@zanix/server@^3.0.0`
  until that version actually publishes. `deno fmt`/`lint`/`check` clean, full suite green (277/277)
  in the normal (non-linked) state too.

- **A real module-duplication risk in the `@zanix/helpers` TEMP override above, confirmed via a live
  repro, not assumed**: the override pointed at `@zanix/utils`'s own unpublished
  `modules/helpers/mod.ts` barrel, which re-exports `utils/cron.ts` and
  `modules/helpers/masking/hard.ts` alongside `lazyFunction`/`lazyClass`/`lazyValue` — the only
  three exports this package actually needs from it. Both of those unrelated files import `logger`
  via a bare `modules/logger/mod.ts` specifier, resolved (through the paired `../utils/src/` scope)
  against that same unpublished checkout — a second, separate `Logger`/`Proxy` module instance from
  the `jsr:@zanix/utils@^3.0.0/logger` one every other file in this package resolves `@zanix/logger`
  to. A live repro confirmed the real failure mode:
  `Object.getPrototypeOf(realLogger) ===
  Object.getPrototypeOf(checkoutLogger)` is `false`, and a
  spy installed on the real logger's prototype never observes a call made through the checkout
  instance — exactly the "10 tests failing silently" pattern already confirmed in
  `@zanix/datamaster` for the same override shape. Fixed by narrowing `deno.jsonc`'s
  `@zanix/helpers` entry to `../utils/src/utils/lazy-import.ts` directly instead of the whole
  `mod.ts` barrel — that file has no imports of its own, so the duplication risk is gone entirely,
  with no `scopes` entry needed for it any more. This package's own test suite separately needs
  `generateRSAKeys`/`getTemporaryFolder` — real, already-published members of
  `@zanix/utils@^3.0.0`'s real `/helpers` subpath — so `./src/@tests/` gained its own
  `@zanix/helpers` scope entry pinned to the real `jsr:@zanix/utils@^3.0.0/helpers`, keeping the
  unpublished checkout out of the test tree entirely too. The now-unused `../utils/src/` `scopes`
  entry (previously needed only by the whole-barrel override) is removed. `compilerOptions.types`'s
  own `../utils/src/typings/index.d.ts` raw-path entry carried the identical risk on the
  type-checking side (its `Logger` type reference resolved against the same unpublished checkout) —
  replaced with a new, small, local ambient file, `src/typings/zanix-global.d.ts`, declaring the
  same `Znx`/`Window` global through `ZanixGlobal` (`@zanix/types`, a new alias for the real
  published `jsr:@zanix/utils@^3.0.0/types`) instead of a raw path into any checkout — matching
  `@zanix/datamaster`'s own real, already-fixed precedent for this exact shape. **Once
  `@zanix/utils` v4 publishes** (dropping the `@zanix/helpers` override back to a real
  `jsr:@zanix/utils@^4.0.0/helpers` specifier, per the TEMP note above), the `./src/@tests/` scope
  entry for it goes with it; `src/typings/zanix-global.d.ts` and the `@zanix/types` alias stay
  regardless — they never depended on the unpublished checkout and are this package's permanent,
  checkout-independent way of declaring the `Znx` global. `deno
  fmt`/`lint`/`check` clean, full
  suite green (277/277).

## [0.2.0] - 2026-08-23

### Added

- **`registerControlPlaneProvider`** (`src/modules/runtime/control-plane/core.ts`), now exported —
  reachable via `@zanix/app/core`. Still runs automatically once, at import time, exactly as before;
  the new export lets a caller re-register after clearing the `'type:provider'` registry
  (`ProgramModule.targets.resetContainer(['type:provider'])`, `@zanix/server`) without needing a
  fresh module evaluation — for a config-reload in a long-running process, or a test simulating a
  different state between cases. Same pattern adopted across `@zanix/datamaster`, `@zanix/auth`,
  `@zanix/asyncmq`, and `@zanix/notifications` in the same batch of work.

### Fixed

- `deno lint`'s own `@zanix/utils` plugin (`deno-zanix-plugin`) is now version-pinned (`^3.0.0`),
  matching every other `@zanix/utils` import in `deno.jsonc` — it used to resolve unpinned, so a
  lint run could silently pick up a newer, unreviewed plugin version.
- `POST /__zanix-ops/{appName}/service-token` (`remote-dispatch-route.ts`'s `exchange`) and
  `POST /__zanix-mcp/service-token` (`mcp-route.ts`'s `exchange`) both crashed with an unhandled
  `TypeError: Cannot read properties of undefined (reading 'assertion')` whenever the request body
  couldn't be parsed (missing/wrong `Content-Type`, empty body, invalid JSON) — `ctx.payload.body`
  was read directly with no `Body` RTO declared, so a bad request never got a clean `400`, just a
  500. Both now validated against a new `ServiceTokenExchangeRTO` (`rtos/service-token.rto.ts`), the
  same contract `@zanix/admin`'s own `ServiceExchangeRTO` already establishes for the equivalent
  `/admin/service-token` REST route.
  - New dependency: `@zanix/validator` (already published as part of `@zanix/utils`).
- `buildSandboxedHandler` (`sandbox-operation.ts`): a `sandbox`-declared operation's own
  `WorkerManager` (`@zanix/workers`) calls the global `Znx.logger` unconditionally whenever its
  worker errors or times out, but nothing a `sandbox`-only app necessarily imports installs that
  global first. Without it, `WorkerManager`'s own error/timeout handling threw a `ReferenceError`
  inside its `worker.onmessage`/`onerror` callback — silently swallowed (an exception thrown while
  already handling a Worker `error` event is never re-reported) — so `onFinish` never ran and the
  operation's own `Promise` hung forever instead of ever rejecting `SANDBOX_TASK_FAILED`. Fixed by
  importing `@zanix/logger` once, at module load, in `sandbox-operation.ts` itself, regardless of
  whether the app declares any `sandbox` operations at all.

## [0.1.0] - 2026-08-17

### Added

- **`AppDefinition.behaviors`** — a new, lightweight manifest field for a pure function/strategy an
  app declares as swappable by whoever composes it, deliberately distinct from `resources`/
  `dependencies`: no construction, no `close()`, no health-gating, no quotas — just a function with
  a sensible default, resolved the same way whether a host overrides it or not. Reach for
  `resources` when the swappable thing needs a real lifecycle; reach for `behaviors` when it's a
  plain function (a pricing rule, a formatting strategy, a routing decision) that using `resources`
  would force into modeling as a stateful connector it isn't.
  ```ts
  defineZanixApp({
    name: 'billing',
    behaviors: {
      calculateDiscount: {
        default: (order) => order.total * 0,
        description: 'No discount by default.',
      },
    },
    setup: async (ctx) => {
      const discount = ctx.behavior('calculateDiscount')(order)
    },
  })
  ```
  `ctx.behavior<T = unknown>(name)` (new on `RuntimeContext`, alongside
  `resource`/`config`/`remote`) resolves to a host-supplied override if one was given, else to the
  manifest's own declared default, else `undefined` — same "override, else default" precedence
  `config.get` already follows for its own overlay. `T` is manually specified, not inferred (`name`
  is just a string, with no type-carrying shape to infer from) — purely ergonomic sugar for
  `ctx.behavior<T>(name) ?? default` to type-check without an external cast, exactly as sound as an
  `as T` would be, never more. `activateApps()`'s new `behaviors` parameter (`BehaviorOverride[]` —
  `{appName, name,
  implementation}`) is how a host supplies an override; unlike `bindings` (which
  names an ALTERNATIVE RESOURCE to resolve), the replacement implementation is given directly —
  there's no construction step to defer. Throws (before anything else is constructed) if an override
  names an app not present in the activation, or a behavior name that app never declared — same
  fail-fast posture `validate()` already has for `uses` naming an unknown slot.
- **`resolveBehavior<T = unknown>(appName, name): T | undefined`** (`./runtime`) — resolves a
  behavior override-or-default OUTSIDE any `RuntimeContext` (e.g. a `@zanix/space` page overriding a
  single Comet, which has no `setup`/`onStart`/`onStop` context to call `ctx.behavior()` from).
  `ctx.behavior()` now delegates to this exact function internally, so the two entry points can
  never resolve differently — one registry, two ways in. `behaviors` itself stays a general,
  UI-agnostic abstraction: a Comet is, structurally, just a function, so registering one as a
  `behaviors` default needs no special framework integration — `@zanix/app` gains no Preact/React
  dependency either way.
- `ControlPlaneRegistry`/`ControlPlaneConfig` (`./runtime`) — Redis-backed remote app discovery and
  hot-refresh, non-secret config, built on `@zanix/datamaster`'s `ZanixRedisConnector`. No
  `AppContainer`/lifecycle wiring yet — standalone primitives, consumed directly by
  `ctx.remote()`/`HttpRemoteAdapter` below.
- `DeploymentTarget`/`EmbeddedDeploymentTarget`/`RemoteDeploymentTarget` types (both entry points) —
  the routing-target shape the above two classes and a future Gateway operate on.
- `AppDefinition`/`NormalizedAppDefinition.operations` (`OperationHandler`) — named handlers OTHER
  Zanix Apps invoke via `ctx.remote()`, separate from `routes`.
- `RuntimeContext.remote(name)` — resolves a callable handle to another Zanix App: local-first (zero
  network, zero serialization, when `name` is active in this same process), falling back to
  `HttpRemoteAdapter` (real HTTP, `@zanix/auth` service-token exchange, W3C `traceparent`, mandatory
  `timeoutMs` via `AbortSignal.timeout()`) when it isn't. Available on `setup`/`onStart`/`onStop`
  and inside any `operations` handler.
- `activateApps`'s new optional 4th parameter (`dispatcher?: HttpRemoteDispatcher`) — explicit
  override; omitted (the default), auto-detects the `'controlPlane'` core-provider slot (see
  `@zanix/app/core` below), falling back to local-only if that slot was never registered either.
- A remotely-callable app (one with `operations`) is automatically served at
  `/__zanix-ops/${appName}/...`, independent of its own `routes`/mount prefix — the service-token
  exchange endpoint plus one `@AuthTokenValidation({type: 'api'})`-protected dispatch endpoint. No
  routes added for an app with no `operations`.
- `@zanix/app/core` (new, third entry point) — side-effect-only, same category as
  `@zanix/datamaster/core`/`@zanix/auth/core`: importing it registers `ZanixControlPlaneProvider`
  under the `'controlPlane'` core-provider slot, reusing `this.cache.redis` (the connector any other
  part of the process already shares via the `'cache'` provider) instead of opening a second one.
  `activateApps` auto-detects this slot as its default `HttpRemoteDispatcher`. Never imported,
  `ctx.remote()` stays local-only — zero cost, zero Redis connection.
- `AppDefinition`/`NormalizedAppDefinition.runtime` (`RuntimeModeOptions`: `mode`/`replicas`) — the
  author's own DEFAULT execution-mode suggestion. Stored/normalized only; `activateApps`'s
  `remoteInstances` (below) is what actually decides remote behavior for a given process.
- `activateApps`'s new optional 5th parameter,
  `remoteInstances: Record<appName,
  RemoteInstanceOptions>` — announces each named app to the
  Control Plane Registry AFTER its own local `onStart`: registers `{endpoint}` with a lease, renews
  it on a heartbeat (a live instance never lets its own lease expire), and subscribes to Config
  Plane hot-refresh for every non-secret `config` key it declared (never for `secret: true` keys,
  enforced here, not left to caller discipline). `deactivateApps` deregisters each announced
  instance BEFORE running `onStop` — symmetric with how it was announced.
- `ctx.config.get`/`has` now check a Config Plane hot-refresh overlay first (`config-overrides.ts`)
  — a `ControlPlaneConfig.setConfig` push reaches a subscribed instance's `ctx.config.get(key)`
  immediately, no restart. Untouched for any embedded app that never subscribes.
- `HttpRemoteAdapter`'s constructor takes an optional second argument, `HttpRemoteAdapterTlsOptions`
  (`cert`/`key`/`caCerts`, PEM strings) — presents a client certificate on every outgoing call via
  `Deno.createHttpClient`, confirmed end-to-end against an independent mTLS-enforcing server. Covers
  the WHOLE round trip, not only the operation call: `#authClientFor` passes the same
  `Deno.HttpClient` into `createServiceAuthClient`'s own new `httpClient` option (see
  `@zanix/auth`'s changelog), so the service-token exchange presents a certificate too. A failure
  exchanging a token (e.g. an mTLS-enforcing target rejecting an uncertified caller) is now
  normalized into the same `InternalError`/`REMOTE_CALL_FAILED` the operation call's own failures
  already use, rather than leaking a raw `HttpError`. `HttpRemoteAdapter.close()` releases the TLS
  client's connection pool when one was configured.
- `mtls-dispatch-server.ts` (`MtlsDispatchOptions`/`MtlsDispatchServer`/`startMtlsDispatchServer`,
  `./runtime`) — a dedicated listener, built on Deno's `node:https` compatibility layer, that
  genuinely enforces the INCOMING half of mTLS for the `/__zanix-ops/...` dispatch surface only:
  `requestCert`/`rejectUnauthorized`, confirmed end-to-end (rejects a connection with no client
  certificate, accepts a valid one, exposes the peer certificate) — current stable Deno's own
  `Deno.serve()`/`Deno.listenTls()` still can't do this
  ([denoland/deno#26825](https://github.com/denoland/deno/issues/26825)), so this listener is a
  narrow, separate opt-in rather than a retrofit of `@zanix/server`'s own routing, which is
  untouched either way. Reuses `@zanix/auth`'s `exchangeServiceCredential`/`verifyJWT`/
  `getSecretByToken`/`DEFAULT_AUTH_ISSUER` and `@zanix/server`'s `AUTH_HEADERS` directly — no new
  auth mechanism. Opt in per remote instance via `RemoteInstanceOptions.mtls`
  (`announceRemoteInstance` starts it after registering with the Control Plane, and
  `AnnouncedRemoteInstance.stop()` closes it again).
- `LeaderElection` (`./runtime`, `control-plane/leader-election.ts`) — Redis-backed leader election
  for scheduled jobs: atomic `SET NX EX` acquire + a Lua compare-and-extend renewal script, plus a
  monotonic fencing token that only bumps on a fresh acquire (never on a renewal). Resolved via the
  `'controlPlane'` core-provider slot's new `leaderElection` getter, same memoized-per-instance
  pattern as `controlPlaneRegistry`/`controlPlaneConfig`.
- `registerNamespacedJobs` now wraps a scheduled (`schedule` present) job's `handler` with
  `wrapWithLeaderElection` — only the ONE replica currently holding `${appName}:${jobName}`'s lease
  actually runs a given tick; every other replica's own delivery of that same tick is a no-op. A
  no-op passthrough (unwrapped) when no `'controlPlane'` slot is registered — the single-process
  case, where there's nothing to coordinate. Never applied to a non-scheduled job: its own delivery
  is already exactly-once-per-message via the underlying queue's competing-consumer semantics
  (confirmed against `@zanix/asyncmq`'s actual RabbitMQ dispatch).
- `getJobFencingToken(context)`/`isJobFencingTokenCurrent(appName, jobName, context)` (`./runtime`)
  — lets a scheduled job's handler re-validate its own fencing token against the value currently
  vigente in Redis immediately before committing a side effect. Doesn't remove the double-dispatch
  window (a real limit of any TTL-based lease under network partition, not specific to Redis), but
  does remove the double-effect.
- `compareReplicas(def, registry)` (`./runtime`) — compares a manifest's own `runtime.replicas`
  against what the Control Plane Registry actually observes right now. Purely diagnostic — never
  starts, stops, or otherwise acts on a mismatch; a host wires the result into its own alerting.
- `createGatewayPreHandler(registry, options?)` (`./runtime`) — the Gateway: routes PUBLIC/external
  traffic to a `remote` app, closing the gap `ctx.remote()` deliberately left open (that's
  app-to-app calling). Built on `@zanix/server`'s own `PreHandler` extension point (the same one
  `@zanix/space`'s dev server already uses) — returns `undefined` on every request that isn't a
  remote app's own traffic, falling through to this process's normal routing unchanged. Two
  resolution strategies, tried in order: by the request path's own first segment (direct
  `registry.getDeploymentTarget` lookup — works when an app's mount prefix is its own bare name,
  with nothing else ahead of it), then `options.defaultRemoteApp` (for a whole-domain app,
  `routes: {prefix: ''}`, whose paths carry no app-identifying segment at all).
  `options.localAppNames` is checked before either strategy — never shadows an app this process runs
  locally. A genuine reverse proxy (method/headers/body forwarded as-is, streamed) to one of the
  resolved target's live endpoints; an unreachable target responds `502` directly, never throws.
  `PreHandler` now re-exported from `./runtime` alongside it.
- `HttpRemoteAdapter.dispatch()` and the Gateway now spread calls across a target's live endpoints
  round-robin (`RoundRobinPicker`, new, `./runtime`) instead of a plain random pick — evenly
  distributes consecutive calls even with few endpoints or low call volume, where random selection
  could still repeat the same endpoint several times in a row purely by chance.
- `LeaderElection`'s constructor now also accepts an ARRAY of Redis connectors — a Redlock upgrade
  path for a host already running Redis in high availability: every method switches to
  majority-quorum semantics automatically (`floor(N/2) + 1` instances agreeing, with the same
  clock-drift discount the original Redlock write-up applies before trusting a quorum acquire). Same
  public API, same `ctx`/manifest contract — a single connector (still the default) keeps the exact
  single-instance behavior unchanged. Every per-instance operation is internally bounded to a short
  timeout — without it, one unreachable instance could make the whole quorum check hang indefinitely
  instead of tolerating a minority failing, defeating Redlock's entire purpose.
- `ResourceDeclaration` (`resources`/`localResources`/`RootResources`) now also accepts a
  `{type, mode: 'remote', endpoint}` shape (`RemoteResourceDeclaration`, new type) — Remote Resource
  Binding: `ctx.resource(slot)` resolves to a `RemoteAppHandle`
  (`{call(operationName, payload, options)}`, the exact same shape `ctx.remote(endpoint)` already
  returns) instead of a real connector instance, reusing that same mechanism end-to-end
  (local-first, `HttpRemoteAdapter` otherwise) — no new dispatch mechanism. Deliberately NOT
  transparent: a local resource still resolves to its real connector's own native method surface, a
  remote one to this RPC handle — a real, disclosed difference, not the invisible proxy the original
  design note described (rejected as either a per-resource-type proxy class or blanket
  reflection-based forwarding, both new mechanisms this package would then own). `type` is still
  checked against `dependencies.<slot>.type` by `validate()`, same as a local resource.
  `resolveResources`'s new optional 3rd parameter, `dispatcher?: HttpRemoteDispatcher`, is what a
  remote key's handle dispatches through — `activateApps` already passes its own dispatcher.
- `RemoteResourceDeclaration.requiredVersion` — cross-app manifest version validation: an optional
  semver range (`@std/semver`, new dependency) the endpoint app's own `version` must satisfy.
  Checked by `validate()` only when the endpoint app is ALSO part of the SAME composition
  (`graph.apps`) and declared a `version` of its own — an actually cross-process target isn't
  checked at all (would need an async Control Plane lookup, which `validate()` stays deliberately
  synchronous and fail-fast to avoid), documented as a real, honest limitation rather than silently
  skipped. Throws `REMOTE_RESOURCE_VERSION_MISMATCH` if checked and unsatisfied,
  `INVALID_VERSION_RANGE` if either version string isn't valid semver.
- `installApp`/`uninstallApp` (`./runtime`) — hot install/uninstall of ONE app into an
  already-running process, scoped to routes + resources + operations; `jobs`/`events` remain
  restart-only (AsyncMQ's own registry is append-only and its worker/cron providers snapshot it once
  at construction — reworking that is a separate, already-published package's own concern, out of
  scope here). Both extend/shrink the SAME `ActivatedApps` bundle `activateApps` returns —
  `ActivatedApps` gained `rootResources`/`bindings`/`dispatcher` fields so a later
  `installApp`/`uninstallApp` call doesn't need those re-supplied. `installApp` re-validates the
  FULL merged graph (existing apps + the new one) fail-fast before resolving/registering anything,
  but only resolves the new app's OWN resources — a slot resolving to an already-shared root
  resource reuses that instance via `ResourceRegistry`'s existing promise-memoization.
  `uninstallApp` blocks fail-fast (`APP_STILL_REQUIRED`) if another active app has a REQUIRED
  `mode: 'remote'` dependency resolving to the target app — a documented boundary, since an ad-hoc
  `ctx.remote(appName)` call site carries no manifest declaration to check against.
- `ResourceRegistry.resolve`'s new optional 3rd parameter, `ownerApp` — `resolveResources` now
  passes every app's own name here, and `ResourceRegistry.release(qualifiedKey, ownerApp)` (new)
  removes that one reference, closing the instance only once NO app references it anymore. A
  resource shared by three apps survives two of them being hot-uninstalled and closes cleanly when
  the third goes.
- `ProgramModule.unregisterApplicationRoutes(appName)` / `RouteContainer.removeRoutesForApplication`
  (`@zanix/server`) — removes one Application's own route metadata, safer to call than the
  pre-existing `resetExceptApplications` when the caller only knows ONE app's own name (that one
  requires enumerating every OTHER Application in the process to `preserve`). Paired with the new
  `WebServerManager.unmount(id)`, which atomically strips just that server's own dispatch entry from
  its port's shared `HandlerBox` (same freeze-and-swap `create()` itself already uses) without ever
  touching the real socket other Applications sharing that port still depend on — together, what
  makes an uninstalled app's routes 404 immediately instead of only at the metadata level.
- `operations.<name>.allowedCallers` (`OperationDeclaration`) — per-operation, capability-based
  permission scoping: an operation can restrict WHICH Zanix Apps may invoke it, instead of any
  caller holding a valid service token being able to invoke ANY operation (the previous, all-or-
  nothing behavior). `operations.<name>` now accepts either a bare `OperationHandler` (unchanged,
  fully public — every existing app keeps working with zero changes) or
  `{handler, allowedCallers?:
  string[]}` — `'*'` as a member, or omitting the field, both mean
  public. Enforced at BOTH dispatch points: `createRemoteCaller`'s local-first branch (so two apps
  embedded in the same process can't bypass the ACL just by being co-located) and
  `remote-dispatch-route.ts`'s HTTP `dispatch()` (checked against the exchanged service token's
  `sub` claim, right after `@AuthTokenValidation({type:'api'})` validates the token itself) — denied
  with `InternalError` `OPERATION_ACCESS_DENIED` locally, `HttpError('FORBIDDEN')` (surfacing as
  `REMOTE_CALL_FAILED`/HTTP 403 through `HttpRemoteAdapter`) remotely.
  `isCallerAllowed(allowedCallers, callerAppName)` (new, `./runtime`) is the one shared check both
  paths call. First of four related tracks toward a fuller platform story — see the following
  `Added` entries for the other three.
- `operations.<name>.mcp` (`McpToolDeclaration`: `description`/`inputSchema?`) — opts ONE operation
  into being exposed as an MCP (Model Context Protocol) tool an AI agent can discover and invoke.
  Deliberately opt-in per operation (never automatic for every public one) — operations have no
  schema/description mechanism today (`@zanix/validator`'s own decorators are imperative validators,
  not an introspectable schema source, confirmed before designing this), so an agent-usable tool
  needs an author to write its `description`/`inputSchema` by hand. `listMcpTools()` (new,
  `operation-registry.ts`) surfaces every currently-registered `mcp`-declared operation across every
  active app, namespaced `${appName}.${operationName}`. `handleMcpRequest` (new, `mcp-server.ts`)
  implements the core MCP flow verified against the official spec
  (modelcontextprotocol.io/specification/2025-06-18) — `initialize` (echoes the client's own
  `protocolVersion`), `notifications/initialized`, `tools/list`, `tools/call` — correctly
  distinguishing PROTOCOL errors (unknown method/tool, a JSON-RPC `error`) from TOOL EXECUTION
  errors (access denied, the handler throwing — `result.isError: true`), exactly the split the spec
  itself draws. `registerMcpServer()` (new, `mcp-route.ts`, explicit opt-in like `@zanix/app/core`'s
  own side-effect pattern, idempotent) serves ONE aggregated `POST /__zanix-mcp` endpoint for the
  WHOLE process (every active app's tools, not one endpoint per app) — an MCP client authenticates
  via the exact same service-token exchange a remote Zanix App already uses, under its own
  `serviceId` (e.g. `agent:claude-desktop`), and that identity is checked against `allowedCallers`
  exactly like any other caller's — no second permission model. Real, documented scope boundaries
  for a first, useful implementation, not a full-spec MCP server: no `resources`/
  `prompts`/`logging` capabilities, no pagination, no `listChanged` notifications, no
  `Mcp-Session-Id` session management, no SSE streaming (every response is a single
  `application/json` body — spec-legal). Second of four related tracks — see the following entries
  for the other two.
- `ResourceRegistry.setQuota(ownerApp, maxInstances)`/`.clearQuota(ownerApp)` — caps how many
  DISTINCT resource instances one app may hold a reference to at once, checked in `resolve()` BEFORE
  `factory` ever runs, throwing `InternalError` `RESOURCE_QUOTA_EXCEEDED` (counts distinct
  `qualifiedKey`s, including referencing an already-shared root resource — one unit of consumption
  either way, not construction events). `InstallAppOptions.maxResources` (new) sets this for a
  hot-installed app at `installApp` time; `uninstallApp` clears it automatically so a later install
  reusing that exact app name never inherits a stale ceiling. Third of four related tracks
  (multi-tenancy with quotas) — but the bigger finding here was that isolation itself
  (resources/config/routes/rate-limiting) already worked, since every one of those is already scoped
  by app name: installing the same app definition under a distinct name per tenant already gives
  full isolation with zero new code. This quota is the one genuinely missing piece — a ceiling on
  shared-infrastructure consumption, not a new tenancy primitive.
- `operations.<name>.sandbox` (`SandboxDeclaration`: `metaUrl`, `taskName?`, `permissions?`,
  `timeout?`) — an operation declared this way runs inside its OWN dedicated, permission-restricted
  Deno Worker instead of inline in the main process, via a new `buildSandboxedHandler`
  (`sandbox-operation.ts`). Scoped to `operations` only (routes/`onStart`/`onStop`/resource
  construction still run inline — the honest v1 boundary). A hard structural constraint, not a
  stylistic one: a Worker only communicates via `postMessage` (structured-clone), so a sandboxed
  operation can never receive a live `RuntimeContext` — it's authored as a plain function taking
  only `payload`, exported from a real module (never an inline closure), reusing `@zanix/workers`'
  own `WorkerManager` task convention. Deliberately NOT `ZanixWorkerProvider`'s shared, generic
  `this.worker` pool — a persisted pool can't mix per-operation-specific restricted permission
  profiles, and there is no DI `this` context inside `registerOperations` to resolve it through
  anyway; each `sandbox` declaration gets its own dedicated `WorkerManager` instead, closed by
  `uninstallApp` (new `closeSandboxedWorkers`) alongside a hot-uninstalled app's own resources. Any
  failure (permission denial, a thrown/rejected task, a `timeout`) surfaces uniformly as
  `InternalError` `SANDBOX_TASK_FAILED`. `permissions` restricts ACCESS
  (`net`/`read`/`write`/`env`/`run`/`ffi`/`sys`, forwarded as-is to `Worker`'s own
  `deno.permissions` — requires Deno's still-unstable `worker-options` feature, and, since it
  replaces the WHOLE permission set rather than inheriting unlisted categories, the task's own
  module needs `read`/`net` regardless of what the task itself does, just to be importable) — it is
  NOT a CPU-time or memory quota; Deno's `Worker` API has no such governance option today, so
  `timeout` (reusing `WorkerManager`'s existing timeout-then-terminate mechanism, now fixed to
  actually settle instead of hanging — see `@zanix/utils`' own changelog) is the only available
  protection against a runaway/CPU-bound sandboxed task. Fourth and final of these related tracks.
- `bootstrapRemoteApp(zanixAppDefinition, options)` (`./runtime`) — bootstraps a Zanix App as its
  own standalone, production-facing remote process: `activateApps` (with `options.remoteInstances`,
  unlike `.serve()`, which never announces to the Control Plane) + `bootstrapAppServer`, plus real
  `SIGINT`/`SIGTERM` graceful shutdown mirroring `@zanix/core`'s own `Zanix.start()`/`Zanix.stop()`
  exactly (`deactivateApps` before the web servers themselves stop; listeners removed before running
  so a second signal, or a caller-invoked `stop()`, can never double-run the shutdown). Deliberately
  NOT `.serve()` with extra options bolted on — `.serve()` stays exactly what it always was (the
  author's own local dev loop, no Control Plane announcement, no signal handling); this reuses the
  exact same `activateApps`/`bootstrapAppServer` primitives, never a second, parallel
  implementation. `@zanix/cli`'s `zanix prepare --docker -p app` (see its own changelog) scaffolds a
  `serve.ts` entrypoint calling this, plus a matching `deno.json` `serve` task and a `Dockerfile` to
  run it. DX/deploy pipeline track, independent of the four related tracks above.

### Documentation

- **README's `resolveBehavior()` section gains "Style-only overrides"** — documents the pattern for
  when a host wants a shared component's PRESENTATION to be swappable without reimplementing (or
  forking) its own logic: the component itself resolves a style-shaped `behaviors` value (a
  className/style object) for its own prop, rather than a page resolving an entire replacement
  component. Explicitly not a new registry or API — same `behaviors`/`resolveBehavior`, just
  resolved by the component for a style value instead of by a caller for a whole replacement. One
  stated precondition: this only works for a component whose own author already added the
  `resolveBehavior` call for its style — same precondition every `behaviors` slot already has; it
  does not retroactively make an arbitrary existing component's style overridable from outside.

### Fixed

- `mtls-dispatch-server.ts`'s `handleRequest` verified the presented service token
  (`verifyServiceToken`) but never checked the resolved operation's own `allowedCallers` against it
  — unlike `remote-dispatch-route.ts`'s HTTP dispatch path, which already enforced this. Concretely:
  any caller holding a valid service token could invoke ANY operation of ANY app over the mTLS
  transport, including one whose `allowedCallers` restricted it to a specific caller over HTTP — the
  two transports were not actually interchangeable for authorization purposes, despite the docs
  describing them as such. `verifyServiceToken` now returns the token's own `sub` claim, and
  `handleRequest` calls `isCallerAllowed` with it before dispatching, denying with a `403` exactly
  like the HTTP path's `FORBIDDEN` — same check, same shared `isCallerAllowed`, all three dispatch
  points now consistent.
- `remote-dispatch-route.ts`'s `:operationName` route param was read back as
  `ctx.payload.params.operationname` — a workaround for a real `@zanix/server` bug (a route param's
  own NAME was silently lowercased, not just matched case-insensitively; see that package's own
  changelog). Now that the router preserves param-name casing, this reads the corrected
  `ctx.payload.params.operationName` key.
