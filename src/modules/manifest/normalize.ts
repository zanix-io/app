import type { AppDefinition, NormalizedAppDefinition } from 'typings/manifest.ts'
import { InternalError } from '@zanix/errors'

/**
 * `name` doubles as route namespace + resource-key prefix + job prefix — a character invalid in
 * one of those uses silently breaks the others, so the format is enforced once, here, rather than
 * per-use-site. Lowercase, starts with a letter, no `/`, no `..`, no spaces.
 */
const NAME_FORMAT = /^[a-z][a-z0-9-]*$/

/**
 * Canonicalizes an {@link AppDefinition} into a {@link NormalizedAppDefinition} — resolves every
 * shorthand (`routes: true`, a `config` entry missing `default`/`required`/`secret`, etc.) and
 * applies defaults (`rootDir: '.'`), so every step after this one reads a single, fully-resolved
 * shape and never re-parses the author's shorthand. Pure — no I/O, no `@zanix/server`.
 *
 * @throws {InternalError} if `name` doesn't match `^[a-z][a-z0-9-]*$` — this is the one check
 * `normalize` can make on its own, without any host/graph context (unlike cross-app collisions or
 * `uses`/`dependencies` contract checks, which need the full {@link DependencyGraph} and so wait
 * for `validate`).
 */
export function normalize(def: AppDefinition): NormalizedAppDefinition {
  if (!NAME_FORMAT.test(def.name)) {
    throw new InternalError(
      `Invalid Zanix App name "${def.name}" — must match ${NAME_FORMAT} (lowercase, starts ` +
        `with a letter, no "/", no "..", no spaces). It doubles as route namespace, resource-key ` +
        `prefix, and job prefix.`,
      { code: 'INVALID_APP_NAME', meta: { source: 'zanix', name: def.name } },
    )
  }

  const routesPrefix = def.routes === false
    ? null
    : def.routes === true || def.routes === undefined
    ? def.name
    : def.routes.prefix

  const dependencies: NormalizedAppDefinition['dependencies'] = {}
  for (const [slot, dep] of Object.entries(def.dependencies ?? {})) {
    dependencies[slot] = { type: dep.type, required: dep.required ?? false }
  }

  const config: NormalizedAppDefinition['config'] = {}
  for (const [key, entry] of Object.entries(def.config ?? {})) {
    if (entry.secret && entry.default !== undefined) {
      throw new InternalError(
        `Zanix App "${def.name}": config."${key}" is "secret: true" and also declares a literal ` +
          `"default" — a secret must come from a host override or env var, never hardcoded in ` +
          `the manifest.`,
        { code: 'SECRET_WITH_LITERAL_DEFAULT', meta: { source: 'zanix', name: def.name, key } },
      )
    }

    config[key] = {
      type: entry.type,
      default: entry.default ?? null,
      required: entry.required ?? false,
      secret: entry.secret ?? false,
    }
  }

  const jobs: NormalizedAppDefinition['jobs'] = {}
  for (const [jobName, job] of Object.entries(def.jobs ?? {})) {
    jobs[jobName] = { ...job, schedule: job.schedule ?? null, isActive: job.isActive ?? true }
  }

  return {
    name: def.name,
    version: def.version ?? null,
    routesPrefix,
    dependencies,
    config,
    jobs,
    events: def.events ?? {},
    localResources: def.resources ?? {},
    rootDir: def.rootDir ?? '.',
    package: def.package ?? null,
    setup: def.setup ?? null,
    onStart: def.onStart ?? null,
    onStop: def.onStop ?? null,
  }
}
