/**
 * `@zanix/app/runtime` — the entry point that wires a Zanix App manifest into a real, running
 * process (`AppContainer`, `ResourceRegistry`). This DOES depend on `@zanix/server` (and, as more
 * lands, on `@zanix/asyncmq`/`@zanix/datamaster`/`@zanix/auth`) — it is the one half of
 * `@zanix/app` that can't avoid it: registering a real HTTP route or a real DI resolution is
 * `@zanix/server`'s own job (`ProgramModule`/`RouteContainer`/`TargetContainer`), not something
 * this package reimplements.
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

export { type CloseableResource, ResourceRegistry } from 'modules/runtime/mod.ts'
export { registerApp } from 'modules/runtime/mod.ts'
export { getNamespacedJobOrigin, type NamespacedJobOrigin } from 'modules/runtime/mod.ts'
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
export { activateApps, type ActivatedApps, deactivateApps } from 'modules/runtime/mod.ts'
export { bootstrapAppServer, type ZanixAppServerOptions } from 'modules/runtime/mod.ts'
export { webServerManager } from 'modules/runtime/mod.ts'
