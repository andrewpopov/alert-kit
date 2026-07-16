/**
 * Bridge for deploy-kit's monitor events.
 *
 * deploy-kit's monitor delivers a BATCHED event as JSON on stdin to a
 * host-configured command:
 *
 *   { eventId, createdAtMs, host, alerts: [{ id, kind, status, message }] }
 *
 * where `status` is `ok | warn | crit` and `kind` is
 * `alert | escalation | reminder | recovery`. This is a FOREIGN wire
 * contract owned by deploy-kit, not alert-kit — the types below describe
 * what deploy-kit sends today, not an alert-kit concept. If deploy-kit's
 * shape changes, these types (and `parseDeployMonitorEvent`'s validation)
 * are what need to move.
 */
import type { Alert, Severity } from './types';
export type DeployMonitorStatus = 'ok' | 'warn' | 'crit';
export type DeployMonitorKind = 'alert' | 'escalation' | 'reminder' | 'recovery';
/** One alert within a batched deploy-kit monitor event. */
export interface DeployMonitorAlert {
    id: string;
    kind: DeployMonitorKind;
    status: DeployMonitorStatus;
    message: string;
}
/** A batched event as delivered on stdin by deploy-kit's monitor. */
export interface DeployMonitorEvent {
    eventId: string;
    createdAtMs: number;
    host: string;
    alerts: DeployMonitorAlert[];
}
/**
 * Map a deploy-kit `(status, kind)` pair to an alert-kit `Severity`.
 *
 * Mapping table:
 *   - status 'crit'                    -> 'critical'
 *   - status 'warn'                    -> 'warn'
 *   - status 'ok', kind 'recovery'     -> 'info'
 *   - status 'ok', any other kind      -> 'info'
 *   - anything else (unknown status)   -> 'critical' (fail closed)
 *
 * An unknown/unexpected `status` value never resolves to a quiet severity —
 * it fails closed to 'critical' so it cannot be silently dropped or
 * under-alerted. The raw value is preserved by the caller (see
 * `alertsFromDeployEvent`), which folds it into the alert's message.
 */
export declare function severityFromDeployStatus(status: DeployMonitorStatus, kind: DeployMonitorKind): Severity;
/** Map a batched deploy-kit monitor event to one `Alert` per contained alert. */
export declare function alertsFromDeployEvent(event: DeployMonitorEvent): Alert[];
export type ParseDeployMonitorEventResult = {
    ok: true;
    event: DeployMonitorEvent;
} | {
    ok: false;
    error: string;
};
/**
 * Strictly parse and validate a deploy-kit monitor event from a raw JSON
 * string (as read from stdin). Never throws on malformed input — returns a
 * discriminated result instead, so a sink script can log and exit
 * gracefully rather than crash on a bad payload.
 *
 * Note: `status` is validated only as a string here, not restricted to the
 * known enum — an unrecognized status is a valid *parse*, and is handled by
 * `severityFromDeployStatus`'s fail-closed mapping, not rejected at parse
 * time. This matches deploy-kit potentially adding new status values before
 * alert-kit knows about them.
 */
export declare function parseDeployMonitorEvent(json: string): ParseDeployMonitorEventResult;
