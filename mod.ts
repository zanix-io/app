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
export type {
  AppDefinition,
  AppSetupContext,
  AppStartContext,
  AppStopContext,
  ConfigAccessor,
  ConfigValueType,
  DependencyDeclaration,
  DependencyGraph,
  EventsDeclaration,
  JobDefinitionEntry,
  NormalizedAppDefinition,
  ResolvedResourceKey,
  ResourceBinding,
  ResourceDeclaration,
  RootResources,
  RuntimeContext,
} from 'typings/manifest.ts'
