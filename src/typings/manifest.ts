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

/** Primitive type a `config` entry's value can hold. */
export type ConfigValueType = 'string' | 'number' | 'boolean'

/** Shape of one `resources`/`localResources`/`RootResources` entry — a concrete resource
 * declaration (type + construction options). Identical whether it lives on an app's own
 * manifest (`AppDefinition.resources`), its normalized form
 * (`NormalizedAppDefinition.localResources`), or the host's root (`RootResources`) — the same
 * data, never re-shaped between them. */
export interface ResourceDeclaration {
  /** Compared against `dependencies.<slot>.type` by `validate()`. */
  type: string
  /** Construction options, passed to whatever factory `type` resolves to. */
  options: Record<string, unknown>
}

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
  /** Events this app declares it emits/listens to — untyped payload for now. */
  events?: EventsDeclaration
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
  /** Same shape as `AppDefinition.events`, no additional normalization. */
  events: EventsDeclaration
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

/** A fully qualified key for a given `(appName, slot)`, already resolved against
 * `rootResources`/`localResources`/bindings — see `buildGraph()`. */
export interface ResolvedResourceKey {
  /** `'mongo'` (shared at the root) | `'reviews:mongo'` (local, a shadow). The real key
   * `ResourceRegistry.resolve()` receives. */
  qualifiedKey: string
  /** The resolved resource's type — compared against `dependencies.<slot>.type` by
   * `validate()`. */
  type: string
  /** Construction options of the resolved resource, exactly as declared in `resources`. */
  options: Record<string, unknown>
  /** `null` = shared at the root; `appName` = local to that app. */
  ownerApp: string | null
}

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
