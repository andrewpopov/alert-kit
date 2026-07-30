"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.initialSuppressionState = initialSuppressionState;
exports.stepCheck = stepCheck;
exports.unsentAlertState = unsentAlertState;
/** The state of a check that has never been seen before. */
function initialSuppressionState() {
    return { notif: 'healthy', failStreak: 0, recoverStreak: 0, lastAlertAtMs: 0, lastAlertedStatus: null };
}
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
function stepCheck(prev, result, opts) {
    const { failAfterRuns, recoverAfterRuns, reAlertAfterMinutes, nowMs } = opts;
    const s = prev || initialSuppressionState();
    const st = result.status;
    const base = {
        notif: s.notif,
        failStreak: s.failStreak,
        recoverStreak: s.recoverStreak,
        lastAlertAtMs: s.lastAlertAtMs,
        lastAlertedStatus: s.lastAlertedStatus,
    };
    // Carry the persisted meta (e.g. restart baseline) forward; a check that produced
    // fresh meta this run overrides it. A transient unknown must NOT erase the baseline.
    base.meta = result.meta && result.meta[result.id] !== undefined ? result.meta[result.id] : s.meta;
    if (st === 'unknown') {
        return { next: base };
    }
    if (st === 'ok') {
        const recoverStreak = s.recoverStreak + 1;
        if (s.notif === 'alerted' && recoverStreak >= recoverAfterRuns) {
            return {
                next: { ...base, notif: 'healthy', failStreak: 0, recoverStreak: 0, lastAlertedStatus: null },
                alert: { id: result.id, kind: 'recovery', status: 'ok', message: result.message },
            };
        }
        return { next: { ...base, failStreak: 0, recoverStreak } };
    }
    // warn | crit
    const failStreak = s.failStreak + 1;
    if (s.notif === 'healthy') {
        if (failStreak >= failAfterRuns) {
            return {
                next: { ...base, notif: 'alerted', failStreak, recoverStreak: 0, lastAlertAtMs: nowMs, lastAlertedStatus: st },
                alert: { id: result.id, kind: 'alert', status: st, message: result.message },
            };
        }
        return { next: { ...base, failStreak, recoverStreak: 0 } };
    }
    // already alerted: escalate warn→crit, or re-alert after the interval
    if (s.lastAlertedStatus === 'warn' && st === 'crit') {
        return {
            next: { ...base, failStreak, recoverStreak: 0, lastAlertAtMs: nowMs, lastAlertedStatus: 'crit' },
            alert: { id: result.id, kind: 'escalation', status: 'crit', message: result.message },
        };
    }
    if (reAlertAfterMinutes > 0 && nowMs - s.lastAlertAtMs >= reAlertAfterMinutes * 60000) {
        return {
            next: { ...base, failStreak, recoverStreak: 0, lastAlertAtMs: nowMs, lastAlertedStatus: st },
            alert: { id: result.id, kind: 'reminder', status: st, message: result.message },
        };
    }
    return { next: { ...base, failStreak, recoverStreak: 0 } };
}
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
function unsentAlertState(prev, next) {
    const p = prev || initialSuppressionState();
    const rolledBack = {
        ...next,
        notif: p.notif,
        lastAlertAtMs: p.lastAlertAtMs,
        lastAlertedStatus: p.lastAlertedStatus,
    };
    // The recovery transition zeroes recoverStreak. Without restoring the progress
    // that reached the threshold, an undelivered recovery notice would demand the
    // whole streak over again — so a flapping-then-healthy service would look like
    // it never came back.
    if (p.notif === 'alerted' && next.notif === 'healthy') {
        rolledBack.recoverStreak = p.recoverStreak + 1;
    }
    return rolledBack;
}
