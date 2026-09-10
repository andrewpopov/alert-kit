import { AlertDeliveryError, type AlertTransport, type AttemptedRouteOutcome, type Severity } from './types';
/** A child transport, optionally given a stable label for logs/receipts. */
export interface FallbackTransportEntry {
    transport: AlertTransport;
    /**
     * Stable, non-secret label for this route (e.g. `'dm'`, `'webhook'`),
     * surfaced in the winning receipt's `route`, in `attemptedRoutes`, and in
     * `onDegraded`. Defaults to the entry's position in the `transports`
     * array (as a string) when omitted.
     */
    label?: string;
}
/**
 * A fallback child is either a bare transport (labeled by its index) or an
 * entry naming it explicitly. Colocating the label with its transport
 * — rather than a second, parallel array of labels — means reordering or
 * editing the list can't silently desync a transport from the wrong label.
 */
export type FallbackTransportChild = AlertTransport | FallbackTransportEntry;
/** Sanitized, non-secret summary of one delivery attempt through `createFallbackTransport`. */
export interface DegradedInfo {
    severity: Severity;
    title: string;
    /** Label of the route that ultimately delivered, or `undefined` if every configured route failed. */
    wonBy?: string;
    /** Every route skipped or attempted before `wonBy` (or, on total failure, every route that was attempted or skipped). */
    attemptedRoutes: AttemptedRouteOutcome[];
}
export interface FallbackTransportOptions {
    /**
     * Called whenever a delivery attempt did not succeed via the first
     * configured child — i.e. some earlier child was skipped as unconfigured
     * for this alert's severity, or was attempted and failed — including the
     * case where every configured child ultimately failed. Receives only
     * sanitized, non-secret data (see `DegradedInfo`).
     *
     * What IS guaranteed: a throw — whether synchronous, or an `async`
     * observer's rejection — is contained (caught, logged as a fixed
     * diagnostic that never includes the exception's own text), never
     * triggers a second delivery attempt, and never masks a delivery that
     * actually succeeded. What is NOT guaranteed: a *synchronous* observer
     * that blocks (e.g. a tight loop, a synchronous I/O call) still blocks
     * delivery completion — there is nothing that can contain that — so
     * observers must not do blocking work.
     */
    onDegraded?: (info: DegradedInfo) => void;
}
/**
 * Thrown when every configured child of a `createFallbackTransport` failed.
 * Carries the sanitized per-child outcomes so a terminal failure from one
 * route (e.g. a webhook rejected outright) can't conceal a retryable one
 * from another (e.g. a DM that only timed out) behind a single rethrown
 * error. `retryable` is true iff ANY attempted child's failure was itself
 * retryable.
 */
export declare class AggregateAlertDeliveryError extends AlertDeliveryError {
    readonly outcomes: AttemptedRouteOutcome[];
    constructor(outcomes: AttemptedRouteOutcome[], retryable: boolean, message: string);
}
/**
 * Compose transports into one: try each configured child, in order, and
 * stop at the first that delivers. Exists so a primary route with strictly
 * more failure modes (e.g. a Discord bot DM — closed DMs, no mutual guild,
 * token rotation) can fall back to a more reliable one (e.g. a webhook)
 * without the alert being silently dropped.
 *
 * `isConfigured(severity?)` is true iff ANY child is configured for that
 * severity — configuration means a route exists, not that it works, same
 * contract every other transport here follows.
 *
 * `attempts` on the returned receipt counts CHILD TRANSPORTS INVOKED during
 * this delivery (every failed attempt plus the one that finally succeeded),
 * never counting a child skipped as unconfigured. It deliberately does NOT
 * try to fold in a child's own internal attempt count (e.g. the DM
 * transport's channel-open + message-POST + 429-retry accounting) — those
 * are different quantities the composite can't observe for a `send`-only
 * child, and inventing a merged number would misrepresent both.
 */
export declare function createFallbackTransport(transports: FallbackTransportChild[], options?: FallbackTransportOptions): AlertTransport;
