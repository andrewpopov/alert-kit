import { describe, expect, it } from 'vitest';
import {
  initialSuppressionState,
  stepCheck,
  unsentAlertState,
  type SuppressionOptions,
  type SuppressionState,
} from '../suppression';

const NOW = 1_770_000_000_000;
const opts: SuppressionOptions = { failAfterRuns: 2, recoverAfterRuns: 2, reAlertAfterMinutes: 0, nowMs: NOW };

const alertedCrit = (over: Partial<SuppressionState> = {}): SuppressionState => ({
  notif: 'alerted',
  failStreak: 2,
  recoverStreak: 0,
  lastAlertAtMs: NOW,
  lastAlertedStatus: 'crit',
  ...over,
});

// ---------------------------------------------------------------------------
// Ported verbatim in intent from deploy-kit src/__tests__/monitor.test.ts
// ("monitor state machine (stepCheck)"), so a behaviour drift between the two
// implementations shows up as a failing case here, not as a production surprise.
// ---------------------------------------------------------------------------
describe('stepCheck (ported deploy-kit transition matrix)', () => {
  it('debounces: no alert until failAfterRuns consecutive non-ok', () => {
    const s1 = stepCheck(undefined, { id: 'x', status: 'crit', message: 'down' }, opts);
    expect(s1.alert).toBeUndefined();
    expect(s1.next.failStreak).toBe(1);
    const s2 = stepCheck(s1.next, { id: 'x', status: 'crit', message: 'down' }, opts);
    expect(s2.alert).toMatchObject({ kind: 'alert', status: 'crit' });
    expect(s2.next.notif).toBe('alerted');
  });

  it('unknown HOLDS and PRESERVES streaks (failure -> unknown -> failure still reaches the threshold)', () => {
    const s1 = stepCheck(undefined, { id: 'x', status: 'crit', message: 'd' }, opts);
    const u = stepCheck(s1.next, { id: 'x', status: 'unknown', message: '?' }, opts);
    expect(u.alert).toBeUndefined();
    expect(u.next.failStreak).toBe(1);
    expect(u.next.notif).toBe('healthy');
    const s2 = stepCheck(u.next, { id: 'x', status: 'crit', message: 'd' }, opts);
    expect(s2.alert).toMatchObject({ kind: 'alert' });
  });

  it('unknown does not recover an alerted check and carries the baseline forward', () => {
    const u = stepCheck(alertedCrit({ meta: { restart: 42 } }), { id: 'restart:app', status: 'unknown' }, opts);
    expect(u.next.notif).toBe('alerted');
    expect(u.next.meta).toEqual({ restart: 42 });
  });

  it('recovers only after recoverAfterRuns consecutive ok', () => {
    const r1 = stepCheck(alertedCrit(), { id: 'x', status: 'ok', message: 'up' }, opts);
    expect(r1.alert).toBeUndefined();
    const r2 = stepCheck(r1.next, { id: 'x', status: 'ok', message: 'up' }, opts);
    expect(r2.alert).toMatchObject({ kind: 'recovery' });
    expect(r2.next.notif).toBe('healthy');
  });

  it('escalates warn->crit immediately while alerted', () => {
    const e = stepCheck(alertedCrit({ failStreak: 3, lastAlertedStatus: 'warn' }), { id: 'x', status: 'crit' }, opts);
    expect(e.alert).toMatchObject({ kind: 'escalation', status: 'crit' });
  });

  it('re-alerts a still-failing check after reAlertAfterMinutes', () => {
    const o = { ...opts, reAlertAfterMinutes: 10, nowMs: NOW + 11 * 60_000 };
    const rem = stepCheck(alertedCrit({ failStreak: 5 }), { id: 'x', status: 'crit' }, o);
    expect(rem.alert).toMatchObject({ kind: 'reminder' });
  });

  it('does not remind before the interval elapses, and never when reminders are disabled', () => {
    const early = stepCheck(alertedCrit(), { id: 'x', status: 'crit' }, { ...opts, reAlertAfterMinutes: 10, nowMs: NOW + 9 * 60_000 });
    expect(early.alert).toBeUndefined();
    const off = stepCheck(alertedCrit(), { id: 'x', status: 'crit' }, { ...opts, reAlertAfterMinutes: 0, nowMs: NOW + 10 * 24 * 3_600_000 });
    expect(off.alert).toBeUndefined();
  });

  it('does not escalate crit->warn (an improving condition is not news)', () => {
    const d = stepCheck(alertedCrit(), { id: 'x', status: 'warn' }, opts);
    expect(d.alert).toBeUndefined();
    expect(d.next.notif).toBe('alerted');
  });

  it('failAfterRuns: 1 alerts on the first non-ok run', () => {
    const s = stepCheck(undefined, { id: 'x', status: 'crit' }, { ...opts, failAfterRuns: 1 });
    expect(s.alert).toMatchObject({ kind: 'alert' });
  });

  it('an ok run resets the fail streak, so intermittent failures never accumulate to an alert', () => {
    let state = initialSuppressionState();
    for (let i = 0; i < 6; i += 1) {
      const bad = stepCheck(state, { id: 'x', status: 'crit' }, opts);
      expect(bad.alert).toBeUndefined();
      state = stepCheck(bad.next, { id: 'x', status: 'ok' }, opts).next;
      expect(state.failStreak).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// The behaviour the ticket exists for.
// ---------------------------------------------------------------------------
describe('a sustained condition alerts once, then reminds on the interval', () => {
  it('reproduces the pitelite case: 28 six-hourly runs produce 1 alert + 6 daily reminders, not 28', () => {
    const SIX_HOURS = 6 * 3_600_000;
    const o = { failAfterRuns: 1, recoverAfterRuns: 1, reAlertAfterMinutes: 24 * 60 };
    let state: SuppressionState | undefined;
    const fired: string[] = [];

    for (let run = 0; run < 28; run += 1) {
      const step = stepCheck(state, { id: 'backup:rouge', status: 'crit', message: 'STALE' }, { ...o, nowMs: NOW + run * SIX_HOURS });
      state = step.next;
      if (step.alert) fired.push(step.alert.kind);
    }

    // Seven days of a live problem: one page, then one reminder a day.
    expect(fired).toEqual(['alert', 'reminder', 'reminder', 'reminder', 'reminder', 'reminder', 'reminder']);
    // Before this module, every one of the 28 runs notified.
    expect(fired.length).toBeLessThan(28);
  });

  it('emits exactly one recovery notice when the condition clears, and stays quiet after', () => {
    const o = { failAfterRuns: 1, recoverAfterRuns: 1, reAlertAfterMinutes: 0, nowMs: NOW };
    let state = stepCheck(undefined, { id: 'backup:rouge', status: 'crit' }, o).next;
    const recovery = stepCheck(state, { id: 'backup:rouge', status: 'ok', message: 'fresh' }, o);
    expect(recovery.alert).toMatchObject({ kind: 'recovery', status: 'ok' });
    state = recovery.next;
    for (let run = 0; run < 5; run += 1) {
      const quiet = stepCheck(state, { id: 'backup:rouge', status: 'ok' }, o);
      expect(quiet.alert).toBeUndefined();
      state = quiet.next;
    }
  });
});

// ---------------------------------------------------------------------------
// unsentAlertState: for callers whose sender cannot report failure upward.
// ---------------------------------------------------------------------------
describe('unsentAlertState', () => {
  const o = { failAfterRuns: 1, recoverAfterRuns: 1, reAlertAfterMinutes: 0, nowMs: NOW };

  it('an undelivered first alert fires again on the next run', () => {
    const step = stepCheck(undefined, { id: 'x', status: 'crit' }, o);
    expect(step.alert).toMatchObject({ kind: 'alert' });
    const persisted = unsentAlertState(undefined, step.next);
    expect(persisted.notif).toBe('healthy');
    const retry = stepCheck(persisted, { id: 'x', status: 'crit' }, o);
    expect(retry.alert).toMatchObject({ kind: 'alert' });
  });

  it('an undelivered reminder fires again rather than waiting another full interval', () => {
    const withReminders = { ...o, reAlertAfterMinutes: 60, nowMs: NOW + 61 * 60_000 };
    const prev = alertedCrit();
    const step = stepCheck(prev, { id: 'x', status: 'crit' }, withReminders);
    expect(step.alert).toMatchObject({ kind: 'reminder' });
    const persisted = unsentAlertState(prev, step.next);
    expect(persisted.lastAlertAtMs).toBe(prev.lastAlertAtMs);
    const retry = stepCheck(persisted, { id: 'x', status: 'crit' }, { ...withReminders, nowMs: NOW + 62 * 60_000 });
    expect(retry.alert).toMatchObject({ kind: 'reminder' });
  });

  it('an undelivered recovery fires again on the very next ok run, not after the full streak', () => {
    const twoToRecover = { ...o, recoverAfterRuns: 2 };
    const prev = alertedCrit({ recoverStreak: 1 });
    const step = stepCheck(prev, { id: 'x', status: 'ok' }, twoToRecover);
    expect(step.alert).toMatchObject({ kind: 'recovery' });
    const persisted = unsentAlertState(prev, step.next);
    expect(persisted.notif).toBe('alerted');
    const retry = stepCheck(persisted, { id: 'x', status: 'ok' }, twoToRecover);
    expect(retry.alert).toMatchObject({ kind: 'recovery' });
  });

  it('keeps the fail-streak progress, so rolling back does not restart the debounce', () => {
    const debounced = { ...o, failAfterRuns: 3 };
    let state: SuppressionState | undefined;
    for (let i = 0; i < 2; i += 1) state = stepCheck(state, { id: 'x', status: 'crit' }, debounced).next;
    const step = stepCheck(state, { id: 'x', status: 'crit' }, debounced);
    expect(step.alert).toMatchObject({ kind: 'alert' });
    const persisted = unsentAlertState(state, step.next);
    expect(persisted.failStreak).toBe(3);
    expect(stepCheck(persisted, { id: 'x', status: 'crit' }, debounced).alert).toMatchObject({ kind: 'alert' });
  });

  it('preserves the carried meta baseline', () => {
    const prev = alertedCrit({ meta: { restart: 7 } });
    const step = stepCheck(prev, { id: 'x', status: 'crit' }, { ...o, reAlertAfterMinutes: 1, nowMs: NOW + 120_000 });
    expect(unsentAlertState(prev, step.next).meta).toEqual({ restart: 7 });
  });
});
