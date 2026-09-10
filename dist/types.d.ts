export type Severity = 'info' | 'warn' | 'error' | 'critical';
export interface Alert {
    severity: Severity;
    title: string;
    message?: string;
    fields?: Record<string, string | number | boolean>;
    service?: string;
    timestamp?: Date;
}
/** Result of a best-effort alert. `sent: false` means no transport route was configured. */
export interface AlertResult {
    sent: boolean;
    receipt?: AlertDeliveryReceipt;
}
/** Stable, secret-safe result for durable workers and audit logs. */
export interface AlertDeliveryReceipt {
    destinationId?: string;
    attempts: number;
    /**
     * Which route actually delivered, set by a composite transport (e.g.
     * `createFallbackTransport`) to the winning child's label or index.
     * Absent for a single, non-composite transport.
     */
    route?: string;
    /**
     * Sanitized outcomes for every child a composite transport tried, or
     * explicitly skipped as unconfigured for this alert's severity, BEFORE
     * the one that ultimately delivered. Absent for a single, non-composite
     * transport, and never populated for the winning child itself (that
     * child is described by `route`/`destinationId` above instead).
     */
    attemptedRoutes?: AttemptedRouteOutcome[];
}
/**
 * One child transport's outcome within a composite transport's delivery
 * attempt. Deliberately narrow and typed rather than a free-form message —
 * never carries a child's raw error text, so it can't leak whatever that
 * child chose to put in `Error#message`.
 */
export interface AttemptedRouteOutcome {
    /** Stable, non-secret label (or index, if unlabeled) identifying the child transport. */
    label: string;
    /**
     * `'skipped'`: this child had no route configured for the alert's
     * severity, so it was never invoked. `'failed'`: it was invoked and threw.
     */
    outcome: 'skipped' | 'failed';
    /** Present only when `outcome` is `'failed'` and the child threw an `AlertDeliveryError`. */
    code?: AlertDeliveryFailureCode;
    /** Present only when `outcome` is `'failed'`; whether this failure could succeed on a retry. */
    retryable?: boolean;
    /** Present only when `outcome` is `'failed'` and the child's error carried one. Never a URL or token. */
    destinationId?: string;
}
export type AlertDeliveryFailureCode = 'UNCONFIGURED' | 'DESTINATION_REJECTED' | 'RATE_LIMITED' | 'TIMEOUT' | 'NETWORK' | 'SERVER_ERROR'
/** Every configured child of a composite transport (e.g. `createFallbackTransport`) failed. */
 | 'ALL_ROUTES_FAILED';
/** Never include a destination URL or provider token in this error. */
export declare class AlertDeliveryError extends Error {
    readonly code: AlertDeliveryFailureCode;
    readonly retryable: boolean;
    readonly destinationId?: string | undefined;
    readonly retryAfterMs?: number | undefined;
    readonly name = "AlertDeliveryError";
    constructor(code: AlertDeliveryFailureCode, retryable: boolean, destinationId?: string | undefined, retryAfterMs?: number | undefined, message?: string);
}
/**
 * A pluggable alert transport. `send` MUST throw when it cannot deliver
 * (including "no route configured for this alert") so strictness composes at
 * the `Alerter` layer — `isConfigured()` is what best-effort callers check.
 */
export interface AlertTransport {
    /**
     * Whether a delivery route exists. With no argument, true if ANY route
     * (primary or any severity-specific route) is configured. With a
     * `severity`, true iff that severity resolves to a route — so a
     * best-effort caller can skip a specific alert without throwing even when
     * other severities are configured.
     */
    isConfigured(severity?: Severity): boolean;
    send(alert: Alert): Promise<void>;
    deliver?(alert: Alert): Promise<AlertDeliveryReceipt>;
}
