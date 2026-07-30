/**
 * Alert suppression: the per-check state machine that decides whether an
 * observed condition should actually page anyone.
 *
 * Every app in the fleet can already SEND an alert (that is the transport in
 * `alerter.ts`); until this module, only consumers routing through deploy-kit's
 * monitor could decide NOT to. The measured cost of that gap was an identical
 * "rouge backup STALE" alert posted every six hours for days — the condition was
 * real, the twenty-fifth notification was not information.
 *
 * This is a straight port of deploy-kit `monitor.js` `stepCheck`, signature
 * preserved so a conformance test can compare the two implementations function
 * to function rather than by re-reading intent. It is PURE: no clock, no I/O,
 * no transport. Callers own persistence, which is what lets a caller with an
 * outbox (deploy-kit) and a caller with a synchronous fire-and-forget sender
 * (db-backup's curl) share one decision function.
 */
/** Observed condition for one check on one run. `unknown` means the check could not run. */
export type SuppressionStatus = 'ok' | 'warn' | 'crit' | 'unknown';
/** Whether the caller has an outstanding, already-notified condition for this check. */
export type NotificationPhase = 'healthy' | 'alerted';
/** Why an alert is firing. `alert` is the first notification for a condition. */
export type SuppressionAlertKind = 'alert' | 'recovery' | 'escalation' | 'reminder';
/** One check's observation. `meta` carries per-check baselines (e.g. a restart counter), keyed by check id. */
export interface SuppressionCheckResult {
    id: string;
    status: SuppressionStatus;
    message?: string;
    meta?: Record<string, unknown>;
}
/**
 * The state a caller must persist between runs. Treat it as opaque: it is
 * JSON-serialisable, and the shape is deploy-kit's on-disk state so an existing
 * state file keeps working.
 */
export interface SuppressionState {
    notif: NotificationPhase;
    failStreak: number;
    recoverStreak: number;
    lastAlertAtMs: number;
    lastAlertedStatus: 'warn' | 'crit' | null;
    meta?: unknown;
}
export interface SuppressionOptions {
    /** Consecutive non-ok runs required before the first alert. 1 = alert immediately. */
    failAfterRuns: number;
    /** Consecutive ok runs required before a recovery notice. */
    recoverAfterRuns: number;
    /** Remind about a still-failing condition after this many minutes. 0 disables reminders. */
    reAlertAfterMinutes: number;
    /** Caller-supplied clock reading, so this function stays pure and testable. */
    nowMs: number;
}
export interface SuppressionAlert {
    id: string;
    kind: SuppressionAlertKind;
    status: Exclude<SuppressionStatus, 'unknown'>;
    message?: string;
}
export interface SuppressionStep {
    next: SuppressionState;
    alert?: SuppressionAlert;
}
/** The state of a check that has never been seen before. */
export declare function initialSuppressionState(): SuppressionState;
/**
 * Advance one check's state by one observation.
 *
 * `unknown` HOLDS: it neither recovers nor confirms a failure, and it PRESERVES
 * the fail/recover streaks, so an indeterminate run between two failures does
 * not lose progress toward the threshold. (deploy-kit's header comment claims
 * unknown clears the streaks; the code preserves them, and preserving is the
 * behaviour under test here and there.)
 *
 * Note for dead-man-switch callers: mapping "the check could not run" to
 * `unknown` means a permanently broken checker stays silent forever. If the
 * inability to check IS the bad news, map it to `crit` instead.
 */
export declare function stepCheck(prev: SuppressionState | undefined, result: SuppressionCheckResult, opts: SuppressionOptions): SuppressionStep;
/**
 * The state to persist when `stepCheck` produced an alert that was NOT delivered.
 *
 * A caller with an outbox persists the pending event before sending and so never
 * needs this. A caller whose sender is synchronous and best-effort — db-backup's
 * curl, which deliberately never throws and never changes the exit code — would
 * otherwise persist "I alerted" after a send that silently failed, and go quiet
 * about a live problem until the re-alert interval elapsed. That is a worse
 * failure than the spam this module exists to stop.
 *
 * Contract: persisting this state guarantees the SAME alert fires again on the
 * next run that observes the same status. It rolls the notification bookkeeping
 * back to `prev` while keeping the streak progress that earned the alert.
 */
export declare function unsentAlertState(prev: SuppressionState | undefined, next: SuppressionState): SuppressionState;
