# @zanix/app

[![Version](https://img.shields.io/jsr/v/zanix/app?color=blue&label=jsr)](https://jsr.io/@zanix/app/versions)
[![Release](https://img.shields.io/github/v/release/zanix-io/app?color=blue&label=git)](https://github.com/zanix-io/app/releases)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](https://opensource.org/licenses/MIT)

## Table of Contents

0. [Concepts](./docs/CONCEPTS.md) — read this first if you're new to what a Zanix App is, or
   reconciling an existing package's bespoke bootstrap with this standard.
1. [Publishing a Zanix App](./docs/PUBLISHING.md) — read this if you're distributing YOUR app as a
   package for a different team's host to install.
2. [Distributed runtime](./docs/DISTRIBUTED-RUNTIME.md) — Control Plane, `ctx.remote()`, distributed
   lifecycle, leader election, Gateway, Remote Resource Binding.
3. [Platform features](./docs/PLATFORM-FEATURES.md) — hot install/uninstall, agent/MCP
   composability, multi-tenancy & resource quotas, real sandboxing, standalone remote deployment.
4. [Description](#description)
5. [Status](#status)
6. [Three entry points](#three-entry-points)
7. [`defineZanixApp()`](#definezanixapp)
8. [Manifest reference](#manifest-reference)
9. [`AppContainer` (`.`) — composition, pure](#appcontainer---composition-pure)
10. [`AppContainer.registerApp` (`./runtime`)](#appcontainerregisterapp-runtime)
11. [`ResourceRegistry` (`./runtime`)](#resourceregistry-runtime)
12. [`resolveResources` + resource types (`./runtime`)](#resolveresources--resource-types-runtime)
13. [`ctx.behavior()` — behavior overrides (`./runtime`)](#ctxbehavior--behavior-overrides-runtime)
14. [`runOnStart`/`runOnStop` (`./runtime`)](#runonstartrunonstop-runtime)
15. [`activateApps`/`deactivateApps` (`./runtime`)](#activateappsdeactivateapps-runtime)
16. [Additional runtime utilities (`./runtime`)](#additional-runtime-utilities-runtime)
17. [Changelog](#changelog)
18. [License](#license)

## Description

`@zanix/app` is the authoring/composition surface for a **Zanix App** — an installable module
(manifest + dependencies + resources + routes + jobs + events + lifecycle) that runs embedded inside
a Zanix Runtime, or, later, as its own distributed process.

## Status

This package is under active construction. Implemented so far: `defineZanixApp()` (with `.serve()`,
a local dev loop for running one app in isolation), the manifest types (including auto-bind: an
explicit `uses` binding is only required when it's actually ambiguous — see `buildGraph`'s own doc),
the pure half of `AppContainer` (`normalize`/`buildGraph`/`validate`), `ResourceRegistry`,
`resolveResources` (with `'mongo'`/`'redis'` built-in resource types), `AppContainer.registerApp`
(mount registration + job namespacing + the `setup(ctx)` callback), the lifecycle hooks
`runOnStart`/`runOnStop`, and `activateApps`/`deactivateApps` (the reference sequence that chains
all of the above for a full set of apps). `@zanix/core`'s own `Zanix.start()` calls `activateApps`
for every `apps.<name>` entry, each shaped `{ definition, server?, uses? }` (a `defineZanixApp()`
manifest). Also implemented: `ControlPlaneRegistry`/`ControlPlaneConfig`, a Redis-backed remote app
Registry and hot-refresh Config Plane, DI-resolvable as `ZanixControlPlaneProvider` (the
`'controlPlane'` core-provider slot, registered by the third entry point, `@zanix/app/core`) —
reuses `this.cache.redis` rather than a second connection;
`ctx.remote(name).call(operationName,
payload, options)` — local-first (zero network when `name` is
active in this same process), falling back to `HttpRemoteAdapter` (real HTTP, `@zanix/auth`
service-token exchange, W3C `traceparent`, mandatory timeout) when it isn't, auto-detected from the
DI slot above — an app declares what it exposes via manifest `operations` (see "Manifest
reference"). Also implemented: `activateApps`'s `remoteInstances` parameter — an app announces
itself to the Control Plane after its own `onStart` (heartbeat renewal + Config Plane hot-refresh
subscription for non-secret keys), and deregisters BEFORE `onStop` on the way down; `ctx.config`
reads the resulting hot-refresh overlay first; `HttpRemoteAdapter` can present a client TLS
certificate covering both legs of a call, and a target can genuinely enforce the incoming half too
via a dedicated `mtls-dispatch-server.ts` listener (see
[Distributed lifecycle](./docs/DISTRIBUTED-RUNTIME.md#distributed-lifecycle-runtime) for what's
narrow about it). Also implemented: a scheduled `jobs.<name>` entry automatically runs under
Redis-backed leader election (only one replica per tick, fencing-token-validated) and
`compareReplicas` checks a manifest's own `runtime.replicas` against what the Control Plane Registry
actually observes (see
[Leader election & replicas](./docs/DISTRIBUTED-RUNTIME.md#leader-election--replicas-runtime));
`LeaderElection` itself scales to Redlock (majority quorum across several independent Redis
instances) by passing an array instead of a single connector, same public API. Also implemented: a
Gateway (`createGatewayPreHandler`) that routes PUBLIC/external traffic to a `remote` app — by name,
or via a configured whole-domain default (see
[Gateway](./docs/DISTRIBUTED-RUNTIME.md#gateway-runtime)); Remote Resource Binding
(`resources.<slot>: {type, mode: 'remote', endpoint}`) resolves `ctx.resource(slot)` to a
`RemoteAppHandle` instead of a real instance, reusing `ctx.remote()`'s own mechanism (see
[Remote Resource Binding](./docs/DISTRIBUTED-RUNTIME.md#remote-resource-binding-runtime)). Also
implemented: `installApp`/`uninstallApp` — hot install/uninstall of ONE app into an already-running
process, scoped to routes + resources + operations (see
[Hot install/uninstall](./docs/PLATFORM-FEATURES.md#hot-installuninstall-runtime)). Also
implemented: per-operation permission scoping (`allowedCallers`) — an operation can restrict WHICH
Zanix Apps may invoke it, checked at both the local-first and remote HTTP dispatch points against
the calling app's own identity (see
[`ctx.remote()`](./docs/DISTRIBUTED-RUNTIME.md#ctxremote--remote-app-protocol-runtime)'s own
subsection). Also implemented: agent/MCP composability — an operation can opt into
`mcp: {description,
inputSchema}` to be exposed as a Model Context Protocol tool,
discoverable/invocable by an AI agent through one aggregated, process-wide endpoint
(`registerMcpServer`), reusing `allowedCallers` as-is for authorization (see
[Agent/MCP composability](./docs/PLATFORM-FEATURES.md#agentmcp-composability-runtime)). Also
implemented: multi-tenancy isolation (already worked via naming convention — see
[Multi-tenancy & resource quotas](./docs/PLATFORM-FEATURES.md#multi-tenancy--resource-quotas-runtime))
plus `ResourceRegistry.setQuota`/`InstallAppOptions.
maxResources` — a hard ceiling on how many
distinct resource instances one installed app may hold. Also implemented: real sandboxing — an
`operations.<name>` entry can declare `sandbox` instead of `handler` to run inside its own
dedicated, permission-restricted Deno Worker (see
[Real sandboxing](./docs/PLATFORM-FEATURES.md#real-sandboxing-runtime)). Also implemented:
`bootstrapRemoteApp` — a real, standalone remote-process entrypoint for a Zanix App (see
[Standalone remote deployment](./docs/PLATFORM-FEATURES.md#standalone-remote-deployment-runtime)),
and `@zanix/cli`'s `zanix prepare --docker -p app` scaffolding the rest (`serve.ts`, a matching
`deno.json` `serve` task, a `Dockerfile`) — the DX/deploy pipeline track, independent of the 4
"beyond VTEX" pillars above. Still missing: loading `rootDir`/`package` manifest files (an app
installed from disk/a package specifier); hot install/uninstall of `jobs`/`events` (restart-only for
now); an app catalog/marketplace. Nothing below documents a feature that doesn't exist yet.

## Three entry points

```ts
import { ... } from '@zanix/app'          // pure manifest/types — zero dependency on @zanix/server
import { ... } from '@zanix/app/runtime'  // AppContainer/ResourceRegistry/ctx — depends on
                                           // @zanix/server (registering a real route/DI
                                           // resolution is @zanix/server's own job)
import '@zanix/app/core'                  // side-effect only — zero-config Control Plane wiring
                                           // (see docs/DISTRIBUTED-RUNTIME.md's "ctx.remote()");
                                           // never imported by `.`/`./runtime` themselves, so
                                           // nothing pays for it unless a host explicitly opts in
```

The split exists so that anything that only needs to author or type-check a manifest (a CLI
scaffold, a build-time validator) never pulls in a full web server. `@zanix/server` never imports
anything from any of these entry points — the dependency graph is a one-directional DAG, not a
cycle.

## `defineZanixApp()`

The only standard way to author a Zanix App — every field but `name` is optional:

```ts
import { defineZanixApp } from '@zanix/app'

const reviews = defineZanixApp({
  name: 'reviews',
  routes: true, // auto-prefixes routes with "reviews" — see "Manifest reference" below
  dependencies: {
    database: { type: 'mongo', required: true },
  },
  config: {
    apiKey: { type: 'string', secret: true, required: true },
  },
})

reviews.definition.name // 'reviews'
```

Validates what it can WITHOUT any host context — currently: `name`'s format (`^[a-z][a-z0-9-]*$`),
and that a `secret: true` config entry never carries a literal `default` (a secret must come from a
host override or env var, never hardcoded). Cross-app/host checks (`uses`/`dependencies` contract,
collisions) need the full dependency graph — see `validate()` below.

### `.serve()` — the author's own local dev loop

```ts
const handle = await reviews.serve({
  resources: {
    mongo: { type: 'mongo', options: { uri: 'mongodb://localhost' } },
  },
  uses: [{ slot: 'database', resourceName: 'mongo' }],
  server: { rest: { port: 4000 } }, // omit to register without serving any HTTP surface at all
})

// ... later ...
await handle.stop() // onStop → resources close → whatever server(s) serve() started
```

Runs THIS app alone, in isolation — never what a real host does (a host installing this app for real
goes through `Zanix.start()`'s `apps` option instead, alongside whatever else it's running).
Implemented via a lazy `import('@zanix/app/runtime')` inside the method itself — the exact same
`activateApps`/`bootstrapAppServer` `@zanix/core`'s own `Zanix.start()` calls for a
`ZanixAppBootstrapOptions` entry, never a second, parallel implementation — so importing `.` alone
(never calling `.serve()`) still pulls in zero `@zanix/server` dependency.

## Manifest reference

| Field          | Shape                                                                   | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`         | `string`                                                                | Required. Route namespace + resource-key prefix + job prefix — must match `^[a-z][a-z0-9-]*$`.                                                                                                                                                                                                                                                                                                                                                                        |
| `version`      | `string?`                                                               | Stored only — no cross-app compatibility validation yet.                                                                                                                                                                                                                                                                                                                                                                                                              |
| `runtime`      | `{ mode?, replicas? }`                                                  | The author's own DEFAULT execution-mode suggestion (`mode: 'embedded'` default, or `'remote'`) — never a command the app executes; `replicas` is a policy hint the Control Plane compares against what's observed, never a number the app itself counts. See [Distributed lifecycle](./docs/DISTRIBUTED-RUNTIME.md#distributed-lifecycle-runtime) for what actually makes an instance `remote` at runtime (`activateApps`'s `remoteInstances`, not this field alone). |
| `routes`       | `true \| false \| { prefix }`                                           | `true` auto-prefixes with `name`; `false` registers no HTTP routes at all; `{ prefix: '' }` is an explicit opt-out of namespacing (distinct from `false` — the app still gets routes, just unprefixed).                                                                                                                                                                                                                                                               |
| `dependencies` | `Record<slot, { type, required? }>`                                     | The closed, auditable set of resources this app can touch. Declares only the TYPE/shape needed, never a concrete resource name (that's the host's `uses`).                                                                                                                                                                                                                                                                                                            |
| `config`       | `Record<key, { type, default?, required?, secret? }>`                   | App-local parameters. `secret: true` never accepts a literal `default`.                                                                                                                                                                                                                                                                                                                                                                                               |
| `jobs`         | `Record<name, JobDefinitionEntry>`                                      | `JobDefinitionEntry` IS `@zanix/asyncmq`'s own `JobProcess` (`handler` + queue selection) plus its optional `schedule`/`isActive` — referenced via `import type`, never re-declared, so this package's job shape can never drift from the real one. Namespaced internally to `${appName}:${jobName}`; `schedule` present routes to `registerCronJob`, absent to `registerJob`.                                                                                        |
| `operations`   | `Record<name, OperationHandler>`                                        | Named handlers OTHER Zanix Apps invoke via `ctx.remote(name).call(operationName, payload)` — see [`ctx.remote()`](./docs/DISTRIBUTED-RUNTIME.md#ctxremote--remote-app-protocol-runtime). Separate from `routes`: never namespaced by path, never HTTP-shaped on the author's side.                                                                                                                                                                                    |
| `events`       | `Record<name, {}>`                                                      | Declared, untyped payload for now.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `resources`    | `Record<slot, { type, options } \| { type, mode: 'remote', endpoint }>` | Local resources — shadows a root resource of the same name, only for slots also listed in `dependencies`. `mode: 'remote'` resolves to an RPC handle instead of a real instance — see [Remote Resource Binding](./docs/DISTRIBUTED-RUNTIME.md#remote-resource-binding-runtime).                                                                                                                                                                                       |
| `behaviors`    | `Record<name, { default, description? }>`                               | Pure function/strategy slots a host can override — no construction, no `close()`, no health-gating, unlike `resources`. See "`ctx.behavior()` — behavior overrides" below.                                                                                                                                                                                                                                                                                            |
| `rootDir`      | `string?`                                                               | Relative to the resolved package location (if `package` is set) or the host's cwd.                                                                                                                                                                                                                                                                                                                                                                                    |
| `package`      | `string?`                                                               | Package specifier for a distributed app, loaded via `import(packageSpecifier)`.                                                                                                                                                                                                                                                                                                                                                                                       |
| `setup`        | `(ctx: AppSetupContext) => void \| Promise<void>`                       | Programmatic registration escape hatch — `ctx.routes()`/`ctx.resolve()`/`ctx.resource()`/`ctx.config`.                                                                                                                                                                                                                                                                                                                                                                |
| `onStart`      | `(ctx: AppStartContext) => void \| Promise<void>`                       | Runs sequentially, in declaration order across apps.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `onStop`       | `(ctx: AppStopContext) => void \| Promise<void>`                        | Runs in parallel (`Promise.allSettled`) across apps.                                                                                                                                                                                                                                                                                                                                                                                                                  |

## `AppContainer` (`.`) — composition, pure

```ts
import { buildGraph, validate } from '@zanix/app'

// Host-side composition (normally done by `Zanix.start()`, not by an app author): assembles every
// app + the host's own root resources + `uses` bindings into one graph, then validates it
// fail-fast, BEFORE constructing anything.
const graph = buildGraph(
  [reviews.definition],
  { mongo: { type: 'mongo', options: {} } },
  [{ appName: 'reviews', slot: 'database', resourceName: 'mongo' }],
)
validate(graph) // throws on a missing required dependency, a type mismatch, or an undeclared
// resource — see the module's own JSDoc for the exact rules.
```

**Auto-bind**: an explicit `uses` binding is only required when it's actually ambiguous. If a slot
has no binding at all, and EXACTLY ONE root resource's `type` matches `dependencies.<slot>.type`,
`buildGraph` infers the binding automatically:

```ts
const graph = buildGraph(
  [reviews.definition],
  { mongo: { type: 'mongo', options: {} } }, // the only 'mongo'-typed root resource
  [], // no uses.database binding at all — still resolves
)
```

Zero or more than one root resource of that type still requires an explicit `uses`, fail-fast via
`validate()` — same as before. Never considered when an explicit (but broken) `uses` binding was
given — a host that named something that doesn't exist gets a real error, never a silent guess.

`normalize`/`buildGraph`/`validate` are the pure half of `AppContainer`'s namespace — no I/O, no
`@zanix/server`. The other half (`resolveResources`, `registerApp`, `runOnStart`/`runOnStop` — the
parts that actually construct resources and register real routes) lives in `@zanix/app/runtime`
instead — see the sections below.

## `AppContainer.registerApp` (`./runtime`)

Composes one normalized app into the running process — the half of `AppContainer` that does depend
on `@zanix/server`:

```ts
import { registerApp } from '@zanix/app/runtime'

await registerApp(reviews.definition, resolvedResources)
// - opens reviews' own ProgramModule.defineApplication('reviews', ...) scope
// - registers its mount prefix (unless routes: false)
// - registers every job in its manifest, namespaced to `reviews:${jobName}` — two apps
//   declaring a job of the same short name never collide
// - runs setup(ctx), if the manifest declared one, with a ctx scoped to this app:
//   ctx.routes(register)         — runs `register` (e.g. @Controller classes) inside this
//                                   app's own ProgramModule.defineApplication scope
//   ctx.resolve(Target)          — sugar over ProgramModule.getInteractors/getProviders/
//                                   getConnectors, dispatched by which of @Interactor/
//                                   @Provider/@Connector `Target` extends
//   ctx.resource(slot)/ctx.config — same read-only accessors onStart/onStop get
```

`resolvedResources` is the `Map<` ${appName}:${slot}`, instance>` `resolveResources()` already
produced — pass `new Map()` for an app with no resources. Not this function's job: loading
`rootDir`/`package` manifest files (not implemented yet), or producing `resources`/running
`onStart`/`onStop` themselves — those are cross-app concerns owned by whoever composes the full set
of apps (`@zanix/core`'s `Zanix.start()`, via `activateApps`).

## `ResourceRegistry` (`./runtime`)

Owns the lifecycle/cache of every resource a Zanix App's `resources`/`uses` resolve to. Internal
plumbing — an app's own code never calls this directly (see `AppContainer`'s `ctx.resource(slot)`,
once implemented); documented here as a reference for whoever implements `AppContainer` on top of
it, not as a public API surface for app authors.

```ts
import { ResourceRegistry } from '@zanix/app/runtime'

const registry = new ResourceRegistry()

// Memoized by promise — a factory is invoked at most once per qualifiedKey, even if two callers
// ask for the same key concurrently before the first construction settles.
const db = await registry.resolve('mongo', () => connectToMongo())

// Promise.allSettled semantics — one resource's close() failing never stops the others; every
// failure is aggregated into a single AggregateError instead of being silently swallowed.
await registry.close()
```

See the class's own JSDoc (`src/modules/runtime/resource-registry.ts`) for the exact memoization and
rejection-propagation contract.

## `resolveResources` + resource types (`./runtime`)

```ts
import { registerResourceType, resolveResources } from '@zanix/app/runtime'
import { ResourceRegistry } from '@zanix/app/runtime'
import { buildGraph } from '@zanix/app'

const registry = new ResourceRegistry()
const graph = buildGraph(
  [reviews.definition],
  { mongo: { type: 'mongo', options: { uri: 'mongodb://localhost' } } },
  [{ appName: 'reviews', slot: 'database', resourceName: 'mongo' }],
)

// Resolves every entry in graph.resolvedKeys through `registry` — two apps bound to the same
// root resource get the exact same instance; an app with its own local resource never shares it.
const resolved = await resolveResources(graph, registry)
resolved.get('reviews:database') // the real ZanixMongoConnector instance
```

`'mongo'`/`'redis'` are built in — `type: 'mongo'` resolves to `@zanix/datamaster`'s real
`ZanixMongoConnector`, referenced directly (never a re-declared shape). A host/package that needs a
resource type this package never heard of registers its own factory instead of waiting for one:

```ts
registerResourceType(
  'my-custom-type',
  (options) => new MyOwnConnector(options),
)
```

If a constructed instance is a real `ZanixConnector` (has both `isReady` and `isHealthy()`),
`resolveResources` health-gates it before resolving — reusing `@zanix/server`'s own
`connectorModuleInitialization`, the exact function `targetInitializations` already runs for every
`@Connector`-decorated target. This matters because resources built here are constructed OUTSIDE the
`@Connector`/`TargetContainer` path by design (see `resource-types.ts`), so `targetInitializations`
never sees them otherwise. A plain `CloseableResource` with no such concept (a custom
`registerResourceType` factory, or a test fake) is never forced through this — it resolves as soon
as its factory returns.

## `ctx.behavior()` — behavior overrides (`./runtime`)

For customizing an app WITHOUT forking it or copying its code — see "Configuration vs Extension vs
Override" below for the full decision guide. `behaviors` is for a PURE function/strategy a host
might want to replace (a pricing rule, a formatting strategy, a routing decision); reach for
`resources` instead when the swappable thing needs a real lifecycle (construction, `close()`,
health-gating, quotas).

```ts
// The base app — never forked, never copied.
const billing = defineZanixApp({
  name: 'billing',
  behaviors: {
    calculateDiscount: {
      default: (order: Order) => order.total * 0, // no discount by default
      description: 'Calculates the discount applied to an order before checkout.',
    },
  },
  setup: async (ctx) => {
    const discount = ctx.behavior<(order: Order) => number>(
      'calculateDiscount',
    )(order)
  },
})

// The host composing it — only overrides the one thing that actually varies.
await activateApps([billing], {}, [], undefined, {}, [
  {
    appName: 'billing',
    name: 'calculateDiscount',
    implementation: (order) => order.total * 0.1,
  },
])
```

`ctx.behavior<T = unknown>(name)` resolves to the host-supplied override if one was given, else to
the manifest's own `behaviors.<name>.default`, else `undefined` — same "override, else default"
precedence `ctx.config.get` already follows for its own Config Plane overlay. `T` is manually
specified, not inferred (`name` is just a string — there's no real argument, like a class reference,
to infer it from), so it's exactly as sound as an `as T` cast, never more; its only purpose is
letting `ctx.behavior<T>(name) ?? default` type-check without an external cast around the whole
expression. `activateApps`'s own `behaviors` parameter (`BehaviorOverride[]`) validates eagerly: it
throws `InternalError` — before anything else is constructed — if an override names an app not in
this activation, or a behavior name that app never declared, same fail-fast posture `validate()`
already has for `uses` naming an unknown `dependencies` slot.

### `resolveBehavior()` — overriding a single Comet/component (`./runtime`)

`ctx.behavior()` only exists inside a `RuntimeContext` (`setup`/`onStart`/`onStop`/`operations`) — a
`@zanix/space` page's own render has none of that. `resolveBehavior(appName, name)` resolves the
SAME registry standalone, from anywhere:

```tsx
// products/[id]/page.tsx — the BASE app's own page, never touched, never aware an override exists.
import { resolveBehavior } from '@zanix/app/runtime'
import DefaultAddToCartButton from './add-to-cart.tsx'

export default function ProductPage() {
  const AddToCartButton = resolveBehavior<typeof DefaultAddToCartButton>(
    'shop',
    'AddToCartButton',
  ) ?? DefaultAddToCartButton
  return <AddToCartButton product={product} />
}
```

A Comet is, structurally, just a function (props in, output out) — registering one as a `behaviors`
default needs no special framework integration, and `@zanix/app` gains no Preact/React dependency
either way: `behaviors`/`resolveBehavior` never inspect what the function returns. `ctx.behavior()`
delegates to `resolveBehavior()` internally, so the two entry points can never resolve differently.

#### Style-only overrides — keep the component's own logic, swap only its presentation

The example above replaces the WHOLE component — a host supplying `CustomAddToCartButton` also
supplies its own click handler, loading/disabled state, everything. That's the right tool when the
host genuinely wants different behavior. It's the WRONG tool when a host only wants a different look
and would otherwise have to copy the base component's own logic just to attach a different className
— exactly the duplication this whole mechanism exists to avoid.

**This is NOT a second registry or a parallel API — it's the SAME `behaviors`/`resolveBehavior`,
with the component itself (not the host, and not the page) resolving a style-shaped value for its
OWN className/style prop, instead of resolving an entire replacement component:**

```tsx
// add-to-cart.tsx — the BASE app's own component, authored to expose its OWN style as swappable.
import { resolveBehavior } from '@zanix/app/runtime'

export default function AddToCartButton(props: AddToCartProps) {
  const className = resolveBehavior<string>('shop', 'AddToCartButtonClassName') ??
    'btn-default'
  // Every bit of logic below is still the base app's own — a host overriding the className above
  // never touches (and never has to reimplement) any of it.
  return (
    <button
      className={className}
      disabled={props.disabled}
      onClick={props.onAdd}
    >
      Add to cart
    </button>
  )
}
```

```ts
// The host — overrides ONLY the className, on every page that renders this component, without
// touching a single page and without reimplementing the button's click/disabled logic.
await activateApps([shopApp], {}, [], undefined, {}, [
  {
    appName: 'shop',
    name: 'AddToCartButtonClassName',
    implementation: () => 'btn-custom',
  },
])
```

Declare a `behaviors` entry whose default is a function returning the value (a className string, a
style object — whatever shape the component itself expects), and have the COMPONENT resolve it for
its own prop, rather than having a page resolve an entire replacement component. Everything else
about `behaviors`/`resolveBehavior` is unchanged — same registry, same override-else-default
precedence, same `undefined`-if-neither-exists behavior.

**One real precondition, not a gap**: this only works for a component whose author already added the
`resolveBehavior(...)` call for its own style value — same precondition every `behaviors` slot
already has (a host can never override something the base app's author never declared as a slot in
the first place). It does NOT retroactively make an arbitrary, already-written component's style
overridable from outside; the base component has to opt in.

### Configuration vs Extension vs Override

Three different mechanisms answer three different questions — picking the wrong one either forces an
awkward API (modeling a pure function as a stateful resource) or invites duplicating code that
should have been reused:

| Question                                                                         | Mechanism                                                                                                                                                                                                |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Change ONE VALUE, no code involved?                                              | `config`                                                                                                                                                                                                 |
| Replace a SERVICE with a real lifecycle (a connection, an authenticated client)? | `resources`/`dependencies`/`uses` + `registerResourceType`                                                                                                                                               |
| Replace a PURE FUNCTION (no lifecycle)?                                          | `behaviors` + `ctx.behavior()`                                                                                                                                                                           |
| Add NEW behavior that doesn't replace anything existing?                         | A second Zanix App, composed alongside the base one (see `activateApps` above and [`ctx.remote()`](./docs/DISTRIBUTED-RUNTIME.md#ctxremote--remote-app-protocol-runtime)) — never a fork of the base app |

`resources` and `behaviors` look similar (both are host-suppliable overrides resolved through
`ctx`), but exist for genuinely different needs — forcing a pure function through `resources` (a
factory that just returns a closure, never opened/closed/health-checked) works, but adds
construction/registry machinery a plain function never needed.

## `runOnStart`/`runOnStop` (`./runtime`)

```ts
import { runOnStart, runOnStop } from '@zanix/app/runtime'

// Sequential, in declaration order — never parallel. Two apps sharing a resource could step on
// each other if their onStart ran concurrently; determinism over speed for a boot sequence.
await runOnStart([reviews.definition, billing.definition], resolvedResources)

// ... later, at shutdown ...

// Parallel (Promise.allSettled) — the opposite of onStart, deliberately: the process is going
// down regardless, so completing the most cleanup possible matters more than a reproducible
// order. One app's onStop throwing never blocks another's.
await runOnStop([reviews.definition, billing.definition], resolvedResources)
// Resources are STILL OPEN at this point — close them only after runOnStop resolves:
await registry.close()
```

Both read/write through the same `{resource(slot), config: {get, has}}` shape (`RuntimeContext`)
`onStart`/`onStop` receive as `ctx` — read-only accessors over what `resolveResources()` already
resolved, never triggering a new construction themselves.

## `activateApps`/`deactivateApps` (`./runtime`)

The reference sequence for composing a full set of apps — everything above, chained in the one
correct order, so a caller never has to re-derive it by hand:

```ts
import { activateApps, deactivateApps } from '@zanix/app/runtime'

// normalize → buildGraph → validate → resolveResources → registerApp (sequentially, per app,
// each running its own setup(ctx)) → runOnStart (across every app). `defs` accepts either the raw
// AppDefinition shape (normalized here) or defineZanixApp()'s own return value directly (already
// normalized, used as-is) — freely mixed in the same call:
const activated = await activateApps(
  [reviews, billing],
  { mongo: { type: 'mongo', options: { uri: 'mongodb://localhost' } } }, // root resources
  [{ appName: 'reviews', slot: 'database', resourceName: 'mongo' }], // uses bindings
)
activated.resources // the same Map every ctx.resource(slot) read from
activated.registry // owns resources' construction/close lifecycle

// ... later, at shutdown — runOnStop (across every app) → registry.close(), in that order,
// even if one or more onStop handlers failed:
await deactivateApps(activated)
```

Adds no logic of its own — every step is one of this package's own already-tested primitives, called
in the one order the design requires. This is exactly what `@zanix/core`'s `Zanix.start()` calls for
any `apps.<name>` entry shaped `{ definition, server?, uses? }` — see its own
`SetupOptions`/`ZanixAppBootstrapOptions` docs for the host-facing side of this. Never called
directly from an app's own code.

## Additional runtime utilities (`./runtime`)

Lower-level exports that back the higher-level APIs documented above — real, stable, and directly
imported by production consumers (`@zanix/admin`, notably), but each is a one-purpose primitive
rather than something that needs its own full section:

| Export                                                                | What it does                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getLocalOperation(appName, operationName)`                           | Resolves a registered operation's handler/`ctx` directly, or `undefined` if `appName` never registered `operationName` in THIS process — the same lookup `ctx.remote()`'s local-first branch and both the HTTP/mTLS dispatch routes use internally.                                                                                                            |
| `resolveTarget(appName, Target)`                                      | Backs `ctx.resolve(Target)` — sugar over `ProgramModule.getInteractors`/`getProviders`/`getConnectors`, dispatched by which of `@Interactor`/`@Provider`/`@Connector` `Target` extends. Throws `UNRESOLVABLE_TARGET` for a class extending none of them.                                                                                                       |
| `getResourceFactory(type)`                                            | Reads back a resource type's registered factory (built-in `'mongo'`/`'redis'`, or anything `registerResourceType` added) — `undefined` if `type` was never registered.                                                                                                                                                                                         |
| `getNamespacedJobOrigin(namespacedName)`                              | Resolves a namespaced job name (`${appName}:${jobName}`) back to the app/original job name it came from — `undefined` if never registered via `registerApp`.                                                                                                                                                                                                   |
| `getConfigOverride(appName, key)` / `hasConfigOverride(appName, key)` | The same Config Plane overlay `ctx.config.get`/`.has` already read from (see [Distributed lifecycle](./docs/DISTRIBUTED-RUNTIME.md#distributed-lifecycle-runtime)) — useful from OUTSIDE a `RuntimeContext` (e.g. a health-check job). `setConfigOverride` is called internally by the Config Plane subscription callback, never by application code directly. |
| `generateTraceparent()`                                               | Generates a fresh W3C `traceparent` value — the same one `HttpRemoteAdapter` propagates on every outgoing call.                                                                                                                                                                                                                                                |
| `isZanixAppDefinition(value)`                                         | Type guard for whatever `defineZanixApp()` returns — the supported way to check an unknown value is a `ZanixAppDefinition`, rather than reading its brand field directly.                                                                                                                                                                                      |

## Changelog

See [CHANGELOG](./CHANGELOG.md).

## License

MIT — see [LICENSE](./LICENSE).
