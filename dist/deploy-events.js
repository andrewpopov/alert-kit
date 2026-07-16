"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.severityFromDeployStatus = severityFromDeployStatus;
exports.alertsFromDeployEvent = alertsFromDeployEvent;
exports.parseDeployMonitorEvent = parseDeployMonitorEvent;
const DEPLOY_MONITOR_STATUSES = ['ok', 'warn', 'crit'];
const DEPLOY_MONITOR_KINDS = ['alert', 'escalation', 'reminder', 'recovery'];
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
function severityFromDeployStatus(status, kind) {
    if (!DEPLOY_MONITOR_STATUSES.includes(status)) {
        return 'critical';
    }
    if (status === 'crit')
        return 'critical';
    if (status === 'warn')
        return 'warn';
    // status === 'ok'
    void kind; // 'ok' maps to 'info' regardless of kind, including 'recovery'.
    return 'info';
}
function titleFor(alert, host) {
    return `${alert.kind} on ${host}`;
}
/**
 * Map a single deploy-kit monitor alert to an alert-kit `Alert`, carrying
 * the parent event's `eventId`/`host`/`createdAtMs` through in `fields` (the
 * structured metadata slot `Alert` already supports).
 */
function alertFromDeployAlert(event, alert) {
    const knownStatus = DEPLOY_MONITOR_STATUSES.includes(alert.status);
    const severity = severityFromDeployStatus(alert.status, alert.kind);
    const message = knownStatus
        ? `${alert.message} (alertId=${alert.id}, eventId=${event.eventId})`
        : `${alert.message} (alertId=${alert.id}, eventId=${event.eventId}, unknownStatus=${JSON.stringify(alert.status)})`;
    return {
        severity,
        title: titleFor(alert, event.host),
        message,
        service: 'deploy-kit',
        fields: {
            eventId: event.eventId,
            host: event.host,
            createdAtMs: event.createdAtMs,
            alertId: alert.id,
            kind: alert.kind,
            status: String(alert.status),
        },
    };
}
/** Map a batched deploy-kit monitor event to one `Alert` per contained alert. */
function alertsFromDeployEvent(event) {
    return event.alerts.map((alert) => alertFromDeployAlert(event, alert));
}
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function validateAlert(value, index) {
    if (!isPlainObject(value))
        return `alerts[${index}] is not an object`;
    if (typeof value.id !== 'string')
        return `alerts[${index}].id must be a string`;
    if (typeof value.kind !== 'string' || !DEPLOY_MONITOR_KINDS.includes(value.kind)) {
        return `alerts[${index}].kind must be one of ${DEPLOY_MONITOR_KINDS.join(', ')}`;
    }
    if (typeof value.status !== 'string')
        return `alerts[${index}].status must be a string`;
    if (typeof value.message !== 'string')
        return `alerts[${index}].message must be a string`;
    return null;
}
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
function parseDeployMonitorEvent(json) {
    let raw;
    try {
        raw = JSON.parse(json);
    }
    catch (err) {
        return { ok: false, error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!isPlainObject(raw))
        return { ok: false, error: 'event must be a JSON object' };
    if (typeof raw.eventId !== 'string')
        return { ok: false, error: 'eventId must be a string' };
    if (typeof raw.createdAtMs !== 'number' || !Number.isFinite(raw.createdAtMs)) {
        return { ok: false, error: 'createdAtMs must be a finite number' };
    }
    if (typeof raw.host !== 'string')
        return { ok: false, error: 'host must be a string' };
    if (!Array.isArray(raw.alerts))
        return { ok: false, error: 'alerts must be an array' };
    for (let i = 0; i < raw.alerts.length; i++) {
        const err = validateAlert(raw.alerts[i], i);
        if (err)
            return { ok: false, error: err };
    }
    return {
        ok: true,
        event: {
            eventId: raw.eventId,
            createdAtMs: raw.createdAtMs,
            host: raw.host,
            alerts: raw.alerts,
        },
    };
}
