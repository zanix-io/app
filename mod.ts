/**
 * `@zanix/app` — pure manifest/type surface for a Zanix App.
 *
 * This entry point (`.`) holds no RUNTIME dependency of its own — it only holds the manifest
 * shapes, `defineZanixApp()`, and the PURE half of `AppContainer`'s namespace
 * (`normalize`/`buildGraph`/`validate` — no I/O, no server calls). Anything that only needs to
 * author or type-check a manifest (tooling, a CLI scaffold) never pulls in a full web server. The
 * orchestration that actually wires a manifest into a running process (`resolveResources`,
 * `registerApp`, `runOnStart`/`runOnStop`, `ResourceRegistry`, `ctx`) lives in the separate
 * `@zanix/app/runtime` entry point, which DOES depend on `@zanix/server` — see that module's own
 * doc for why the split exists and the dependency-direction guarantee behind it.
 *
 * One TYPE-level exception, deliberate: `typings/manifest.ts`'s job/cron shapes (`Job`/
 * `JobProcess`/`CronJobDefinitionBase`/`ProcessingQueues`) are real `import type`s from
 * `@zanix/asyncmq`'s narrow `./jobs` subpath. That subpath stays free of `amqplib`/
 * `@zanix/database` (`mongoose`/`redis`/`@aws-sdk/*`), but needs `@zanix/server` for its own
 * `MessageQueue`/`HandlerContext`/provider-getter types — and `@zanix/server`'s own published root
 * graph carries a separate `graphql`/`redis` reference of its own, unrelated to this package. See
 * `typings/manifest.ts`'s own doc for the full reasoning: Deno's `nodeModulesDir: "auto"`
 * materializes every npm package reachable from a module's import graph for every consumer,
 * whether or not that consumer ever exercises the capability needing it, so a type-only import is
 * never automatically free of that cost.
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
// reachable from this entry point too. Erased at build time, but still resolved for real by
// `deno check`/`zanix space build`'s own graph walk (see this module's own header doc: Deno's
// `nodeModulesDir: "auto"` materializes every npm package reachable from an import graph
// regardless of whether the reachable code actually uses it, so a type-only import never escapes
// that cost) — each type is imported from its own narrow DEFINING file below, never from the
// `./runtime` barrel
// (`modules/runtime/mod.ts`), so this entry point's reachable graph stays exactly as wide as these
// six types actually need, and never silently grows if the barrel gains an unrelated heavy
// re-export later. `ActivatedApps`/`AnnouncedRemoteInstance` come from `activation-types.ts`
// specifically, NOT from `activate-apps.ts`/`remote-lifecycle.ts` (where each result's own
// producing function lives): those two files' own real value-level/type-level imports
// (`control-plane/mod.ts`, `http-remote-adapter.ts`) resolve `@zanix/datamaster/cache`'s real
// `redis` import — confirmed via a real `deno info` reachability check that a bare `import type
// {ActivatedApps} from '.../activate-apps.ts'` drags `redis` into this entry point's graph despite
// referencing nothing but a type; see `activation-types.ts`'s own doc for the fix.
// `ZanixAppServerOptions`'s own file still needs `@zanix/server`'s root for real
// (`bootstrapServers`) — that's the one already covered by this module's header doc.
export type { ActivatedApps, AnnouncedRemoteInstance } from 'modules/runtime/activation-types.ts'
export type { HttpRemoteDispatcher, RemoteCallerFactory } from 'modules/runtime/remote-caller.ts'
export type { ResourceRegistry } from 'modules/runtime/resource-registry.ts'
export type { ZanixAppServerOptions } from 'modules/runtime/bootstrap-app-server.ts'
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
