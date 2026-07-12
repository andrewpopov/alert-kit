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
}
