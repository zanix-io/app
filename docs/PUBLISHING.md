# Publishing a Zanix App

For anyone who wrote a `defineZanixApp()` manifest for a reusable capability — a business
integration, a shared admin surface, a frontend bundle — and wants a DIFFERENT team's host to
install and run it, distributed as a real package. If you're only running your own app inside your
own host, you don't need any of this — see the main [README](../README.md) instead.

## The short version

Publishing a Zanix App needs nothing Zanix-specific. A `ZanixAppDefinition` (what `defineZanixApp()`
returns) is a plain JS value — JSR's publish step has no idea it's "a Zanix App" any more than it
knows a value is "a React component." You publish it exactly like any other Deno/JSR library:

```ts
// my-app/mod.ts
import { defineZanixApp } from '@zanix/app'

export const reviewsApp = defineZanixApp({
  name: 'reviews',
  dependencies: { database: { type: 'mongo', required: true } },
  routes: true,
})
```

```jsonc
// my-app/deno.jsonc
{
  "name": "@my-scope/reviews-app",
  "version": "1.0.0",
  "exports": { ".": "./mod.ts" }
}
```

```sh
deno publish
```

That's it — no manifest registry, no special JSR config, no build step this package needs to know
about.

## Consuming it

A host installs your app exactly like any other JSR dependency, then hands the definition to
`Zanix.start()` (or `activateApps` directly — see the main README's own doc on both):

```ts
import Zanix from '@zanix/core'
import { reviewsApp } from 'jsr:@my-scope/reviews-app@^1.0.0'

await Zanix.start({
  apps: {
    reviews: {
      definition: reviewsApp,
      server: { rest: { port: 4000 } },
      uses: [{ slot: 'database', resourceName: 'mongo' }],
    },
  },
  resources: {
    mongo: { type: 'mongo', options: { uri: 'mongodb://localhost' } },
  },
})
```

The host must import your package explicitly and pass the definition object by reference — there is
no way today to hand `Zanix.start()` a bare package name/specifier string and have it load your app
for you. See ["What's not there yet"](#whats-not-there-yet) below.

## Document what your app actually needs

`@zanix/app` has no schema/discovery mechanism for a third party to introspect what a published app
requires — that's your own package's README's job:

- **`dependencies`** — every slot's `type` and whether it's `required`. A host reads your own docs
  to know it needs to supply, say, a `resources: { <name>: { type: 'mongo', options: {...} } }`
  entry plus a matching `uses` binding (or let
  [auto-bind](../README.md#appcontainer---composition-pure) resolve it, if there's exactly one root
  resource of that type).
- **`config`** — every key's `type`/`required`/`secret`. A `secret: true` key never accepts a
  literal `default` (enforced at `defineZanixApp()` time) — document how a host is expected to
  supply it (an env var your app's own code reads via `ctx.config`, for instance). Your own package
  owns this contract — `@zanix/app` only enforces the manifest shape, never what a specific slot/key
  is _for_.

## Deciding between a constant and a factory

If every field of your manifest is fixed at author time, export a plain constant (as above). If
anything depends on options only the HOST knows at composition time (credentials, which optional
routes to register, per-instance identity), export a factory instead —
`defineReviewsApp(options): ZanixAppDefinition`. See `@zanix/app`'s own
[CONCEPTS.md § "Factory vs. pre-built manifest"](./CONCEPTS.md#factory-vs-pre-built-manifest--deciding-which-shape-to-export)
for the deciding question and two real precedents (`@zanix/space`'s `defineSpaceApp()`,
`@zanix/admin`'s `defineAdminHubApp`/`defineLocalAdminApp`).

## Versioning

`AppDefinition.version` (the manifest's own field) is stored only — nothing validates cross-app
compatibility against it today. The version that actually matters is your PACKAGE's own JSR version,
pinned by whatever import map entry the host's `deno.jsonc` gives it, exactly like any other
dependency. Don't rely on the manifest's `version` field for anything a host needs to act on yet.

## What's not there yet

`AppDefinition.rootDir`/`.package` (a manifest specifier the framework would auto-`import()` for
you, so a host could declare an app by string alone instead of a static import) is not implemented —
`registerApp` stores both fields but never reads them. Until that lands, the explicit-import path
above is the only way to install a published Zanix App; there's no way around it, and no workaround
needed — it's a straightforward `import` + pass-the-object-in, not a limitation that requires
cleverness to route around.

## Local development before publishing

Use `.serve()` (see the main README) to run your own app in isolation, with fake/local resources,
before it ever leaves your machine:

```ts
const handle = await reviewsApp.serve({
  resources: {
    mongo: { type: 'mongo', options: { uri: 'mongodb://localhost' } },
  },
  uses: [{ slot: 'database', resourceName: 'mongo' }],
  server: { rest: { port: 4000 } },
})
// ...
await handle.stop()
```

## See also

- [Main README](../README.md) — the full manifest reference, `defineZanixApp()`, `.serve()`.
- [CONCEPTS.md](./CONCEPTS.md) — what a Zanix App is, the two layers, the consistency checklist for
  a NEW Zanix package (maintainer-facing, for anyone building inside this ecosystem specifically —
  this doc is for anyone publishing a Zanix App from anywhere).
