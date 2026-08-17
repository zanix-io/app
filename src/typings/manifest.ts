/**
 * Manifest contracts for a Zanix App — the declarative shape an author writes
 * (`AppDefinition`), its canonical resolved form (`NormalizedAppDefinition`), and the
 * composition-time structures (`ResourceBinding`/`DependencyGraph`/`ResolvedResourceKey`) used to
 * bind a set of apps against a host's resources. Every type here is pure data — none of them
 * import anything from `@zanix/server`, which is what lets `@zanix/app`'s `.` entry point stay
 * dependency-free (see `mod.ts`'s own doc).
 *
 * The one exception is `JobDefinitionEntry` below, which references `@zanix/asyncmq`'s OWN
 * exported types via `import type` — a compile-time-only reference, erased entirely at build
 * time, so it costs nothing at runtime and pulls in none of that package's actual code. It's
 * deliberate: what a job needs to run (`handler`, queue selection, cron format) is
 * `@zanix/asyncmq`'s contract to own, not something this module re-declares in parallel —
 * a hand-rolled structural copy would drift the moment that package's real contract changes.
 *
 * @module
 */
import type { CronJobDefinitionBase, JobProcess } from '@zanix/asyncmq'
import type { RemoteAppHandle } from './remote.ts'

/** Primitive type a `config` entry's value can hold. */
export type ConfigValueType = 'string' | 'number' | 'boolean'

/**
 * The author's own DEFAULT execution mode suggestion — never a command the app itself executes or
 * counts. `'embedded'` (default) is the original, always-supported model, unchanged. `'remote'`
 * means this app is meant to run as its own process, announcing itself to
 * the Control Plane once activated (see `activateApps`'s own `remoteInstances` parameter in
 * `@zanix/app/runtime`) — nothing here toggles that behavior by itself; a host activating this
 * app decides for real, at `activateApps()`/`Zanix.start()` time, exactly the same precedence
 * `config` already follows (author declares a default, the host may override it without touching
 * the app's own code).
 */
export interface RuntimeModeOptions {
  /** `'embedded'` (default) | `'remote'`. */
  mode?: 'embedded' | 'remote'
  /** A policy HINT for how many replicas this app expects to run as — never a number the app
   * itself executes, reads, or enforces; the Control Plane is the only thing that ever compares
   * this against what's actually observed. */
  replicas?: number
}

/** A resource constructed and owned by THIS process — the original, always-supported kind. */
export interface LocalResourceDeclaration {
  /** Compared against `dependencies.<slot>.type` by `validate()`. */
  type: string
  /** Construction options, passed to whatever factory `type` resolves to. */
  options: Record<string, unknown>
  /** Omit entirely — the default, and the original, always-supported kind. Present only to
   * discriminate against {@link RemoteResourceDeclaration.mode}. */
  mode?: 'local'
}

/**
 * A resource this process never constructs at all:
 * `ctx.resource(slot)` resolves to an RPC handle (`RemoteAppHandle`, the exact same shape
 * `ctx.remote(endpoint)` already returns) instead of a real connector instance. **Deliberately
 * NOT transparent** — an earlier aspiration assumed a caller could use `ctx.resource('database')`
 * without ever needing to distinguish a remote resource from a local one, keeping a local
 * resource's full native method surface (e.g. Mongo's `.find()`/`.insertOne()`) proxied invisibly;
 * it can't be, without either per-type proxy
 * classes reimplementing that whole surface, or blanket reflection-based method forwarding — both
 * rejected as real new mechanisms this package would then own and maintain. Reusing
 * `ctx.remote()`'s own `{call(operationName, payload, options)}` RPC contract as-is, unchanged,
 * costs nothing new to build or explain — an author calls `ctx.resource('database').call('find',
 * {...})` instead of `ctx.resource('database').find(...)`, a real, disclosed difference from a
 * local resource, not a hidden one.
 */
export interface RemoteResourceDeclaration {
  /** Compared against `dependencies.<slot>.type` by `validate()` — same contract as a local
   * resource; nothing about cross-app dependency validation changes because a slot resolved
   * remote instead of local. */
  type: string
  /** Discriminates this from {@link LocalResourceDeclaration} — always the literal `'remote'`. */
  mode: 'remote'
  /** The Zanix App that owns and exposes this resource's real instance — routed through exactly
   * `ctx.remote(endpoint)`'s own mechanism (local-first if `endpoint` happens to be active in
   * this same process, `HttpRemoteAdapter` otherwise), never a second, parallel transport. */
  endpoint: string
  /**
   * A semver range (`@std/semver`'s own `parseRange` format — e.g. `'^1.0.0'`, `'>=2.1.0 <3.0.0'`)
   * `endpoint`'s own manifest `version` must satisfy — the manifest's own `version` field started
   * as merely stored, never validated against anything; this is that same field's stored-only-to-
   * validated progression, applied here to a cross-app reference specifically.
   *
   * **Honest scope, checked only when it CAN be, synchronously, at composition time**: `validate()`
   * only ever has this graph's OWN `apps` map to check against — if `endpoint` is genuinely a
   * separate process never listed alongside this one (the common case for an actually-`remote`
   * app), there is no version to compare here at all; an async Control Plane lookup would be
   * needed for that, which `validate()` (deliberately synchronous, fail-fast BEFORE anything is
   * constructed) doesn't do. Checked only when `endpoint` IS present in this same composition
   * (`graph.apps`) and DID declare its own `version` — silently skipped otherwise (never a false
   * failure for something genuinely unknowable here), not a hidden gap: an app that truly needs
   * this enforced across a real process boundary has nothing built for that yet.
   */
  requiredVersion?: string
}

/** Shape of one `resources`/`localResources`/`RootResources` entry. Identical whether it lives on
 * an app's own manifest (`AppDefinition.resources`), its normalized form
 * (`NormalizedAppDefinition.localResources`), or the host's root (`RootResources`) — the same
 * data, never re-shaped between them. See {@link LocalResourceDeclaration}/
 * {@link RemoteResourceDeclaration} for the two possible shapes. */
export type ResourceDeclaration =
  | LocalResourceDeclaration
  | RemoteResourceDeclaration

/** Shape of one `dependencies` entry as the app AUTHOR writes it — `required` optional (defaults
 * to `false`; see `NormalizedAppDefinition.dependencies`, which uses `Required<>` on this same
 * type once the default is applied, never a separately hand-written shape). */
export interface DependencyDeclaration {
  /** The kind of resource this slot needs — compared against the resolved resource's own
   * `type` by `validate()`. */
  type: string
  /** Whether `Zanix.start()` must fail fast if this slot never resolves to anything. */
  required?: boolean
}

/**
 * One `behaviors.<name>` entry — a pure function/strategy an author declares as swappable by
 * whoever composes this app (`activateApps()`'s own `behaviors` parameter, or `@zanix/core`'s
 * `apps.<name>.behaviors`), deliberately distinct from `resources`/`dependencies`: a resource is
 * for something with a REAL LIFECYCLE (construction, `close()`, health-gating, quotas — see
 * {@link ResourceDeclaration}); a behavior has none of that — it's just a function, given a
 * sensible default the app can already call on its own, resolved the exact same way whether a host
 * ever overrides it or not. Reach for `resources` when the swappable thing needs to be
 * constructed/closed/health-checked; reach for `behaviors` when it's a plain function a host might
 * want to replace (a pricing rule, a formatting strategy, a routing decision) — using `resources`
 * for the latter works, but forces an app to model a pure function as a stateful connector it isn't.
 *
 * No generic type parameter, deliberately: `Record<string, BehaviorDeclaration>` can't express a
 * distinct function signature per key any more than {@link OperationDeclaration}'s own
 * `Record<string, OperationDeclaration>` can — `ctx.behavior(name)` returns `unknown`, the same way
 * `ctx.resource(slot)` already does, and the caller casts to whatever signature they declared.
 */
export interface BehaviorDeclaration {
  /** Called whenever no host-supplied override exists for this behavior — the app's own real,
   * working implementation, never a stub that throws or a placeholder. `never[]` (not `unknown[]`)
   * for the same contravariance reason `AppSetupContext.resolve`'s own `Target` parameter uses it
   * — it's what lets an author assign a concretely-typed function (e.g. `(order: Order) =>
   * number`) here at all. */
  default: (...args: never[]) => unknown
  /** Human-readable explanation of what this behavior does and when a host might want to override
   * it — documents intent directly on the manifest, next to the default it's describing, rather
   * than only in a comment beside it. Not surfaced anywhere yet (no discovery/introspection UI
   * built for this). */
  description?: string
}

/** A behavior override declared by the HOST (`activateApps()`'s own `behaviors` parameter, or
 * `@zanix/core`'s `apps.<name>.behaviors`) — never by the app itself. Unlike
 * {@link ResourceBinding} (which names an ALTERNATIVE RESOURCE to resolve), this carries the
 * replacement implementation directly: a behavior has no construction step to defer, so there's
 * nothing to look up by name on the host's side. */
export interface BehaviorOverride {
  /** Which app this override belongs to — must exist in the composed set. */
  appName: string
  /** Must exist in that app's own `behaviors`. */
  name: string
  /** Replaces `behaviors.<name>.default` for every `ctx.behavior(name)` call this app makes,
   * for the lifetime of this composition. Same `never[]` reasoning as
   * {@link BehaviorDeclaration.default}. */
  implementation: (...args: never[]) => unknown
}

/** Events an app declares it emits/listens to — untyped payload for now. Identical before and
 * after normalization; `normalize()` performs no work on this field, so `AppDefinition.events`
 * and `NormalizedAppDefinition.events` share this one alias rather than two separately
 * hand-written (but supposedly identical) shapes. */
export type EventsDeclaration = Record<string, Record<string, never>>

/**
 * One `jobs.<name>` entry. `handler` + queue selection (`processingQueue`/`customQueue`) come
 * straight from `@zanix/asyncmq`'s own `JobProcess` — never re-declared here. `schedule`/
 * `isActive` are likewise `@zanix/asyncmq`'s own `CronJobDefinitionBase` fields, just made
 * optional (their presence is what distinguishes a scheduled job — `registerCronJob` — from an
 * on-demand one — `registerJob` — see `NormalizedAppDefinition.jobs`).
 */
export type JobDefinitionEntry =
  & JobProcess
  & Partial<Pick<CronJobDefinitionBase, 'schedule' | 'isActive'>>

/**
 * Exactly as the app's author writes it — `defineZanixApp()`'s parameter. Shorthand allowed
 * (`routes: true`, `config` without every field, etc.) — `normalize()` resolves it to
 * {@link NormalizedAppDefinition}.
 */
export interface AppDefinition {
  /** Identity; default for the Application + prefix for routes/jobs/events. Must match
   * `^[a-z][a-z0-9-]*$` — validated by `normalize()`, not here (this type validates nothing). */
  name: string
  /** Stored only — no cross-app compatibility validation yet. */
  version?: string
  /** See {@link RuntimeModeOptions}. Omitted entirely = `{mode: 'embedded'}`, the original,
   * always-supported behavior — this app never contacts the Control Plane. */
  runtime?: RuntimeModeOptions
  /** `true` (auto-prefix with `name`) | `false` (no routes at all) | `{ prefix }` (explicit,
   * `''` = a deliberate opt-out of namespacing). */
  routes?: true | false | { prefix: string }
  /** The closed, auditable set of resources this app can touch — declares WHAT type/shape it
   * needs, never a concrete name (that lives in `uses`, on the host's side). */
  dependencies?: Record<string, DependencyDeclaration>
  /** App-local parameters. `secret: true` never accepts a literal `default`. */
  config?: Record<string, {
    type: ConfigValueType
    default?: unknown
    required?: boolean
    secret?: boolean
  }>
  /** Namespaced internally to `${name}:${jobName}` to avoid collisions between apps. */
  jobs?: Record<string, JobDefinitionEntry>
  /** Named handlers OTHER Zanix Apps can invoke via `ctx.remote(name).call(operationName, ...)` —
   * see {@link OperationHandler}/{@link OperationDeclaration}. Never namespaced by name the way
   * `jobs` are: the operation name is already scoped to this app via `ctx.remote(name)`'s own
   * `name` argument. */
  operations?: Record<string, OperationDeclaration>
  /** Events this app declares it emits/listens to — untyped payload for now. */
  events?: EventsDeclaration
  /** Pure functions/strategies this app declares as swappable by whoever composes it — see
   * {@link BehaviorDeclaration} for when to reach for this instead of `resources`. */
  behaviors?: Record<string, BehaviorDeclaration>
  /** This app's local resources — shadows a root resource of the same name, only for slots it
   * itself declared in `dependencies`. */
  resources?: Record<string, ResourceDeclaration>
  /** Relative to the resolved package location (if `package` is set) or the host's cwd. */
  rootDir?: string
  /** Package specifier (`import(packageSpecifier)`) for a distributed app. */
  package?: string
  /** Programmatic registration/resolution — an escape hatch for when the declarative manifest
   * (`routes`/`dependencies`/`config`/`jobs`/`events`) isn't enough. */
  setup?: (ctx: AppSetupContext) => void | Promise<void>
  /** Runs sequentially, in declaration order across apps. */
  onStart?: (ctx: AppStartContext) => void | Promise<void>
  /** Runs in parallel (`Promise.allSettled`) across apps. */
  onStop?: (ctx: AppStopContext) => void | Promise<void>
}

/**
 * Output of normalizing an {@link AppDefinition} — same data, zero unresolved shorthand,
 * `name` already validated against the slug format. This is the only thing later composition
 * reads — it never touches the original `AppDefinition` again.
 */
export interface NormalizedAppDefinition {
  /** Validated against `^[a-z][a-z0-9-]*$`. */
  name: string
  /** `null` if the manifest never declared `version`. */
  version: string | null
  /** Shorthand already resolved — `mode` always `'embedded'`/`'remote'` (default `'embedded'`),
   * `replicas: null` if never declared. */
  runtime: { mode: 'embedded' | 'remote'; replicas: number | null }
  /** `null` = `routes: false`; `''` = an explicit opt-out with no namespacing; any other string
   * = an explicit prefix or one auto-generated from `name`. */
  routesPrefix: string | null
  /** Shorthand already resolved — `required` always present (default `false`). */
  dependencies: Record<string, Required<DependencyDeclaration>>
  /** Shorthand already resolved — every optional field from the original `AppDefinition` is
   * left with its explicit default (`null`/`false`). */
  config: Record<string, {
    type: ConfigValueType
    default: unknown | null
    required: boolean
    secret: boolean
  }>
  /** `handler`/queue selection are `@zanix/asyncmq`'s own (`JobProcess`), never re-declared.
   * `schedule: null` if the job never declared one (triggered by an event/queue message via
   * `registerJob`, not by cron via `registerCronJob`) — here the real `schedule` type (a
   * 6-field cron format) IS widened to `string | null` so this module has a single, uniform
   * access point; `AppDefinition.jobs` (above) still requires the real format from the author. */
  jobs: Record<
    string,
    JobProcess & {
      schedule: string | null
      isActive: boolean
    }
  >
  /** `AppDefinition.operations`'s shorthand already resolved — every entry is the full
   * `{handler, sandbox, allowedCallers, mcp}` shape regardless of which form the author wrote.
   * Exactly one of `handler`/`sandbox` is non-`null` — never both, never neither (`normalize()`
   * validates this). `allowedCallers: null` means "no ACL declared", i.e. public; `mcp: null`
   * means "not exposed as an MCP tool" (see {@link OperationDeclaration}/
   * {@link McpToolDeclaration}/{@link SandboxDeclaration}). */
  operations: Record<string, {
    handler: OperationHandler | null
    sandbox: SandboxDeclaration | null
    allowedCallers: string[] | null
    mcp: McpToolDeclaration | null
  }>
  /** Same shape as `AppDefinition.events`, no additional normalization. */
  events: EventsDeclaration
  /** Same shape as `AppDefinition.behaviors`, no additional normalization — `{}` if the manifest
   * never declared any. */
  behaviors: Record<string, BehaviorDeclaration>
  /** Renamed from `AppDefinition.resources` — "local" to distinguish it from `RootResources`
   * (the host's own), never the same objects. */
  localResources: Record<string, ResourceDeclaration>
  /** Default `'.'` already applied. */
  rootDir: string
  /** `null` if the manifest never declared `package` (an app from the same repo, via
   * `rootDir`). */
  package: string | null
  /** `null` if the manifest never declared `setup`. */
  setup: ((ctx: AppSetupContext) => void | Promise<void>) | null
  /** `null` if the manifest never declared `onStart`. */
  onStart: ((ctx: AppStartContext) => void | Promise<void>) | null
  /** `null` if the manifest never declared `onStop`. */
  onStop: ((ctx: AppStopContext) => void | Promise<void>) | null
}

/**
 * One named, protocol-agnostic operation an app exposes to OTHER Zanix Apps via
 * `ctx.remote(name).call(operationName, payload)` — deliberately separate from `routes` (the app's
 * own HTTP surface for external clients). The same handler runs whether the caller is in the same
 * process (invoked directly, no network) or a different one (invoked over HTTP, `payload`
 * JSON-round-tripped) — the author never writes two versions.
 *
 * @param payload Already deserialized if this call crossed a process boundary — a plain value
 * either way, never a raw HTTP request.
 * @param ctx This app's own `{resource, config}` — the same shape `onStart`/`onStop` receive, not
 * the caller's.
 */
export type OperationHandler = (
  payload: unknown,
  ctx: RuntimeContext,
) => Promise<unknown>

/**
 * How one `operations.<name>` entry may be declared — a bare {@link OperationHandler} (fully
 * public: any caller with a valid token/local access may invoke it, the exact behavior this had
 * before per-operation scoping existed) or an object pairing it with `allowedCallers` (capability-
 * based permission scoping, "beyond VTEX" platform work): the list of Zanix App names allowed to
 * invoke it — `'*'` as a member, or omitting `allowedCallers` entirely, both mean public. Checked
 * against the CALLING app's own identity — `ctx.remote()`'s `callerAppName` for a same-process
 * call, the exchanged service token's `sub` claim for a cross-process one — never against a
 * human/end-user identity; this is app-to-app authorization, not user authorization (that's
 * `@zanix/auth`'s own `@RequirePermissions`, on `routes`, a separate concern).
 *
 * Deliberately opt-in, not secure-by-default: an operation declared as a bare function (or with
 * `allowedCallers` omitted) stays exactly as callable as it always was — restricting it is
 * something an author does deliberately, not something every existing app must retrofit.
 */
export type OperationDeclaration =
  | OperationHandler
  | {
    handler: OperationHandler
    allowedCallers?: string[]
    mcp?: McpToolDeclaration
  }
  | {
    sandbox: SandboxDeclaration
    allowedCallers?: string[]
    mcp?: McpToolDeclaration
  }

/**
 * Runs this operation inside its OWN dedicated, permission-restricted Deno Worker instead of
 * inline in the main process — real sandboxing, scoped to `operations` only
 * (routes/`onStart`/`onStop`/resource construction still run inline —
 * see the package README's own "Real sandboxing" section for why that's the honest v1 boundary).
 *
 * A hard, unavoidable structural constraint, not a stylistic choice: a Worker communicates with
 * its parent only via `postMessage` (structured-clone), so a sandboxed operation can NEVER receive
 * a live `RuntimeContext` (`ctx.resource()`'s real connectors, `ctx.remote`'s callable) — those are
 * host-process objects that fundamentally cannot cross that boundary. A sandboxed handler is
 * therefore authored as a PLAIN, standalone function taking only its own `payload` — reusing
 * `@zanix/workers`' own `WorkerManager`/`dispatchWorkerTask` convention (a NAMED EXPORT of a REAL,
 * independently-importable module, referenced by `metaUrl`/`taskName` — never an inline closure in
 * the same file as `defineZanixApp()`'s own call, since inline closures can't ship to a worker at
 * all). That module may still `import` `@zanix/server`/construct its OWN resources if it needs
 * to — confirmed against this codebase's own existing worker-task callers — but never the HOST's
 * shared, already-open connections; whatever it constructs is subject to `permissions` below.
 */
export interface SandboxDeclaration {
  /** The module containing the task function, exactly as `WorkerManager.task`'s own `metaUrl`
   * option expects (typically `import.meta.url` of that module, from inside IT — not from the
   * file calling `defineZanixApp()`). */
  metaUrl: string
  /** The task function's own export name inside that module. Defaults to this operation's own
   * name (the `operations.<name>` key) when omitted. */
  taskName?: string
  /** Restricts what THIS operation's dedicated worker may do — `net`/`read`/`write`/`env`/`run`/
   * `ffi`/`sys`, forwarded as-is to `Worker`'s own `deno.permissions` option (see
   * `@zanix/workers`' `WorkerManager`). A worker's permissions can never exceed the host
   * process's own (Deno's own Worker API enforces that, not this package). Omit for a sandboxed
   * operation that only needs thread isolation, not access restriction — still real (a runaway
   * task can't take down the main thread), just not permission-scoped.
   *
   * **Requires Deno's still-unstable `worker-options` feature** — the whole app process needs
   * `"unstable": ["worker-options"]` in its own `deno.jsonc`/`deno.json` (or
   * `--unstable-worker-options`), or building this worker throws as soon as any operation using
   * `permissions` is first invoked.
   *
   * **The task's own module needs `read` (or `net`, for a remote `metaUrl`) no matter what the
   * task itself does** — an object value here replaces the *entire* permission set rather than
   * inheriting unlisted categories (they default to fully denied), and the task is loaded via a
   * dynamic `import(metaUrl)` inside the worker before it ever runs.
   *
   * **Honest limitation**: this restricts ACCESS (network/filesystem/env/subprocess/FFI) — it is
   * NOT a CPU-time or memory quota. Deno's own `Worker` API has no such governance option today
   * (confirmed, not assumed); `timeout` below is the only available protection against a
   * runaway/CPU-bound task, and there is currently no way to cap a worker's memory usage from
   * plain TypeScript/JavaScript without a custom Rust-embedded Deno build, which this package
   * does not attempt.
   */
  permissions?: Deno.PermissionOptions
  /** Maximum execution time (ms) before this operation's worker is terminated — reuses
   * `WorkerManager`'s own existing timeout-then-`terminate()` mechanism unchanged; this is the
   * ONLY governance this package has over a sandboxed operation running too long (see
   * `permissions`'s own doc on why CPU/memory quotas aren't available at all). Defaults to
   * `WorkerManager`'s own default (currently `10000`). */
  timeout?: number
}

/**
 * Opts ONE operation into being exposed as an MCP (Model Context Protocol) tool an AI agent can
 * discover and invoke — first-class agent composability. Deliberately opt-in per operation, not
 * automatic for every public one: an
 * operation with no `mcp` field is simply never listed by `tools/list`, regardless of its own
 * `allowedCallers` — an agent-usable tool needs a human-readable `description`/`inputSchema` an
 * app-to-app caller never did, so blanket-exposing every public operation would hand agents a pile
 * of nameless, undocumented tools.
 *
 * Authorization for an agent invoking this tool is NOT a separate mechanism — it reuses
 * `allowedCallers` as-is: an MCP client authenticates via the exact same service-token exchange a
 * remote Zanix App would (a `serviceId` like `agent:claude-desktop`), and that identity is checked
 * against `allowedCallers` exactly like any other caller's. Omit `allowedCallers` (public) to let
 * any authenticated MCP client invoke it.
 */
export interface McpToolDeclaration {
  /** Human/agent-readable explanation of what this tool does — surfaced verbatim in `tools/list`.
   * MCP tools are only useful to an agent with a clear description; there's no fallback here. */
  description: string
  /**
   * A JSON Schema object describing this operation's expected `payload` shape, surfaced verbatim
   * in `tools/list` so an agent knows what arguments to send. Passed through as-is — never
   * validated against the actual payload before invoking the handler (there's no JSON-Schema
   * validation engine in this package; the operation's own handler is still responsible for
   * validating its own payload, same as it always was). Omit for a tool that takes no meaningful
   * arguments — defaults to an empty-object schema (`{ type: 'object' }`).
   */
  inputSchema?: Record<string, unknown>
}

/** A binding declared by the HOST (`apps.<n>.uses` at `Zanix.start()` time) — never by the app:
 * which concrete resource satisfies the slot the app declared in `dependencies`. */
export interface ResourceBinding {
  /** Which app this binding belongs to — must exist in `DependencyGraph.apps`. */
  appName: string
  /** Must exist in that app's `dependencies`. */
  slot: string
  /** Must exist in `rootResources` or in that app's `localResources`. */
  resourceName: string
}

/** Resources declared at the host's root (`SetupOptions.resources`), outside of any app. */
export type RootResources = Record<string, ResourceDeclaration>

/** Fields every `ResolvedResourceKey` variant shares, regardless of `mode`. */
export interface ResolvedResourceKeyBase {
  /** `'mongo'` (shared at the root) | `'reviews:mongo'` (local, a shadow). The real key
   * `ResourceRegistry.resolve()` receives — meaningless for a `mode: 'remote'` key (nothing is
   * ever constructed/cached under it), kept only so both variants share this field uniformly. */
  qualifiedKey: string
  /** The resolved resource's type — compared against `dependencies.<slot>.type` by
   * `validate()`. */
  type: string
  /** `null` = shared at the root; `appName` = local to that app. */
  ownerApp: string | null
}

/** A fully qualified key for a given `(appName, slot)`, already resolved against
 * `rootResources`/`localResources`/bindings — see `buildGraph()`. Mirrors
 * {@link LocalResourceDeclaration}/{@link RemoteResourceDeclaration}'s own split: `options` only
 * on the local variant, `endpoint` only on the remote one. */
export type ResolvedResourceKey =
  | (ResolvedResourceKeyBase & {
    mode?: 'local'
    /** Construction options of the resolved resource, exactly as declared in `resources`. */
    options: Record<string, unknown>
  })
  | (ResolvedResourceKeyBase & {
    mode: 'remote'
    /** See {@link RemoteResourceDeclaration.endpoint}. */
    endpoint: string
    /** See {@link RemoteResourceDeclaration.requiredVersion}. */
    requiredVersion?: string
  })

/**
 * Pure in-memory structure assembled by `buildGraph()`, consumed by `validate()` — no
 * validation step ever re-parses manifests/`uses`/`resources` on its own.
 */
export interface DependencyGraph {
  /** Every normalized app, indexed by its own `name`. */
  apps: Map<string, NormalizedAppDefinition>
  /** The exact same root resources passed to `buildGraph()`, never copied. */
  rootResources: RootResources
  /** The exact same bindings (`uses`) passed to `buildGraph()`, never copied. */
  bindings: ResourceBinding[]
  /** Key = `${appName}:${slot}`. Only contains entries for slots that DID resolve to something
   * — a non-required slot with no binding and no local resource simply never appears here. */
  resolvedKeys: Map<string, ResolvedResourceKey>
}

/** Read-only accessor over `config` already resolved/validated at bootstrap — never triggers a
 * new resolution, whether from `setup`/`onStart`/`onStop`. */
export interface ConfigAccessor {
  /** The already-resolved value of `config.<key>`. */
  get<K extends string = string>(key: K): unknown
  /** Whether `key` was declared in this app's manifest. */
  has(key: string): boolean
}

/** Base shared by an app's three lifecycle moments (`setup`/`onStart`/`onStop`) — read-only
 * access to already-resolved resources/config, never to construction. */
export interface RuntimeContext {
  /** Reads from the `Map` already resolved by `AppContainer.resolveResources` — never triggers
   * a new construction.
   * @param slot Must exist in this app's `dependencies`. */
  resource<K extends string = string>(slot: K): unknown
  /** See {@link ConfigAccessor}. */
  config: ConfigAccessor
  /** Resolves `name` to a callable handle — local (same process, no network) or remote (HTTP),
   * transparently. See {@link RemoteAppHandle}.
   * @param name The target app's `name`, as declared in ITS manifest — never a resource/slot. */
  remote(name: string): RemoteAppHandle
  /** Resolves to a host-supplied override if one was given for this behavior (`activateApps()`'s
   * own `behaviors` parameter, or `@zanix/core`'s `apps.<name>.behaviors`), otherwise to this
   * app's own `behaviors.<name>.default` — same "override, else default" precedence `config.get`
   * already follows for the Config Plane overlay. `undefined` if neither exists (an unknown name,
   * or an app never activated). Delegates to `resolveBehavior(appName, name)` internally — see
   * that function's own doc for why `T` is manually specified, not inferred, and adds no more
   * soundness than an `as T` cast.
   * @param name Must exist in this app's own `behaviors` to resolve to anything but `undefined`. */
  behavior<T = unknown>(name: string): T | undefined
}

/**
 * The only object an app's code can touch inside `setup(ctx)`. No low-level method
 * (`ApplicationContainer`/`RouteContainer`/`TargetContainer`) is reachable from here, neither
 * directly nor wrapped.
 */
export interface AppSetupContext extends RuntimeContext {
  /** Runs `register` (normal decorators, or an explicit `defineRoute`) inside the scope this
   * app's composition already opened — never exposes `RouteContainer` or any low-level method.
   * @param register Normal author code — `@Controller`/`@Get`/etc. decorators. */
  routes(register: () => void): void
  /** Sugar over the same global DI the rest of the framework already uses.
   * @param Target A decorated class (`@Interactor`/`@Provider`/`@Connector`) to resolve. */
  resolve<T>(Target: new (...args: never[]) => T): T
}

/** Same shape as {@link RuntimeContext} without `routes()`/`resolve()` — composition has
 * already finished by the time `onStart` runs. */
export type AppStartContext = RuntimeContext

/** Same shape as {@link AppStartContext} — resources stay open during `onStop`, closed only
 * after every app's `onStop` has finished. */
export type AppStopContext = RuntimeContext
