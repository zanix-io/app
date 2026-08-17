# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/en/1.0.0/) and this project
adheres to [Semantic Versioning](http://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
