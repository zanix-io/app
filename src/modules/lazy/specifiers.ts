/**
 * The ONE place `@zanix/asyncmq`/`@zanix/datamaster`/`@zanix/auth`'s real, versioned `jsr:`
 * specifiers are written down for RUNTIME (VALUE-level) use — every lazy `import()` call site
 * elsewhere in this package (`register-jobs.ts`, `resource-types.ts`, `http-remote-adapter.ts`,
 * `remote-dispatch-route.ts`, `mtls-dispatch-server.ts`, `mcp-route.ts`) imports its own constant
 * from here instead of inlining the string, so a real version bump is a one-line change here, not
 * a hunt across six files.
 *
 * `typings/manifest.ts`'s own `Job`/`ProcessingQueues`/`JobProcess`/`CronJobDefinitionBase` are
 * real `import type`s from `@zanix/asyncmq`'s narrow `./jobs` subpath (registration-only, no
 * RabbitMQ connector, no `@zanix/database`) — see that module's own doc for the full reasoning.
 * `ASYNCMQ_SPECIFIER` below points at that same `./jobs` subpath, for the VALUE-level lazy import
 * (`register-jobs.ts`) — the two uses share the same target, resolved through two different
 * mechanisms: `typings/manifest.ts`'s is a real, unconditional, TYPE-level import (erased at build
 * time, but still resolved by `deno check`/`zanix space build`'s own graph walk, via
 * `deno.jsonc`'s own `@zanix/asyncmq/jobs` alias), while `register-jobs.ts`'s stays a lazy,
 * non-literal, GATED `import()` of this constant, only actually executed when an app declares at
 * least one job. This file's own `ASYNCMQ_SPECIFIER` can't be reused as `typings/manifest.ts`'s
 * own specifier (an `import`/`import type` specifier must be a string literal, ES module syntax
 * has no expression form there), so that's a second, independent literal by necessity, not a gap.
 *
 * These three packages are DELIBERATELY absent from `deno.jsonc`'s own top-level `imports` map —
 * see that file's own doc comment for the full reasoning: `nodeModulesDir: "auto"`'s npm-install
 * resolution materializes every package a `deno.json` DECLARES, regardless of whether reachable
 * code actually imports it, so a bare alias declared there is, on its own, enough to trigger it.
 * Each constant here is instead a fully-qualified specifier, resolved directly, with no import-map
 * indirection at all.
 *
 * Every `const specifier = SOME_CONSTANT` two-step at each call site (never `import(SOME_CONSTANT)`
 * inline) is itself deliberate, not incidental — see `register-jobs.ts`'s own doc for why a
 * non-literal `import()` argument matters independently of this file's own existence.
 */

/** @zanix/asyncmq's `./jobs` subpath (runtime, value-level use only — registration-only, no
 * RabbitMQ connector) — `typings/manifest.ts`'s own separate, TYPE-level import of the same
 * subpath (see this file's own doc) has its real specifier in `deno.jsonc`'s `imports` map
 * instead, not here. */
export const ASYNCMQ_SPECIFIER = 'jsr:@zanix/asyncmq@^0.8.0/jobs'

/** @zanix/datamaster */
export const DATAMASTER_SPECIFIER = 'jsr:@zanix/datamaster@^1.7.0'

/** @zanix/auth — floor pinned at `0.8.1`: the lowest version whose own internal `@zanix/server`
 * dependency matches this package's own `@zanix/server@^4.0.0`. A lower version pins
 * `@zanix/server@^3.0.0` internally, which resolves to a second, separate `ProgramModule`
 * singleton from this package's own — `AuthTokenValidation`'s guard registers into that other
 * instance and never actually runs against a real request. Matches `deno.jsonc`'s own
 * `./src/@tests/` scope, which pins the same floor for the same reason. */
export const AUTH_SPECIFIER = 'jsr:@zanix/auth@^0.8.1'
