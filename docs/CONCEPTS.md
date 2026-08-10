# Zanix App concepts

This is the conceptual reference for "what is a Zanix App" — the vocabulary this package's own
README assumes. Read this first if you're building a NEW package that composes routes/resources into
a real process, or reconciling an EXISTING package's own bespoke bootstrap with this standard.

## Table of Contents

1. [Two layers, never confuse them](#two-layers-never-confuse-them)
2. [Creating a Zanix App](#creating-a-zanix-app)
3. [Consuming a Zanix App](#consuming-a-zanix-app)
4. [Where each Zanix package sits](#where-each-zanix-package-sits)
5. [Consistency checklist for a new package](#consistency-checklist-for-a-new-package)

## Two layers, never confuse them

**`@zanix/server`'s `ApplicationContainer`/`defineApplication`** — identity only. An "Application"
is a routing/DI namespace: `ProgramModule.defineApplication(name, setup)` runs `setup` with `name`
as the ambient scope, so every `@Controller`/`@Interactor`/etc. that runs inside it gets attributed
to that Application. It has NO concept of a manifest, dependencies, resources, or lifecycle hooks —
it is the low-level primitive every Zanix service already uses (including the main app itself, under
the default Application), whether or not that service ever declares a single Zanix App.

**`@zanix/app`'s `defineZanixApp`/`AppContainer`** — a composition STANDARD built on top of an
Application, never a replacement for it. A Zanix App is
`manifest + dependencies + resources +
routes + jobs + events + lifecycle`:

```
defineZanixApp({ name, dependencies, resources, routes, config, jobs, events, setup, onStart, onStop })
                     |
                     v
        AppContainer.registerApp(definition, resources)
                     |
                     v
      ONE ProgramModule.defineApplication(name, ...) scope
      (mount registration, job namespacing, setup(ctx) — routes(), resolve())
```

Every Zanix App IS an Application (one per app, named after the manifest's own `name`), but not
every Application is a Zanix App — the main app (file-based `rootDir` auto-discovery, no manifest)
is a plain Application, never a `defineZanixApp()` call.

## Creating a Zanix App

`defineZanixApp()` (`.` entry point, zero `@zanix/server` dependency) is the ONLY standard way — see
this package's own README for the full manifest reference and `.serve()` (a one-app, isolated dev
loop). The manifest is pure data: nothing in it imports `@zanix/server`, so a CLI scaffold or a lint
rule can type-check a manifest without pulling in a full web server.

Distributing what you wrote as a package for a DIFFERENT team's host to install — as opposed to
running it inside your own — is [`PUBLISHING.md`](./PUBLISHING.md)'s own scope, not this doc's.

## Consuming a Zanix App

Two ways, both living in `@zanix/app/runtime` (the entry point that DOES depend on `@zanix/server`):

- **`Zanix.start({ apps: {...} })`** (`@zanix/core`) — the real host path. Each `apps.<name>` entry
  is `{ definition, server?, uses? }` (`ZanixAppBootstrapOptions`, see `@zanix/core`'s own
  `SetupOptions` docs) — the entry's own key MUST match the manifest's `name`. `Zanix.start()`
  resolves every declared app as ONE batch via `activateApps` (so apps sharing a root resource
  resolve to the same instance), then serves each entry that declares its own `server`.
- **`activateApps(defs, rootResources?, bindings?)` directly** — for anything composing a set of
  Zanix Apps WITHOUT going through `@zanix/core` (a test harness, an alternative host). Returns
  `ActivatedApps` (`{ apps, resources, registry }`); pair with `deactivateApps` for shutdown.

Never call `AppContainer.registerApp`/`resolveResources`/`runOnStart` individually from outside
`@zanix/app` itself — `activateApps` (or `Zanix.start()`, which calls it) is the one correct
sequence; see this package's own README for why calling them out of order is a real, not
theoretical, risk.

## Where each Zanix package sits

| Package         | Relationship to Zanix Apps                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@zanix/server` | Owns the underlying primitive (`ApplicationContainer`/`defineApplication`) — no manifest concept, no knowledge that `@zanix/app` exists.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `@zanix/app`    | Owns the standard itself — `defineZanixApp`, `AppContainer`, `activateApps`/`deactivateApps`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `@zanix/core`   | The orchestrator — `Zanix.start()`'s `apps` option is `@zanix/app/runtime`'s `activateApps`, called once per boot for every declared Zanix App.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `@zanix/space`  | A real consumer — `defineSpaceApp()` is a thin wrapper over `defineZanixApp()` (see `@zanix/space`'s own `define-space-app.ts`): a `@zanix/space` frontend app IS a Zanix App, reusing the exact same composition/lifecycle, not a parallel mechanism.                                                                                                                                                                                                                                                                                                                                                   |
| `@zanix/admin`  | A real consumer — `defineAdminHubApp(options)`/`defineLocalAdminApp()` (`@zanix/admin`'s own factories, mirroring `@zanix/space`'s `defineSpaceApp()` shape) build the central aggregator (`'admin-hub'`) and embedded, business-service-side (`'admin'`) manifests `ZanixAdminHub.start()`/`Zanix.start({admin:true})` each activate via `activateApps`/`bootstrapAppServer` — no more bespoke, hand-duplicated bootstrap/lifecycle-guard/anchoring code between the two. Exported so a host can compose either directly via `Zanix.start({ apps: {...} })` instead of going through either entrypoint. |

## Consistency checklist for a new package

Building something that composes routes/resources/jobs into a real process? Before writing a bespoke
bootstrap:

- [ ] Is this genuinely a NEW Application (its own routing/DI namespace), or does it belong inside
      an app/Application that already exists? Only the former needs `defineApplication` at all.
- [ ] Does it have dependencies on shared resources (a database, a cache, another service)? If so,
      it's very likely a Zanix App — express those as `dependencies`, not ad-hoc constructor options
      threaded through a custom `start()` function.
- [ ] Does it need lifecycle hooks (something to run once resources are ready, something to clean up
      on shutdown)? That's `onStart`/`onStop`, not a hand-rolled guard/`runBootSession` call —
      `@zanix/app/runtime` already provides the ordering guarantees (`onStart` sequential, `onStop`
      parallel via `allSettled`) so nobody has to re-derive them.
- [ ] Does it need its own anchored server id / port precedence (explicit option beats env var)?
      That's already `@zanix/server`'s
      `resolveApplicationServerId`/`resolvePreviousApplicationServerId` — reuse them directly rather
      than re-deriving the same precedence rules by hand.
- [ ] Is there a standalone entrypoint some callers need (e.g. `PackageHub.start()`, mirroring
      `ZanixAdminHub.start()`)? That standalone function can still exist — it becomes a thin wrapper
      that calls `Zanix.start({ apps: { name: { definition, server, uses } } })` (or `activateApps`
      directly, if it must avoid a `@zanix/core` dependency), never its own
      `runBootSession`/lifecycle-guard/anchoring logic duplicated by hand.
- [ ] Does the manifest need anything the HOST only decides at deployment/composition time
      (credentials, which optional routes to register, per-instance config)? Export a **factory**
      (`defineXApp(options)`), not a pre-built constant — see below.

### Factory vs. pre-built manifest — deciding which shape to export

A package composing a Zanix App for others to consume exports one of two shapes:

```ts
// Pre-built constant — the manifest is fully knowable at author time, nothing a host
// supplies changes what it declares.
export const fooApp: ZanixAppDefinition = defineZanixApp({ name: 'foo', ... })

// Factory — the manifest's shape depends on options only the HOST knows (a deployment's
// own credentials, which optional capabilities to register, per-instance identity).
export function defineFooApp(options: FooAppOptions): ZanixAppDefinition {
  return defineZanixApp({ name: 'foo', ...built from options... })
}
```

Both are real, used precedents in this codebase — `@zanix/space`'s `defineSpaceApp()` and
`@zanix/admin`'s `defineAdminHubApp(options)`/`defineLocalAdminApp()` are factories; a package whose
manifest never varies by deployment (fixed routes, fixed dependencies, no per-instance credentials)
can export a plain constant instead. The deciding question: **does any field the manifest declares
depend on something only the host knows at `Zanix.start()`/`activateApps()` time** (which optional
routes to register, an `auth`-style credential, a per-instance identity)? If yes, a constant would
either have to omit that capability entirely or bake in one host's specific choice — export a
factory instead, exactly the same way a constructor takes constructor arguments rather than every
instance of a class hard-coding one caller's values. `defineZanixApp()` itself is always called
INSIDE the factory body (once per call, with that call's own options folded in) — never memoized
across calls, since two different hosts calling the same factory with different options must get two
independently normalized manifests, never a shared, mutated one.

This is a maintainer-facing decision for anyone authoring a NEW `defineXApp`-shaped export inside a
Zanix package (`@zanix/admin`, `@zanix/space`, or a future one) — not something a Zanix App's own
end consumer (a host calling `Zanix.start({ apps: {...} })`) ever needs to think about; from that
side, both shapes are just "a `ZanixAppDefinition`, however it got built."
