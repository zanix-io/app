/**
 * `@zanix/app` — pure manifest/type surface for a Zanix App.
 *
 * This entry point (`.`) is deliberately dependency-free of `@zanix/server` — it only holds the
 * manifest shapes, `defineZanixApp()`, and the PURE half of `AppContainer`'s namespace
 * (`normalize`/`buildGraph`/`validate` — no I/O, no server calls). Anything that only needs to
 * author or type-check a manifest (tooling, a CLI scaffold) never pulls in a full web server. The
 * orchestration that actually wires a manifest into a running process (`resolveResources`,
 * `registerApp`, `runOnStart`/`runOnStop`, `ResourceRegistry`, `ctx`) lives in the separate
 * `@zanix/app/runtime` entry point, which DOES depend on `@zanix/server` — see that module's own
 * doc for why the split exists and the dependency-direction guarantee behind it.
 *
 * @module
 */

export {
  defineZanixApp,
  isZanixAppDefinition,
  type ServeHandle,
  type ServeOptions,
  ZANIX_APP_DEFINITION_BRAND,
  type ZanixAppDefinition,
} from 'modules/manifest/mod.ts'
export { buildGraph, normalize, validate } from 'modules/manifest/mod.ts'
// Type-only — `ServeOptions`/`ServeHandle` above reference these structurally, so JSR needs them
// reachable from this entry point too. Erased at build time, so this does NOT pull `@zanix/server`
// into this entry point's runtime dependency graph (see this module's own doc comment).
export type {
  ActivatedApps,
  AnnouncedRemoteInstance,
  HttpRemoteDispatcher,
  RemoteCallerFactory,
  ResourceRegistry,
  ZanixAppServerOptions,
} from 'modules/runtime/mod.ts'
export type {
  AppDefinition,
  AppSetupContext,
  AppStartContext,
  AppStopContext,
  BehaviorDeclaration,
  BehaviorOverride,
  ConfigAccessor,
  ConfigValueType,
  DependencyDeclaration,
  DependencyGraph,
  EventsDeclaration,
  JobDefinitionEntry,
  LocalResourceDeclaration,
  McpToolDeclaration,
  NormalizedAppDefinition,
  OperationDeclaration,
  OperationHandler,
  RemoteResourceDeclaration,
  ResolvedResourceKey,
  ResolvedResourceKeyBase,
  ResourceBinding,
  ResourceDeclaration,
  RootResources,
  RuntimeContext,
  RuntimeModeOptions,
  SandboxDeclaration,
} from 'typings/manifest.ts'
export type {
  DeploymentTarget,
  EmbeddedDeploymentTarget,
  RemoteDeploymentTarget,
} from 'typings/deployment.ts'
export type { RemoteAppHandle, RemoteCallOptions } from 'typings/remote.ts'
