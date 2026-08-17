# Platform features (`./runtime`)

The four related tracks toward a fuller platform story (hot install/uninstall, agent/MCP
composability, multi-tenancy & resource quotas, real sandboxing), plus the DX/deploy pipeline for
running a Zanix App as its own standalone remote process. Assumes you're already familiar with the
main [README](../README.md)'s local, single-process composition model.

## Table of Contents

1. [Hot install/uninstall](#hot-installuninstall-runtime)
2. [Agent/MCP composability](#agentmcp-composability-runtime)
3. [Multi-tenancy & resource quotas](#multi-tenancy--resource-quotas-runtime)
4. [Real sandboxing](#real-sandboxing-runtime)
5. [Standalone remote deployment](#standalone-remote-deployment-runtime)

## Hot install/uninstall (`./runtime`)

Installing or removing ONE app from an ALREADY-RUNNING process, without a full restart, the way a
VTEX/Shopify-style app store would need. Scoped for this iteration to **routes + resources +
operations only** — `jobs`/`events` remain restart-only (see below for why).
`installApp`/`uninstallApp` extend/shrink the SAME `ActivatedApps` bundle `activateApps` returns, so
the caller just keeps threading the latest one through:

```ts
let activated = await activateApps([reviews])

// Later, while `reviews` keeps serving traffic:
activated = await installApp(activated, billing, {
  bindings: [{
    appName: 'billing',
    slot: 'database',
    resourceName: 'sharedDb',
  }],
})
await bootstrapAppServer('billing', billing.definition.server, false) // still the caller's job,
// exactly like activateApps never serves either

// Later still:
activated = await uninstallApp(activated, 'billing')
```

**`installApp`** re-validates the FULL merged graph (every already-active app plus the new one —
cheap and pure, so re-running it in full is simpler and safer than validating only the delta) fail
fast, BEFORE resolving or registering anything. Only the new app's own resources are resolved — a
slot that resolves to a root resource an earlier app already shares reuses that SAME instance via
`ResourceRegistry`'s existing promise-memoization, never reconstructing it.

**`uninstallApp`** does the reverse, in order: (1) blocks fail-fast (`APP_STILL_REQUIRED`) if
another still-active app has a REQUIRED `mode: 'remote'` dependency resolving to the app being
removed; (2) deregisters its Control Plane announcement (if any) and removes its route metadata —
both "stop being reachable" — before (3) running its own `onStop`; (4) releases its reference to
every resource it resolved via `ResourceRegistry.release` — a resource only IT used closes now, one
still shared with another active app stays open.

**Reference counting (`ResourceRegistry.release`)**: `resolveResources` now tags every resolved
instance with the app name that referenced it. `release(qualifiedKey, appName)` removes that one
reference and closes the instance only once NO app references it anymore — a resource shared by
three apps survives two of them being uninstalled, and closes cleanly when the third goes.

**Live route removal (`@zanix/server`)**: `ProgramModule.unregisterApplicationRoutes(appName)`
removes an Application's own route METADATA — safer to call than the pre-existing
`resetExceptApplications` when the caller only knows ONE app's own name (that one requires
enumerating every OTHER Application in the process to `preserve`, and silently wipes anything it
forgets to list). Metadata alone doesn't stop an already-bound `Deno.serve()` listener from
dispatching to it, though — `getMainHandler` compiles its own route table once, at
`WebServerManager.create()` time, and never re-reads the registry afterward. Pairing this with the
new `webServerManager.unmount(id)` — which atomically strips just that server's own dispatch entry
from its port's shared table, via the SAME freeze-and-swap `create()` itself uses, without ever
touching the real socket other Applications sharing that port still depend on — is what actually
makes an uninstalled app's routes 404 immediately. Tracking which `ServerID`s a given hot-installed
app owns (to call `unmount` for each of them) is still the caller's own responsibility, exactly like
serving them via `bootstrapAppServer` was `installApp`'s caller's responsibility in the first place.

**Honest limitations, not hidden gaps:**

- **Jobs/events are restart-only.** `registerNamespacedJobs` still runs during `installApp` (so job
  metadata IS namespaced correctly), but an already-running AsyncMQ worker/cron provider snapshots
  that metadata once at its own construction and never re-reads it — a hot-installed app's scheduled
  jobs simply never fire until the next full process restart. Making jobs genuinely hot-registrable
  would mean reworking `@zanix/asyncmq`'s own append-only registry and snapshot-at-construction
  providers — a separate, already-published package's core assumptions, out of scope here.
- **Uninstall blocking only covers DECLARED dependencies.** The `APP_STILL_REQUIRED` check reads the
  same dependency graph `validate()` does — a `mode: 'remote'` resource slot with `required: true`.
  An ad-hoc `ctx.remote(appName)` call buried in some OTHER app's `operations`/route handler carries
  no manifest declaration at all, so it can't be checked; uninstalling `appName` while such a call
  site exists elsewhere just makes that call fail at its next invocation, same as calling
  `ctx.remote()` for any app that was never running.
- **An app catalog is still unbuilt** — this closes the "no downtime" gap specifically, not the full
  VTEX/Shopify marketplace model. [Real sandboxing](#real-sandboxing-runtime) and
  [multi-tenancy with quotas](#multi-tenancy--resource-quotas-runtime) are covered below.

## Agent/MCP composability (`./runtime`)

The second of four related tracks toward a fuller platform story (see
[Hot install/uninstall](#hot-installuninstall-runtime) above, and
[Multi-tenancy & resource quotas](#multi-tenancy--resource-quotas-runtime),
[Real sandboxing](#real-sandboxing-runtime), and
[Standalone remote deployment](#standalone-remote-deployment-runtime) below). Lets an AI agent
discover and invoke a Zanix App's `operations` as MCP (Model Context Protocol) tools:

```ts
defineZanixApp({
  name: 'reviews',
  operations: {
    createReview: {
      handler: async (payload, ctx) => ({ id: 'r1', ...payload }),
      mcp: {
        description: 'Creates a product review.',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
      },
    },
  },
})

// once, anywhere during boot:
import { registerMcpServer } from '@zanix/app/runtime'
await registerMcpServer()
```

**Deliberately opt-in per operation, never automatic** — an operation with no `mcp` field is simply
never listed, regardless of its own `allowedCallers`. Operations have no schema/description
mechanism today (`@zanix/validator`'s own `BaseRTO` decorators are imperative validators, not an
introspectable schema source — confirmed before designing this, not assumed), so an agent-usable
tool needs an author to write its `description`/`inputSchema` by hand; auto-exposing every public
operation would hand agents a pile of nameless, undocumented tools instead.

**One aggregated endpoint for the whole process, not one per app** — `registerMcpServer()` (opt-in,
like `@zanix/app/core`'s own side-effect pattern; idempotent, so a second call is a no-op) serves
`POST /__zanix-mcp` under its own dedicated Application, surfacing EVERY currently-active app's
`mcp`-declared operations, namespaced `${appName}.${operationName}`. An agent connects once and
discovers the whole platform's tools, not one app's at a time.

**Authorization reuses `allowedCallers` as-is — no second permission model.** An MCP client (an
agent) authenticates via the exact same service-token exchange (`POST
/__zanix-mcp/service-token`) a
remote Zanix App already uses, under its own `serviceId` (e.g. `agent:claude-desktop`, configured
via the operator's own `JWK_PUB_<serviceId>`/ `SERVICE_PERMISSIONS_<serviceId>` env vars) — that
identity is checked against a tool's own `allowedCallers` exactly like any other caller's. Omit
`allowedCallers` to let any authenticated MCP client invoke it.

**Protocol scope — real, spec-grounded, deliberately partial** (verified against
modelcontextprotocol.io/specification/2025-06-18, not guessed): implements `initialize` →
`notifications/initialized` → `tools/list`/`tools/call`, correctly distinguishing PROTOCOL errors
(unknown method/tool — a JSON-RPC `error`) from TOOL EXECUTION errors (access denied, the handler
throwing — `result.isError: true`, the exact split the spec itself draws. NOT implemented:
`resources`/ `prompts`/`logging` capabilities, pagination, `listChanged` notifications (a hot
install/uninstall changing what's available needs the agent to re-call `tools/list` itself to
notice), `Mcp-Session-Id` session management, or SSE streaming (every response is a single,
non-streaming `application/json` body — spec-legal, since the Streamable HTTP transport lets a
server choose either). Real, documented scope boundaries for a first, useful implementation — not a
full-spec MCP server.

**Honest limitation**: this is app-to-app-shaped authorization applied to an agent's own identity —
it says nothing about which HUMAN triggered the agent's call in the first place. A future iteration
could propagate an end-user's own scope alongside the agent's service token if that becomes a real
requirement.

## Multi-tenancy & resource quotas (`./runtime`)

The third of four related tracks. Before designing anything here, it turned out MOST of what
"multi-tenancy" usually means was already solved: every existing resolution key in this package — a
resource's `qualifiedKey`, a config override's key, a route's mount prefix, even `@zanix/auth`'s own
rate-limit key — is already scoped by **app name**, never globally. That means installing the SAME
app definition under a DIFFERENT name per tenant already gives each tenant fully isolated
resources/config/routes/rate-limiting, with ZERO new code:

```ts
import { activateApps, installApp } from '@zanix/app/runtime'
import { billing } from './billing-app.ts' // one shared defineZanixApp() definition

let activated = await activateApps([])

// Onboard a new tenant: install the SAME definition, renamed for this tenant, with ITS OWN
// resource bindings (a separate database, a separate API key) — already fully supported by
// installApp, nothing new here.
activated = await installApp(
  activated,
  { ...billing.definition, name: 'billing-acme' },
  {
    bindings: [{
      appName: 'billing-acme',
      slot: 'database',
      resourceName: 'acmeMongo',
    }],
  },
)
activated = await installApp(
  activated,
  { ...billing.definition, name: 'billing-globex' },
  {
    bindings: [{
      appName: 'billing-globex',
      slot: 'database',
      resourceName: 'globexMongo',
    }],
  },
)
```

`billing-acme` and `billing-globex` never collide: their resources resolve under distinct qualified
keys (`billing-acme:database` vs. `billing-globex:database`), their `ctx.config` overrides are keyed
by app name, their routes mount under distinct prefixes, and any app-to-app/MCP call each makes gets
rate-limited independently (`@zanix/auth`'s existing guard already keys its counter by `app` — see
its own docs; nothing new was built or needed here). Uninstall one tenant (`uninstallApp`) without
touching the other, same as any other hot-uninstall.

**What was genuinely missing — a resource-instance quota, not rate-limiting.** Request-rate limiting
already existed; what didn't was a ceiling on how many resource INSTANCES (Mongo connections, Redis
pools, ...) one installed app may hold at once — needed so a single tenant's install can't exhaust
shared infrastructure. `InstallAppOptions.maxResources` sets it at install time:

```ts
activated = await installApp(activated, { ...billing.definition, name: 'billing-acme' }, {
  bindings: [...],
  maxResources: 5, // billing-acme may reference at most 5 distinct resource instances
})
```

Enforced by `ResourceRegistry.setQuota`/the existing `resolve()` path — counts DISTINCT
`qualifiedKey`s the app references (referencing an already-shared root resource still counts as one
unit, even though nothing new was constructed for it), checked BEFORE a factory ever runs so a
denied request never pays construction cost. Throws `InternalError` `RESOURCE_QUOTA_EXCEEDED`.
`uninstallApp` clears a tenant's quota automatically, so a later install reusing that exact app name
never inherits a stale ceiling from whoever used it before.

**Honest scope**: this closes resource-instance exhaustion specifically — it is NOT a CPU/memory/
wall-clock sandboxing mechanism (that's the 4th pillar, "Real sandboxing", below) and it is NOT a
usage-billing/budget primitive (a "N calls per month" cap) — only a hard ceiling on concurrent
resource references. A first-class `tenantId` concept threaded through the framework (as a dimension
distinct from app name) was considered and deliberately NOT built — it would have meant a much
larger rearchitecture for something the existing app-name-scoped model already provides.

## Real sandboxing (`./runtime`)

The fourth and final of these related tracks. An operation can declare `sandbox` instead of
`handler` to run inside its OWN dedicated, permission-restricted Deno Worker instead of inline in
the main process:

```ts
// tasks/fetch-rate.ts — a real, standalone, independently-importable module
export function fetchRate(payload: { pair: string }) {
  return fetch(`https://api.example.com/rate/${payload.pair}`).then((r) => r.json())
}
```

```ts
defineZanixApp({
  name: 'billing',
  operations: {
    fetchRate: {
      sandbox: {
        metaUrl: new URL('./tasks/fetch-rate.ts', import.meta.url).href,
        permissions: {
          net: ['api.example.com'],
          read: true,
          write: false,
          env: false,
          run: false,
        },
        timeout: 5000,
      },
    },
  },
})
```

**Scoped to `operations` only** — routes, `onStart`/`onStop`, and resource construction still run
inline in the main process; this is the honest v1 boundary, not an oversight. A hard, unavoidable
structural constraint applies too: a Worker communicates with its parent only via `postMessage`
(structured-clone), so a sandboxed operation can NEVER receive a live `RuntimeContext`
(`ctx.resource()`'s real connectors, `ctx.remote`'s callable) — those are host-process objects that
fundamentally cannot cross that boundary. A sandboxed task is therefore authored as a PLAIN,
standalone function taking only its own `payload`, exported from a real module (never an inline
closure next to `defineZanixApp()`'s own call) — the same `WorkerManager`/`dispatchWorkerTask`
convention `@zanix/server`'s own worker dispatch already uses. That module may still `import`
`@zanix/server`/construct its OWN resources if it needs to, but never the host's shared,
already-open connections.

**A dedicated pool per sandboxed operation, not `@zanix/server`'s shared `this.worker`.** Each
`sandbox` declaration gets its OWN `WorkerManager` (fixed permissions for its whole lifetime) built
by `buildSandboxedHandler` — deliberately NOT `ZanixWorkerProvider`'s persisted, generic pool: that
pool is shared across every general task a provider dispatches and can't mix per-operation-specific
restricted permission profiles, and there is no DI `this` context available inside
`registerOperations` to resolve it through anyway. `uninstallApp` terminates a hot-uninstalled app's
own sandboxed workers (`closeSandboxedWorkers`) alongside its existing resource release, so nothing
leaks past the app's own lifetime.

**Requires Deno's still-unstable `worker-options` feature** (`"unstable": ["worker-options"]` in
your own `deno.jsonc`/`deno.json`, or `--unstable-worker-options`) for any operation that declares
`permissions` — without it, that operation's worker throws as soon as it's first invoked. And since
an object `permissions` value replaces the _entire_ permission set rather than inheriting unlisted
categories, the task's own module needs `read` (or `net`, for a remote `metaUrl`) no matter what the
task itself does — it's loaded via a dynamic `import(metaUrl)` inside the worker before it ever
runs.

A sandboxed operation's failure (permission denial, a thrown/rejected task, or a `timeout`) always
surfaces the same way to its caller: `InternalError` `SANDBOX_TASK_FAILED`, wrapping the underlying
worker-reported error as `cause` — `ctx.remote(...).call(...)` never distinguishes a sandboxed
operation's failure mode from a regular one's.

**Honest limitation**: `permissions` restricts ACCESS (network/filesystem/env/subprocess/FFI) — it
is NOT a CPU-time or memory quota. Deno's own `Worker` API has no such governance option today
(confirmed, not assumed); `timeout` is the only available protection against a runaway/CPU-bound
task, and there is currently no way to cap a worker's memory usage from plain TypeScript/JavaScript
without a custom Rust-embedded Deno build, which this package does not attempt.

## Standalone remote deployment (`./runtime`)

The DX/deploy pipeline track, independent of the four tracks above. A Zanix App is an installable
manifest first (most are meant to be embedded by a host via `Zanix.start()`'s `apps` option), but
one can also run as its own standalone remote process — `runtime.mode: 'remote'` + `activateApps`'s
`remoteInstances` already made this possible at the runtime level, but there was no real path from
"author a Zanix App" to "a running standalone instance in production": no entrypoint, no Dockerfile,
no CLI support. `bootstrapRemoteApp` closes that gap:

```ts
import { bootstrapRemoteApp } from '@zanix/app/runtime'
import app from './mod.ts'

await bootstrapRemoteApp(app, {
  server: { rest: {} },
  remoteInstances: { endpoint: 'http://my-app:8000' }, // omit to run standalone without announcing
})
```

Deliberately NOT `.serve()` with extra options bolted on — `.serve()` is documented as the author's
own local dev loop and intentionally never announces to the Control Plane or wires OS signal
handling; retrofitting production concerns onto it would blur that contract for every existing
caller. `bootstrapRemoteApp` reuses the exact same `activateApps`/`bootstrapAppServer` primitives
`.serve()` and `Zanix.start()` already share — still only ONE real activation/serving
implementation, just a second, genuinely different caller of it. Graceful shutdown mirrors
`Zanix.start()`/`Zanix.stop()` exactly: `SIGINT`/`SIGTERM` trigger `deactivateApps` (this app's own
`onStop` + resource release) BEFORE the web servers themselves stop, and the listeners are removed
before running so a second signal (or a caller-invoked `stop()`) can never double-run the shutdown.

**`zanix prepare --docker -p app`** scaffolds the rest: a `serve.ts` entrypoint (this same
`bootstrapRemoteApp` call, ready to edit — never overwritten if it already exists), a matching
`serve` task in this project's own `deno.json` (`deno run --env-file=.env <perms> serve.ts`, never
overwriting an existing customization), and a `Dockerfile` whose `CMD ["task", "serve"]` runs it —
sharing the exact same template `'server'`-type projects use (`FROM`/`WORKDIR`/`ENV`/`COPY`/
`EXPOSE`/`CMD ["task", ...]`), differing only in which file gets cached and which task name the
`CMD` runs. See `@zanix/cli`'s own `docs/prepare.md`/`docs/DEPLOY.md` for the full CLI-side detail.

## See also

- [Main README](../README.md) — local, single-process composition (`defineZanixApp()`,
  `AppContainer`, `ResourceRegistry`, `activateApps`/`deactivateApps`).
- [Distributed runtime](./DISTRIBUTED-RUNTIME.md) — remote app discovery, `ctx.remote()`,
  distributed lifecycle, leader election, Gateway, Remote Resource Binding.
- [Concepts](./CONCEPTS.md) — what a Zanix App is, and how it relates to the rest of the Zanix
  ecosystem.
- [Publishing a Zanix App](./PUBLISHING.md) — distributing your own `defineZanixApp()` as a package.
