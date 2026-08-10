/**
 * Barrel for the pure manifest/composition surface. Everything here is I/O-free and has zero
 * dependency on `@zanix/server` — `normalize`/`buildGraph`/`validate` are the pure halves of
 * `AppContainer`'s namespace; `resolveResources`/`registerApp`/`runOnStart`/`runOnStop` (the
 * halves that DO need `@zanix/server`) live in `@zanix/app/runtime` instead — see that module's
 * own doc.
 *
 * @module
 */
export {
  defineZanixApp,
  isZanixAppDefinition,
  type ServeHandle,
  type ServeOptions,
  ZANIX_APP_DEFINITION_BRAND,
  type ZanixAppDefinition,
} from './define.ts'
export { normalize } from './normalize.ts'
export { buildGraph } from './graph.ts'
export { validate } from './validate.ts'
