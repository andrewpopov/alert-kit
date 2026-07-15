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
}
export type AlertDeliveryFailureCode = 'UNCONFIGURED' | 'DESTINATION_REJECTED' | 'RATE_LIMITED' | 'TIMEOUT' | 'NETWORK' | 'SERVER_ERROR';
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
