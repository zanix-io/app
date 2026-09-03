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
export {
  getJobFencingToken,
  isJobFencingTokenCurrent,
  wrapWithLeaderElection,
} from './job-leader-election.ts'
export { resolveResources } from './resolve-resources.ts'
export { getResourceFactory, registerResourceType, type ResourceFactory } from './resource-types.ts'
export { runOnStart, runOnStop } from './lifecycle.ts'
export { buildRuntimeContext } from './build-runtime-context.ts'
export { buildSetupContext } from './build-setup-context.ts'
export { resolveTarget } from './resolve-target.ts'
export { activateApps, type ActivatedApps, deactivateApps } from './activate-apps.ts'
export { installApp, type InstallAppOptions } from './install-app.ts'
export { uninstallApp } from './uninstall-app.ts'
export { bootstrapAppServer, type ZanixAppServerOptions } from './bootstrap-app-server.ts'
export { bootstrapRemoteApp, type BootstrapRemoteAppOptions } from './bootstrap-remote-app.ts'
export { webServerManager } from '@zanix/server'
export {
  type ConfigSubscription,
  ControlPlaneConfig,
  ControlPlaneRegistry,
  LeaderElection,
  type RegisteredInstance,
  type RegisterInstanceOptions,
  resolveControlPlaneProvider,
  ZanixControlPlaneProvider,
} from './control-plane/mod.ts'
export type {
  DeploymentTarget,
  EmbeddedDeploymentTarget,
  RemoteDeploymentTarget,
} from 'typings/deployment.ts'
export {
  getLocalOperation,
  isCallerAllowed,
  listMcpTools,
  type McpToolEntry,
  type RegisteredOperation,
} from './operation-registry.ts'
export { handleMcpRequest, type JsonRpcRequest, type JsonRpcResponse } from './mcp-server.ts'
export { registerMcpServer } from './mcp-route.ts'
export { buildSandboxedHandler, closeSandboxedWorkers } from './sandbox-operation.ts'
export {
  createRemoteCaller,
  type HttpRemoteDispatcher,
  type RemoteCallerFactory,
} from './remote-caller.ts'
export {
  HttpRemoteAdapter,
  type HttpRemoteAdapterTlsOptions,
  resolveDefaultDispatcher,
} from './http-remote-adapter.ts'
export { generateTraceparent } from './trace-context.ts'
export type { RemoteAppHandle, RemoteCallOptions } from 'typings/remote.ts'
export type {
  BehaviorDeclaration,
  BehaviorOverride,
  LocalResourceDeclaration,
  McpToolDeclaration,
  OperationDeclaration,
  OperationHandler,
  RemoteResourceDeclaration,
  ResourceBinding,
  ResourceDeclaration,
  RootResources,
  RuntimeContext,
  RuntimeModeOptions,
  SandboxDeclaration,
} from 'typings/manifest.ts'
export {
  type AnnouncedRemoteInstance,
  announceRemoteInstance,
  type RemoteInstanceOptions,
} from './remote-lifecycle.ts'
export { getConfigOverride, hasConfigOverride, setConfigOverride } from './config-overrides.ts'
export { resolveConfig } from './config-overrides.ts'
export { resolveBehavior } from './behavior-registry.ts'
export { resolveResource } from './resource-instance-registry.ts'
export {
  type MtlsDispatchOptions,
  type MtlsDispatchServer,
  startMtlsDispatchServer,
} from './mtls-dispatch-server.ts'
export { compareReplicas, type ReplicasComparison } from './replicas-comparison.ts'
export { createGatewayPreHandler, type GatewayOptions } from './gateway.ts'
export type { PreHandler } from '@zanix/server'
