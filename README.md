# @zanix/app

[![Version](https://img.shields.io/jsr/v/zanix/app?color=blue&label=jsr)](https://jsr.io/@zanix/app/versions)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](https://opensource.org/licenses/MIT)

## Table of Contents

0. [Concepts](./docs/CONCEPTS.md) — read this first if you're new to what a Zanix App is, or
   reconciling an existing package's bespoke bootstrap with this standard.
1. [Publishing a Zanix App](./docs/PUBLISHING.md) — read this if you're distributing YOUR app as a
   package for a different team's host to install.
2. [Description](#description)
3. [Status](#status)
4. [Two entry points](#two-entry-points)
5. [`defineZanixApp()`](#definezanixapp)
6. [Manifest reference](#manifest-reference)
7. [`AppContainer` (`.`) — composition, pure](#appcontainer---composition-pure)
8. [`AppContainer.registerApp` (`./runtime`)](#appcontainerregisterapp-runtime)
9. [`ResourceRegistry` (`./runtime`)](#resourceregistry-runtime)
10. [`resolveResources` + resource types (`./runtime`)](#resolveresources--resource-types-runtime)
11. [`runOnStart`/`runOnStop` (`./runtime`)](#runonstartrunonstop-runtime)
12. [`activateApps`/`deactivateApps` (`./runtime`)](#activateappsdeactivateapps-runtime)
13. [Changelog](#changelog)
14. [License](#license)

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
manifest). Still missing: loading `rootDir`/`package` manifest files (an app installed from disk/a
package specifier). Nothing below documents a feature that doesn't exist yet.

## Two entry points

```ts
import { ... } from '@zanix/app'          // pure manifest/types — zero dependency on @zanix/server
import { ... } from '@zanix/app/runtime'  // AppContainer/ResourceRegistry/ctx — depends on
                                           // @zanix/server (registering a real route/DI
                                           // resolution is @zanix/server's own job)
```

The split exists so that anything that only needs to author or type-check a manifest (a CLI
scaffold, a build-time validator) never pulls in a full web server. `@zanix/server` never imports
anything from either entry point — the dependency graph is a one-directional DAG, not a cycle.

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
  resources: { mongo: { type: 'mongo', options: { uri: 'mongodb://localhost' } } },
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

| Field          | Shape                                                 | Notes                                                                                                                                                                                                                                                                                                                                                                          |
| -------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`         | `string`                                              | Required. Route namespace + resource-key prefix + job prefix — must match `^[a-z][a-z0-9-]*$`.                                                                                                                                                                                                                                                                                 |
| `version`      | `string?`                                             | Stored only — no cross-app compatibility validation yet.                                                                                                                                                                                                                                                                                                                       |
| `routes`       | `true \| false \| { prefix }`                         | `true` auto-prefixes with `name`; `false` registers no HTTP routes at all; `{ prefix: '' }` is an explicit opt-out of namespacing (distinct from `false` — the app still gets routes, just unprefixed).                                                                                                                                                                        |
| `dependencies` | `Record<slot, { type, required? }>`                   | The closed, auditable set of resources this app can touch. Declares only the TYPE/shape needed, never a concrete resource name (that's the host's `uses`).                                                                                                                                                                                                                     |
| `config`       | `Record<key, { type, default?, required?, secret? }>` | App-local parameters. `secret: true` never accepts a literal `default`.                                                                                                                                                                                                                                                                                                        |
| `jobs`         | `Record<name, JobDefinitionEntry>`                    | `JobDefinitionEntry` IS `@zanix/asyncmq`'s own `JobProcess` (`handler` + queue selection) plus its optional `schedule`/`isActive` — referenced via `import type`, never re-declared, so this package's job shape can never drift from the real one. Namespaced internally to `${appName}:${jobName}`; `schedule` present routes to `registerCronJob`, absent to `registerJob`. |
| `events`       | `Record<name, {}>`                                    | Declared, untyped payload for now.                                                                                                                                                                                                                                                                                                                                             |
| `resources`    | `Record<slot, { type, options }>`                     | Local resources — shadows a root resource of the same name, only for slots also listed in `dependencies`.                                                                                                                                                                                                                                                                      |
| `rootDir`      | `string?`                                             | Relative to the resolved package location (if `package` is set) or the host's cwd.                                                                                                                                                                                                                                                                                             |
| `package`      | `string?`                                             | Package specifier for a distributed app, loaded via `import(packageSpecifier)`.                                                                                                                                                                                                                                                                                                |
| `setup`        | `(ctx: AppSetupContext) => void \| Promise<void>`     | Programmatic registration escape hatch — `ctx.routes()`/`ctx.resolve()`/`ctx.resource()`/`ctx.config`.                                                                                                                                                                                                                                                                         |
| `onStart`      | `(ctx: AppStartContext) => void \| Promise<void>`     | Runs sequentially, in declaration order across apps.                                                                                                                                                                                                                                                                                                                           |
| `onStop`       | `(ctx: AppStopContext) => void \| Promise<void>`      | Runs in parallel (`Promise.allSettled`) across apps.                                                                                                                                                                                                                                                                                                                           |

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
registerResourceType('my-custom-type', (options) => new MyOwnConnector(options))
```

If a constructed instance is a real `ZanixConnector` (has both `isReady` and `isHealthy()`),
`resolveResources` health-gates it before resolving — reusing `@zanix/server`'s own
`connectorModuleInitialization`, the exact function `targetInitializations` already runs for every
`@Connector`-decorated target. This matters because resources built here are constructed OUTSIDE the
`@Connector`/`TargetContainer` path by design (see `resource-types.ts`), so `targetInitializations`
never sees them otherwise. A plain `CloseableResource` with no such concept (a custom
`registerResourceType` factory, or a test fake) is never forced through this — it resolves as soon
as its factory returns.

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

## Changelog

See [CHANGELOG](./docs/CHANGELOG.md).

## License

MIT — see [LICENSE](./docs/LICENSE).
