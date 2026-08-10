/**
 * Barrel for `@zanix/app/runtime` — the entry point that DOES depend on `@zanix/server` (see
 * `runtime.ts` at the package root for the dependency-direction guarantee). `AppContainer`'s
 * activation half (`resolveResources`/`registerApp`/`runOnStart`/`runOnStop`) and the `ctx` it
 * builds land here as they're implemented.
 *
 * @module
 */
export { type CloseableResource, ResourceRegistry } from './resource-registry.ts'
export { registerApp } from './app-container.ts'
export { getNamespacedJobOrigin, type NamespacedJobOrigin } from './register-jobs.ts'
export { resolveResources } from './resolve-resources.ts'
export { getResourceFactory, registerResourceType, type ResourceFactory } from './resource-types.ts'
export { runOnStart, runOnStop } from './lifecycle.ts'
export { buildRuntimeContext } from './build-runtime-context.ts'
export { buildSetupContext } from './build-setup-context.ts'
export { resolveTarget } from './resolve-target.ts'
export { activateApps, type ActivatedApps, deactivateApps } from './activate-apps.ts'
export { bootstrapAppServer, type ZanixAppServerOptions } from './bootstrap-app-server.ts'
export { webServerManager } from '@zanix/server'
