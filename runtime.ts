/**
 * `@zanix/app/runtime` — the entry point that wires a Zanix App manifest into a real, running
 * process (`AppContainer`, `ResourceRegistry`). This DOES depend on `@zanix/server` — the one
 * half of `@zanix/app` that can't avoid it: registering a real HTTP route or a real DI resolution
 * is `@zanix/server`'s own job (`ProgramModule`/`RouteContainer`/`TargetContainer`), not something
 * this package reimplements.
 *
 * It does NOT unconditionally depend on `@zanix/asyncmq`/`@zanix/datamaster`/`@zanix/auth`,
 * despite `activateApps()` supporting `jobs`/`resources`/remote-callable `operations` — each of
 * those three packages is reached through a deliberately non-literal `import()` specifier (see
 * `register-jobs.ts`/`resource-types.ts`/`http-remote-adapter.ts`'s own docs for the full
 * reasoning), evaluated ONLY when a manifest genuinely declares the corresponding capability. A
 * `bootstrapRemoteApp()` caller whose manifest declares none of the three (e.g. a bare
 * `@zanix/space` app) never resolves any of them — confirmed via `deno info`'s own code-reachable
 * module graph, not just asserted. This matters beyond cold-cache download time: a bundler
 * resolving this entry point (e.g. `zanix space build`'s Vite/Rolldown pipeline) walks the same
 * graph, so a project that never uses jobs/resources/remote operations never pays for
 * `mongoose`/`mongodb`/`redis`/`amqplib` either.
 *
 * Split from the pure-manifest entry point (`.`, `mod.ts`) deliberately: anything that only needs
 * to author/type-check a manifest (a CLI scaffold, a lint rule, a build-time validator) imports
 * `.` alone and never pulls this in. `@zanix/server` itself never imports anything from this
 * module or from `.` — the dependency graph is a strict DAG (verified against `@zanix/server`'s
 * own `mod.ts`, which has zero references to `@zanix/app`), so there is no cycle regardless of how
 * many other packages (`@zanix/core`, `@zanix/admin`) depend on both sides at once.
 *
 * @module
 */

export {
  type CloseableResource,
  /** Owns the lifecycle and cache of every resource a Zanix App's `resources`/`uses` resolve to. */
  ResourceRegistry,
} from 'modules/runtime/mod.ts'
export { registerApp } from 'modules/runtime/mod.ts'
export { getNamespacedJobOrigin, type NamespacedJobOrigin } from 'modules/runtime/mod.ts'
export {
  getJobFencingToken,
  isJobFencingTokenCurrent,
  wrapWithLeaderElection,
} from 'modules/runtime/mod.ts'
export { resolveResources } from 'modules/runtime/mod.ts'
export {
  getResourceFactory,
  registerResourceType,
  type ResourceFactory,
} from 'modules/runtime/mod.ts'
export { runOnStart, runOnStop } from 'modules/runtime/mod.ts'
export { buildRuntimeContext } from 'modules/runtime/mod.ts'
export { buildSetupContext } from 'modules/runtime/mod.ts'
export { resolveTarget } from 'modules/runtime/mod.ts'
export {
  activateApps,
  /** Everything {@link activateApps} produced — enough for {@link deactivateApps} to shut the
   * same set of apps back down without the caller re-deriving or re-passing anything. */
  type ActivatedApps,
  deactivateApps,
} from 'modules/runtime/mod.ts'
export { installApp, type InstallAppOptions } from 'modules/runtime/mod.ts'
export { uninstallApp } from 'modules/runtime/mod.ts'
export {
  bootstrapAppServer,
  /** Per-type server config for ONE Zanix App — same shape as `@zanix/server`'s own
   * `BootstrapServerOptions`, minus `application`: this app's own manifest `name` supplies that
   * automatically. */
  type ZanixAppServerOptions,
} from 'modules/runtime/mod.ts'
export { bootstrapRemoteApp, type BootstrapRemoteAppOptions } from 'modules/runtime/mod.ts'
export { webServerManager } from 'modules/runtime/mod.ts'
export {
  type ConfigSubscription,
  ControlPlaneConfig,
  ControlPlaneRegistry,
  LeaderElection,
  type RegisteredInstance,
  type RegisterInstanceOptions,
  resolveControlPlaneProvider,
  ZanixControlPlaneProvider,
} from 'modules/runtime/mod.ts'
export type {
  /** Where a request for `name` should actually go — `'embedded'` (in-process mount) or
   * `'remote'` (its own process, possibly replicated). */
  DeploymentTarget,
  /** An app running inside the same process as its caller — the only mode Zanix Apps had before
   * a cross-process Control Plane existed. */
  EmbeddedDeploymentTarget,
  /** An app running as its own process, discovered through the Control Plane's Registry. */
  RemoteDeploymentTarget,
} from 'modules/runtime/mod.ts'
export {
  getLocalOperation,
  isCallerAllowed,
  listMcpTools,
  type McpToolEntry,
  type RegisteredOperation,
} from 'modules/runtime/mod.ts'
export { handleMcpRequest, type JsonRpcRequest, type JsonRpcResponse } from 'modules/runtime/mod.ts'
export { registerMcpServer } from 'modules/runtime/mod.ts'
export { buildSandboxedHandler, closeSandboxedWorkers } from 'modules/runtime/mod.ts'
export {
  createRemoteCaller,
  /** Dispatches ONE call that already failed the in-process lookup (`getLocalOperation` found
   * nothing) to whatever transport reaches a real remote process — `HttpRemoteAdapter` in v1. */
  type HttpRemoteDispatcher,
  /** Bound to one calling app (`callerAppName`) — `ctx.remote(targetAppName)` partially applies
   * this with the CALLING app's own identity. */
  type RemoteCallerFactory,
} from 'modules/runtime/mod.ts'
export {
  HttpRemoteAdapter,
  type HttpRemoteAdapterTlsOptions,
  resolveDefaultDispatcher,
} from 'modules/runtime/mod.ts'
export { generateTraceparent } from 'modules/runtime/mod.ts'
export type {
  /** What `ctx.remote(name)` resolves to — one target app, ready to receive named operation
   * calls. */
  RemoteAppHandle,
  /** Options a `ctx.remote(name).call(...)` invocation must supply. */
  RemoteCallOptions,
} from 'modules/runtime/mod.ts'
export type {
  /** One `behaviors.<name>` entry — a pure function/strategy an author declares as swappable by
   * whoever composes this app. */
  BehaviorDeclaration,
  /** A behavior override declared by the HOST (`activateApps()`'s own `behaviors` parameter, or
   * `@zanix/core`'s `apps.<name>.behaviors`) — never by the app itself. */
  BehaviorOverride,
  /** A resource constructed and owned by THIS process — the original, always-supported kind. */
  LocalResourceDeclaration,
  /** Opts ONE operation into being exposed as an MCP (Model Context Protocol) tool an AI agent
   * can discover and invoke. */
  McpToolDeclaration,
  /** How one `operations.<name>` entry may be declared — a bare {@link OperationHandler} or an
   * object pairing it with `allowedCallers` (capability-based permission scoping). */
  OperationDeclaration,
  /** One named, protocol-agnostic operation an app exposes to OTHER Zanix Apps via
   * `ctx.remote(name).call(operationName, payload)`. */
  OperationHandler,
  /** A resource this process never constructs at all — `ctx.resource(slot)` resolves to an RPC
   * handle instead of a real connector instance. */
  RemoteResourceDeclaration,
  /** A binding declared by the HOST (`apps.<n>.uses` at `Zanix.start()` time) — never by the
   * app: which concrete resource satisfies the slot the app declared in `dependencies`. */
  ResourceBinding,
  /** Shape of one `resources`/`localResources`/`RootResources` entry. */
  ResourceDeclaration,
  /** Resources declared at the host's root (`SetupOptions.resources`), outside of any app. */
  RootResources,
  /** Base shared by an app's three lifecycle moments (`setup`/`onStart`/`onStop`) — read-only
   * access to already-resolved resources/config, never to construction. */
  RuntimeContext,
  /** The author's own DEFAULT execution mode suggestion — never a command the app itself
   * executes or counts. */
  RuntimeModeOptions,
  /** Runs this operation inside its OWN dedicated, permission-restricted Deno Worker instead of
   * inline in the main process. */
  SandboxDeclaration,
} from 'modules/runtime/mod.ts'
export {
  /** What {@link announceRemoteInstance} returns — everything {@link deactivateApps} needs to
   * cleanly reverse the announcement, symmetric with how it was made. */
  type AnnouncedRemoteInstance,
  announceRemoteInstance,
  type RemoteInstanceOptions,
} from 'modules/runtime/mod.ts'
export { getConfigOverride, hasConfigOverride, setConfigOverride } from 'modules/runtime/mod.ts'
export { resolveConfig } from 'modules/runtime/mod.ts'
export { resolveBehavior } from 'modules/runtime/mod.ts'
export { resolveResource } from 'modules/runtime/mod.ts'
export {
  type MtlsDispatchOptions,
  type MtlsDispatchServer,
  startMtlsDispatchServer,
} from 'modules/runtime/mod.ts'
export { compareReplicas, type ReplicasComparison } from 'modules/runtime/mod.ts'
export { createGatewayPreHandler, type GatewayOptions } from 'modules/runtime/mod.ts'
export type { PreHandler } from 'modules/runtime/mod.ts'
// Type-only re-exports from the pure-manifest side — several public symbols above (`registerApp`,
// `resolveResources`, `runOnStart`/`runOnStop`, `buildRuntimeContext`, `buildSetupContext`,
// `activateApps`, `installApp`, `bootstrapRemoteApp`, `RuntimeContext["config"]`,
// `announceRemoteInstance`, `compareReplicas`) reference these structurally, so JSR needs them
// reachable from this entry point too, same reasoning as `mod.ts`'s own type-only re-export of the
// runtime-side types it needs.
export type {
  /** Exactly as the app's author writes it — `defineZanixApp()`'s parameter. */
  AppDefinition,
  /** The only object an app's code can touch inside `setup(ctx)`. */
  AppSetupContext,
  /** Same shape as {@link RuntimeContext} without `routes()`/`resolve()` — composition has
   * already finished by the time `onStart` runs. */
  AppStartContext,
  /** Same shape as {@link AppStartContext} — resources stay open during `onStop`, closed only
   * after every app's `onStop` has finished. */
  AppStopContext,
  /** Read-only accessor over `config` already resolved/validated at bootstrap — never triggers a
   * new resolution. */
  ConfigAccessor,
  /** Primitive type a `config` entry's value can hold. */
  ConfigValueType,
  /** Shape of one `dependencies` entry as the app AUTHOR writes it — `required` optional
   * (defaults to `false`). */
  DependencyDeclaration,
  /** Pure in-memory structure assembled by `buildGraph()`, consumed by `validate()`. */
  DependencyGraph,
  /** Events an app declares it emits/listens to — untyped payload for now. */
  EventsDeclaration,
  /** One `jobs.<name>` entry. */
  JobDefinitionEntry,
  /** Output of normalizing an {@link AppDefinition} — same data, zero unresolved shorthand,
   * `name` already validated against the slug format. */
  NormalizedAppDefinition,
  /** A fully qualified key for a given `(appName, slot)`, already resolved against
   * `rootResources`/`localResources`/bindings. */
  ResolvedResourceKey,
  /** Fields every {@link ResolvedResourceKey} variant shares, regardless of `mode`. */
  ResolvedResourceKeyBase,
} from 'typings/manifest.ts'
export {
  /** What {@link ZanixAppDefinition.serve} returns — enough to shut this one app back down,
   * mirroring `Zanix.stop()`'s own ordering. */
  type ServeHandle,
  /** {@link ZanixAppDefinition.serve}'s options — the author's OWN local dev loop, never what a
   * real host passes. */
  type ServeOptions,
  /** The ONLY thing that identifies an object as having come from {@link defineZanixApp} — use
   * {@link isZanixAppDefinition} to check it rather than reading this directly. */
  ZANIX_APP_DEFINITION_BRAND,
  /** What {@link defineZanixApp} returns — the only shape `Zanix.start()`'s `apps` option
   * accepts alongside the legacy `AppBootstrapOptions` form. */
  type ZanixAppDefinition,
} from 'modules/manifest/mod.ts'
