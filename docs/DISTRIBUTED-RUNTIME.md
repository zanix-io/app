# Distributed runtime (`./runtime`)

Cross-process features for a Zanix App running as its own distributed instance — remote app
discovery, app-to-app calling, distributed lifecycle/leader election, and routing PUBLIC traffic to
a remote app. Assumes you're already familiar with the main [README](../README.md)'s local,
single-process composition model (`defineZanixApp()`, `AppContainer`, `ResourceRegistry`).

## Table of Contents

1. [Control Plane](#control-plane-runtime)
2. [`ctx.remote()` — Remote App Protocol](#ctxremote--remote-app-protocol-runtime)
3. [Distributed lifecycle](#distributed-lifecycle-runtime)
4. [Leader election & replicas](#leader-election--replicas-runtime)
5. [Gateway](#gateway-runtime)
6. [Remote Resource Binding](#remote-resource-binding-runtime)

## Control Plane (`./runtime`)

Redis-backed remote app discovery (`ControlPlaneRegistry`) and hot-refresh, non-secret config
(`ControlPlaneConfig`) — the two standalone primitives a distributed Zanix App's Control Plane
builds on. Both take an already-constructed `ZanixCacheConnector<'redis'>` (from
`@zanix/datamaster`'s `ZanixRedisConnector`); neither constructs its own connection.

```ts
import { ZanixRedisConnector } from '@zanix/datamaster'
import { ControlPlaneConfig, ControlPlaneRegistry } from '@zanix/app/runtime'

const connector = new ZanixRedisConnector()
const registry = new ControlPlaneRegistry(connector)
const config = new ControlPlaneConfig(connector)

// One Redis key per REPLICA, each with its own TTL — a live instance calls this again, with the
// same appName/instanceId, before leaseTtlSeconds elapses. There is no separate renew() call.
await registry.registerInstance('reviews', 'instance-a', {
  prefix: '/reviews',
  endpoint: 'http://reviews-a.internal:8080',
}, { leaseTtlSeconds: 30 })

// Aggregates every currently-live replica of 'reviews' into one target. undefined = no live
// replica right now, never an error.
await registry.getDeploymentTarget('reviews')
// => { mode: 'remote', prefix: '/reviews', endpoints: ['http://reviews-a.internal:8080'] }

await registry.deregisterInstance('reviews', 'instance-a') // graceful shutdown, best-effort

// Config Plane — non-secret config only. A `config.<key>.secret: true` manifest entry must never
// go through this path (see the class's own doc for why).
await config.setConfig('reviews', 'pageSize', 25) // writes + publishes to every subscriber
await config.getConfig('reviews', 'pageSize') // 25 — a cold read, e.g. at startup

const subscription = await config.subscribeConfig(
  'reviews',
  ['pageSize'],
  (key, value) => {
    // hot-refresh: called again every time 'reviews'.'pageSize' changes, no polling
  },
)
await subscription.close() // stops listening, releases the dedicated Pub/Sub connection
```

Both classes are also usable standalone, independent of the higher-level wiring described further
down: `activateApps`'s `remoteInstances` parameter calls `registerInstance`/`deregisterInstance`
automatically on start/stop (see "Distributed lifecycle"), and the Gateway reads
`getDeploymentTarget` to route a real request (see "Gateway").

## `ctx.remote()` — Remote App Protocol (`./runtime`)

The one surface a Zanix App uses to call ANOTHER Zanix App — same call whether the target is active
in this same process (zero network, zero serialization) or running elsewhere (real HTTP). Available
on `ctx` in `setup`/`onStart`/`onStop`, and inside any `operations` handler itself.

```ts
// reviews' own manifest:
defineZanixApp({
  name: 'reviews',
  operations: {
    // Called locally OR remotely — this handler never knows which. `payload` is already
    // deserialized either way; `ctx` is THIS app's own {resource, config, remote}.
    createReview: async (payload, ctx) => {
      const db = ctx.resource('database')
      return { id: 'r1', ...payload }
    },
  },
})

// from a DIFFERENT app's onStart/setup/operation:
const result = await ctx.remote('reviews').call('createReview', {
  text: 'great!',
}, {
  timeoutMs: 2000, // mandatory — no silent default; a real network call has a real latency cost
})
```

Resolution order, per call:

1. **Local-first**: is `reviews` active in THIS process (its `operations` registered via
   `registerApp`)? Call the handler directly — no Control Plane, no Redis, no network.
2. **Remote fallback**: only if step 1 finds nothing, delegate to a `HttpRemoteDispatcher` —
   `HttpRemoteAdapter` in v1.

The idiomatic way to enable step 2 is a single side-effect import — no manual wiring:

```ts
import '@zanix/app/core' // that's it — registers the 'controlPlane' core-provider slot

await activateApps([billing.definition]) // no 4th argument needed
// activateApps() auto-detects the slot above and uses it as the dispatcher; billing's
// onStart/setup/operations can now reach any OTHER app that a live ControlPlaneRegistry
// resolves to. Never imported `@zanix/app/core`? ctx.remote() stays local-only, at zero cost.
```

`ZanixControlPlaneProvider` (the class registered under `'controlPlane'`) reuses `this.cache.redis`
— the SAME Redis connector any other part of the process already shares via the core `'cache'`
provider (`@zanix/datamaster/core`) — never a second, redundant connection. Reach it directly from
any `@Interactor`/`@Provider`/`@Connector` via `this.providers.get('controlPlane')` when you need
`.controlPlaneRegistry`/`.controlPlaneConfig` outside of `ctx.remote()` itself (e.g. a health-check
job enumerating live instances).

For tests, or a process that wants to build its own `ZanixRedisConnector` explicitly instead of
going through `this.cache`, pass a `dispatcher` to `activateApps` directly — this always takes
priority over the auto-detected provider:

```ts
import { ControlPlaneRegistry, HttpRemoteAdapter } from '@zanix/app/runtime'
import { ZanixRedisConnector } from '@zanix/datamaster'

const registry = new ControlPlaneRegistry(new ZanixRedisConnector())
const dispatcher = new HttpRemoteAdapter(registry)

await activateApps([billing.definition], {}, [], dispatcher)
```

`HttpRemoteAdapter` resolves the target's live endpoint via the Control Plane Registry,
authenticates with `@zanix/auth`'s existing service-to-service mechanism (`createServiceAuthClient`/
`exchangeServiceCredential` — the same one already in production for `ZanixAdminHub`, never a new
one), propagates a W3C `traceparent` header, and enforces `timeoutMs` via `AbortSignal.timeout()`.
Throws `InternalError` with `REMOTE_APP_UNREACHABLE` (no live instance), `REMOTE_CALL_TIMEOUT`, or
`REMOTE_CALL_FAILED` (any other transport/HTTP failure) — never a silent `undefined`.

A remotely-callable app is served under `/__zanix-ops/${appName}/...` (a fixed path, independent of
that app's own `routes`/mount prefix) — `POST /__zanix-ops/${appName}/service-token` (the auth
exchange endpoint) and `POST /__zanix-ops/${appName}/:operationName` (protected by
`@AuthTokenValidation({type: 'api'})`, the same decorator that already protects any other Zanix
endpoint). Registered automatically by `registerApp` whenever an app declares `operations` — a
no-op, zero routes added, for one that doesn't.

**Per-operation permission scoping (`allowedCallers`)** — capability-based, app-to-app
authorization, the first of four related tracks toward a fuller platform story (see
[Agent/MCP composability](./PLATFORM-FEATURES.md#agentmcp-composability-runtime),
[Multi-tenancy & resource quotas](./PLATFORM-FEATURES.md#multi-tenancy--resource-quotas-runtime),
and [Real sandboxing](./PLATFORM-FEATURES.md#real-sandboxing-runtime) in
[Platform features](./PLATFORM-FEATURES.md)). An operation can restrict WHICH Zanix Apps may invoke
it:

```ts
defineZanixApp({
  name: 'billing',
  operations: {
    // Bare function — unchanged, fully public, exactly today's behavior.
    listInvoices: async (payload, ctx) => ({ invoices: [] }),
    // Object form — only "reviews" (or a caller explicitly in the list) may invoke this.
    refundOrder: {
      handler: async (payload, ctx) => ({ refunded: true }),
      allowedCallers: ['reviews'], // '*' as a member, or omitting this field, means public
    },
  },
})
```

Checked against the CALLING app's own identity — `ctx.remote()`'s own `callerAppName` for a
same-process call, the exchanged service token's `sub` claim for a cross-process one — **never**
against a human/end-user identity (that's `@zanix/auth`'s own `@RequirePermissions`, on `routes`, a
separate concern). Enforced at all three dispatch points, deliberately:

- **Local-first** (`createRemoteCaller`'s in-process branch) — so two apps embedded in the SAME
  process can't bypass the ACL just by being co-located; the same restriction applies whether the
  caller happens to be local or genuinely remote.
- **Remote HTTP** (`remote-dispatch-route.ts`'s `dispatch()`) — checked right after
  `@AuthTokenValidation({type: 'api'})` validates the token itself (signature/issuer/expiry), using
  `session.subject` (the caller's own identity) as input. Denied with `HttpError('FORBIDDEN')` — a
  cross-process caller sees `REMOTE_CALL_FAILED`/HTTP 403 via `HttpRemoteAdapter`, same shape as any
  other transport failure.
- **Remote mTLS** (`mtls-dispatch-server.ts`'s `handleRequest()`) — checked right after the
  presented service token itself is verified, using its own `sub` claim. Denied with a `403`
  response, same as the HTTP path's `FORBIDDEN` — the mTLS transport is never a way to bypass an
  operation's `allowedCallers` just because it authenticates differently.

**Deliberately opt-in, not secure-by-default**: an operation declared as a bare function (or the
object form with `allowedCallers` omitted) stays exactly as callable as it always was — zero
existing apps break. Restricting an operation is something an author does on purpose, one operation
at a time.

**Honest limitation**: this is app-to-app authorization, resolved from the calling app's own
identity — it says nothing about which HUMAN/end-user triggered that call in the first place (that
chain of trust — an end-user session that caused reviews to call billing — isn't threaded through
`ctx.remote()` today). A future iteration could propagate an end-user's own scope alongside the
service token if that becomes a real requirement.

## Distributed lifecycle (`./runtime`)

`activateApps`'s 5th parameter, `remoteInstances`, is what actually makes an app's instance announce
itself to the Control Plane — run AFTER that app's own local `onStart` already completed:

```ts
import { activateApps, deactivateApps } from '@zanix/app/runtime'

const activated = await activateApps([reviews.definition], {}, [], undefined, {
  reviews: {
    endpoint: 'http://reviews-a.internal:8080/api',
    leaseTtlSeconds: 30,
  },
})
// 'reviews' is now: registered in the Control Plane Registry (HttpRemoteAdapter/ctx.remote()
// elsewhere can already reach it), renewing its own lease on a heartbeat (a third of
// leaseTtlSeconds by default — a live instance never lets its own lease expire on its own), and
// subscribed to hot-refresh updates for every NON-secret config key it declared.

await deactivateApps(activated)
// 'reviews' deregisters FIRST (best-effort) — a Gateway would stop routing to it — THEN its own
// onStop runs, THEN resources close. Symmetric with how it was announced.
```

Presence of an entry in `remoteInstances` for an app IS the host's decision to run it in `remote`
mode for THIS process — the manifest's own `runtime.mode` is only ever the author's default
suggestion, never enforced by itself. An app never listed in `remoteInstances` is never announced,
regardless of what its manifest declares.

**Config hot-refresh, real, not just designed**: a push via `ControlPlaneConfig.setConfig` reaches
every subscribed instance's `ctx.config.get(key)` immediately, no restart — verified end-to-end
against real Redis. Secret config (`config.<key>.secret: true`) is never subscribed here, even if
you pass a `configPlane` — secret config never flows over Pub/Sub, enforced by this function itself,
not left to caller discipline.

### mTLS — outgoing and incoming, both real

`HttpRemoteAdapter`'s constructor takes an optional second argument to present a client certificate
on every outgoing call:

```ts
import { HttpRemoteAdapter } from '@zanix/app/runtime'

const dispatcher = new HttpRemoteAdapter(registry, {
  cert: await Deno.readTextFile('./client.pem'),
  key: await Deno.readTextFile('./client.key'),
  caCerts: [await Deno.readTextFile('./ca.pem')], // only if the target's server cert isn't
  // signed by a CA Deno already trusts
})
// dispatcher.close() releases the underlying TLS connection pool when you're done with it.
```

The certificate covers the WHOLE round trip — both the service-token exchange and the operation call
itself, never just the second one.

Current stable Deno's own `Deno.serve()`/`Deno.listenTls()` still have no mechanism to REQUIRE or
VERIFY an incoming client certificate — that part of the platform gap is real and still open
([denoland/deno#26825](https://github.com/denoland/deno/issues/26825)), so an app's regular `routes`
still can't reject an uncertified caller at the TLS layer. But the `/__zanix-ops/...` dispatch
surface specifically doesn't have to go through `Deno.serve()` at all — a dedicated listener built
on Deno's `node:https` compatibility layer genuinely enforces the incoming half of mTLS
(`requestCert`/`rejectUnauthorized`, confirmed end-to-end: rejects a connection presenting no
certificate, accepts a valid one, exposes the peer certificate). Opt in per remote instance:

```ts
import { announceRemoteInstance } from '@zanix/app/runtime'

const announced = await announceRemoteInstance(
  reviews.definition,
  {
    endpoint: 'https://reviews-a.internal:8443',
    mtls: {
      port: 8443,
      cert: await Deno.readTextFile('./server.pem'),
      key: await Deno.readTextFile('./server.key'),
      ca: [await Deno.readTextFile('./ca.pem')], // a connecting client's own cert must chain here
    },
  },
  registry,
)
// announced.stop() closes the mTLS listener too, alongside the usual heartbeat/deregistration.
```

This is deliberately narrow — it's a second, separate listener serving ONLY
`/__zanix-ops/${appName}/...`, never a retrofit of `@zanix/server`'s own `webServerManager`/
`Deno.serve()`-based routing, which keeps working exactly as before regardless of whether `mtls` is
configured. Either way, the application-layer service-token exchange
(`@AuthTokenValidation({type: 'api'})`, see "`ctx.remote()`" above) still gates access independently
— mTLS adds transport-layer identity on top of it, never a replacement for it.

## Leader election & replicas (`./runtime`)

Exactly one replica runs a given scheduled job's tick, and a host can compare a manifest's own
`runtime.replicas` hint against what's actually observed.

**Scheduled jobs — automatic, nothing to opt into**: a `jobs.<name>` entry with a `schedule` is
already wrapped with Redis-backed leader election as part of `registerNamespacedJobs` (no manifest
change needed) — only the ONE replica currently holding `${appName}:${jobName}`'s lease actually
runs the handler on a given tick; every other replica's own delivery of that same tick is a no-op. A
replica keeps its lease by renewing it every tick; if it stops (crash, partition), any live
replica's next tick acquires it fresh, the moment the old lease's TTL lapses. Real, atomic
`SET NX EX` + a Lua compare-and-extend script (`LeaderElection`, via the SAME `getClient()` escape
hatch `ZanixKVConnector.withLock()`'s own doc already points to for distributed locks) — not
`@zanix/asyncmq`'s own internal `lockMessage` (a real mechanism too, but a non-atomic check-then-set
that only reduces, not eliminates, duplicate execution under real concurrent delivery).

**Fencing token — validate immediately before a side effect, not just at the start**:

```ts
import { isJobFencingTokenCurrent } from '@zanix/app/runtime'

jobs: {
  chargeInvoices: {
    schedule: '0 0 * * * *',
    processingQueue: 'soft',
    handler: async function (args) {
      // ... do the work ...
      if (!(await isJobFencingTokenCurrent('billing', 'chargeInvoices', this.context))) {
        return // a newer leadership term already started — this run is stale, skip the commit
      }
      // ... commit the side effect (charge the invoice) ...
    },
  },
}
```

This doesn't remove the double-DISPATCH window entirely (a real limit of any TTL-based lease under
arbitrary network partition, not specific to Redis or to this package) — but it does remove the
double-EFFECT, which is what actually matters. `getJobFencingToken(this.context)` reads the raw
token instead, if you need it for something other than the built-in comparison.

**`compareReplicas(def, registry)`** — a pure diagnostic, never enforcement (Zanix Distributed Apps
Runtime doesn't reimplement a cloud provider's scheduler):

```ts
import { compareReplicas } from '@zanix/app/runtime'

const { declared, observed, matches } = await compareReplicas(
  reviews.definition,
  registry,
)
// declared: reviews.definition's own runtime.replicas (null if never set)
// observed: how many live instances the Control Plane Registry reports right now
// matches:  true when there's nothing to compare, or declared === observed
```

Wire the result into whatever a host already uses for alerting — this function only produces the two
numbers.

**Redlock — upgrade path for `LeaderElection` itself**: pass an ARRAY of independent Redis
connectors instead of one, and every method switches to majority-quorum semantics automatically —
same public API, same `ctx`/manifest contract:

```ts
import { LeaderElection } from '@zanix/app/runtime'

// A single connector (the default) keeps single-instance behavior, unchanged. An array opts into
// Redlock — never point more than one of these at the SAME physical Redis; that buys no real
// fault tolerance, just repeats the same single point of failure under a different name.
const election = new LeaderElection([connectorA, connectorB, connectorC])
```

`tryAcquireOrRenew`/`getCurrentFencingToken`/`release` all tolerate a MINORITY of instances being
unreachable — an acquire or renewal succeeds once a majority (`floor(N/2) + 1`) agree, applying the
same clock-drift discount the original Redlock write-up specifies (the nominal TTL minus the round
trip minus a small drift allowance) before trusting a quorum acquire. Every per-instance operation
is itself bounded to a short timeout internally — without that, a single instance that's down (not
rejecting, just never responding) would make the WHOLE quorum check hang indefinitely, defeating the
entire point of tolerating a minority failing.

**Events — no new mechanism, on purpose**: `AppDefinition.events` stays a name-only declaration
(`{ orderCreated: {} }`) with no handler field and no dispatch layer of its own.
Publishing/subscribing is `@zanix/asyncmq`'s own job, directly — confirmed (by reading its actual
RabbitMQ-backed dispatch, not assumed) to already deliver competing-consumer, exactly-once-per-event
across replicas of the same service: every replica's subscriber opens `channel.consume()` against
the SAME, un-suffixed queue name, so standard AMQP semantics hand each message to exactly one of
them. Building a second dispatch layer on top would duplicate what the broker already guarantees.

## Gateway (`./runtime`)

Routes PUBLIC/external traffic to a `remote` app — the piece `ctx.remote()` (app-to-app calling)
deliberately never covered.

```ts
import { bootstrapAppServer, createGatewayPreHandler } from '@zanix/app/runtime'

const preHandler = createGatewayPreHandler(registry, {
  localAppNames: ['this-process-own-app'], // never shadowed, no matter what the Control Plane says
  defaultRemoteApp: 'storefront', // see "whole-domain" below
})

await bootstrapAppServer('this-process-own-app', {
  rest: { port: 8080, preHandler },
}, true)
```

Built on `preHandler` — a real `@zanix/server` extension point (the same one `@zanix/space`'s own
dev server already uses), tried before route matching on every request; returning `undefined` falls
through to this process's own routing, completely unchanged. A Gateway costs nothing beyond that
check on the overwhelming majority of requests that aren't a remote app's own traffic.

**Two resolution strategies, tried in order:**

1. **By name** — the request path's own first segment, looked up directly in the Control Plane
   Registry. Works when a remote app's OWN served routes put its `name` as the literal first path
   segment, with nothing else ahead of it (no REST server default `/api` prefix, no anchored server
   `id`) — `billing` reachable at `/billing/...`, not `/api/billing/...`.
2. **By default** (`defaultRemoteApp`) — tried only once (1) finds nothing. This is what a
   whole-domain app needs (`@zanix/space` with `routes: {prefix: ''}`): a page path like
   `/products/1` carries no segment identifying which app owns it at all, so (1) can never resolve
   it. Only one default makes sense behind a given Gateway — two whole-domain apps sharing an origin
   would collide over the same URL space regardless of what resolves them.

**Never shadows a locally-mounted app**: `localAppNames` is checked before either strategy — pass
the same app names this process itself activated (`defs.map(d => d.name)`, the same `defs` given to
`activateApps`).

**A genuine reverse proxy**: method/headers/body forwarded as-is (streamed, never buffered) to one
of the resolved target's live endpoints — round-robin per resolved app name (`RoundRobinPicker`, the
same mechanism `HttpRemoteAdapter.dispatch` already uses); an unreachable target responds `502`
directly, never throws.

## Remote Resource Binding (`./runtime`)

A `resources`/root-resource entry can point at a resource another Zanix App owns and exposes,
instead of constructing a real instance in THIS process:

```ts
const reviews = defineZanixApp({
  name: 'reviews',
  dependencies: { database: { type: 'mongo', required: true } },
  resources: {
    // Instead of { type: 'mongo', options: {...} }:
    database: { type: 'mongo', mode: 'remote', endpoint: 'billing' },
  },
})
```

**Deliberately NOT transparent** — a local `database` resolves to the real connector (Mongo's own
`.find()`/`.insertOne()`, etc.); a remote one resolves to a `RemoteAppHandle`, the exact same shape
`ctx.remote(endpoint)` already returns:

```ts
const db = ctx.resource('database') // RemoteAppHandle, not a Mongo connector
const result = await db.call('findAccount', { id: 42 }, { timeoutMs: 3000 })
```

This is a deliberate departure from the original design intent (the author was never meant to have
to distinguish between the two cases) — reaching real transparency would need either a hand-written
proxy class per resource type (reimplementing that type's whole method surface) or blanket
reflection-based forwarding, both rejected as new mechanisms this package would then have to own and
maintain. Reusing `ctx.remote()`'s own `{call(operationName, payload, options)}` contract as-is
costs nothing new: same local-first resolution (zero network if `endpoint` happens to be active in
this same process), same `HttpRemoteAdapter`/service-token/`traceparent` otherwise, same
`REMOTE_APP_NOT_CONFIGURED` error if neither applies. `type` is still checked against
`dependencies.<slot>.type` by `validate()` exactly as a local resource would be — nothing about
cross-app dependency validation changes because a slot resolved remote instead of local.

**`requiredVersion` — cross-app version validation**: an optional semver range (`@std/semver`
format) the endpoint app's own `version` must satisfy:

```ts
resources: {
  database: {
    type: 'mongo',
    mode: 'remote',
    endpoint: 'billing',
    requiredVersion: '^1.0.0', // "billing"'s own manifest version must satisfy this range
  },
}
```

Checked by `validate()` — but **only when it genuinely can be**: only if `endpoint` is ALSO part of
THIS SAME composition (present in the same `apps` list this `validate()` call covers) and it
declared a `version` of its own. Both are common for co-located/embedded composition, where
`validate()` already has everything it needs synchronously. An actually cross-process `remote`
target isn't checked at all — that would need an async Control Plane lookup, which `validate()`
(deliberately synchronous, fail-fast BEFORE anything is constructed) doesn't do; this is an honest,
documented limitation, not a hidden gap. Throws `REMOTE_RESOURCE_VERSION_MISMATCH` if checked and
unsatisfied, `INVALID_VERSION_RANGE` if either version string itself isn't valid semver.

## See also

- [Main README](../README.md) — local, single-process composition (`defineZanixApp()`,
  `AppContainer`, `ResourceRegistry`, `activateApps`/`deactivateApps`).
- [Platform features](./PLATFORM-FEATURES.md) — hot install/uninstall, agent/MCP composability,
  multi-tenancy & resource quotas, real sandboxing, and standalone remote deployment.
- [Concepts](./CONCEPTS.md) — what a Zanix App is, and how it relates to the rest of the Zanix
  ecosystem.
- [Publishing a Zanix App](./PUBLISHING.md) — distributing your own `defineZanixApp()` as a package.
