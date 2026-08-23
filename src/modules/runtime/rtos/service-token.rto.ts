import { BaseRTO, IsString } from '@zanix/validator'

/**
 * Request body for `POST /__zanix-ops/{appName}/service-token` — see
 * `remote-dispatch-route.ts`'s `exchange`. Declaring this as the route's `Body` RTO (rather than
 * reading `ctx.payload.body.assertion` unvalidated) means a missing/malformed body fails with a
 * clean `400` before `exchangeServiceCredential` ever runs, instead of an unhandled `TypeError`
 * when the raw body couldn't be parsed at all (wrong/missing `Content-Type`, empty body, invalid
 * JSON) — the same validation contract `@zanix/admin`'s own `ServiceExchangeRTO` already
 * establishes for the equivalent `/admin/service-token` REST route.
 */
export class ServiceTokenExchangeRTO extends BaseRTO {
  @IsString({ expose: true })
  accessor assertion!: string
}
