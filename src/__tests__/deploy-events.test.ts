import { describe, it, expect } from 'vitest';
import {
  severityFromDeployStatus,
  alertsFromDeployEvent,
  parseDeployMonitorEvent,
  type DeployMonitorEvent,
  type DeployMonitorKind,
  type DeployMonitorStatus,
} from '../deploy-events';

const KINDS: DeployMonitorKind[] = ['alert', 'escalation', 'reminder', 'recovery'];

describe('severityFromDeployStatus', () => {
  const table: Array<[DeployMonitorStatus, DeployMonitorKind, string]> = [
    ['crit', 'alert', 'critical'],
    ['crit', 'escalation', 'critical'],
    ['crit', 'reminder', 'critical'],
    ['crit', 'recovery', 'critical'],
    ['warn', 'alert', 'warn'],
    ['warn', 'escalation', 'warn'],
    ['warn', 'reminder', 'warn'],
    ['warn', 'recovery', 'warn'],
    ['ok', 'alert', 'info'],
    ['ok', 'escalation', 'info'],
    ['ok', 'reminder', 'info'],
    ['ok', 'recovery', 'info'],
  ];

  it.each(table)('status=%s kind=%s -> %s', (status, kind, expected) => {
    expect(severityFromDeployStatus(status, kind)).toBe(expected);
  });

  it('covers every status x kind combination', () => {
    const statuses: DeployMonitorStatus[] = ['ok', 'warn', 'crit'];
    expect(table.length).toBe(statuses.length * KINDS.length);
  });

  it('fails closed to critical for an unknown status', () => {
    // @ts-expect-error deliberately passing an out-of-contract status
    expect(severityFromDeployStatus('unknown-status', 'alert')).toBe('critical');
  });
});

function fixtureEvent(overrides: Partial<DeployMonitorEvent> = {}): DeployMonitorEvent {
  return {
    eventId: 'evt-123',
    createdAtMs: 1_700_000_000_000,
    host: 'web-01.prod',
    alerts: [
      { id: 'alert-1', kind: 'alert', status: 'crit', message: 'disk at 97%' },
      { id: 'alert-2', kind: 'recovery', status: 'ok', message: 'disk back to normal' },
    ],
    ...overrides,
  };
}

describe('alertsFromDeployEvent', () => {
  it('maps a batched multi-alert event to multiple Alerts', () => {
    const event = fixtureEvent();
    const alerts = alertsFromDeployEvent(event);
    expect(alerts).toHaveLength(2);
    expect(alerts[0].severity).toBe('critical');
    expect(alerts[0].title).toContain('web-01.prod');
    expect(alerts[0].message).toContain('disk at 97%');
    expect(alerts[0].message).toContain('alert-1');
    expect(alerts[0].message).toContain('evt-123');
    expect(alerts[0].fields).toMatchObject({
      eventId: 'evt-123',
      host: 'web-01.prod',
      createdAtMs: 1_700_000_000_000,
      alertId: 'alert-1',
      kind: 'alert',
      status: 'crit',
    });

    expect(alerts[1].severity).toBe('info');
    expect(alerts[1].fields).toMatchObject({ kind: 'recovery', status: 'ok' });
  });

  it('folds an unknown status into the message and still fails closed to critical', () => {
    const event = fixtureEvent({
      alerts: [{ id: 'alert-9', kind: 'alert', status: 'weird' as never, message: 'huh' }],
    });
    const [alert] = alertsFromDeployEvent(event);
    expect(alert.severity).toBe('critical');
    expect(alert.message).toContain('unknownStatus');
    expect(alert.message).toContain('weird');
  });

  it('maps an empty alerts array to an empty Alert list', () => {
    expect(alertsFromDeployEvent(fixtureEvent({ alerts: [] }))).toEqual([]);
  });
});

describe('parseDeployMonitorEvent', () => {
  it('round-trips a realistic deploy-kit event fixture', () => {
    const raw = JSON.stringify({
      eventId: 'evt-abc',
      createdAtMs: 1_700_000_000_123,
      host: 'api-02.prod',
      alerts: [
        { id: 'a1', kind: 'escalation', status: 'crit', message: 'service down' },
        { id: 'a2', kind: 'reminder', status: 'warn', message: 'still degraded' },
      ],
    });

    const result = parseDeployMonitorEvent(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.eventId).toBe('evt-abc');
    expect(result.event.alerts).toHaveLength(2);

    const alerts = alertsFromDeployEvent(result.event);
    expect(alerts.map((a) => a.severity)).toEqual(['critical', 'warn']);
  });

  it('rejects malformed JSON without throwing', () => {
    const result = parseDeployMonitorEvent('{not json');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('invalid JSON');
  });

  it('rejects a JSON value that is not an object', () => {
    const result = parseDeployMonitorEvent('[1,2,3]');
    expect(result.ok).toBe(false);
  });

  it('rejects a missing eventId', () => {
    const result = parseDeployMonitorEvent(JSON.stringify({ createdAtMs: 1, host: 'h', alerts: [] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('eventId');
  });

  it('rejects a non-numeric createdAtMs', () => {
    const result = parseDeployMonitorEvent(
      JSON.stringify({ eventId: 'e', createdAtMs: 'nope', host: 'h', alerts: [] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('createdAtMs');
  });

  it('rejects a non-finite createdAtMs (JSON 1e400 parses to Infinity)', () => {
    const result = parseDeployMonitorEvent('{"eventId":"e","createdAtMs":1e400,"host":"h","alerts":[]}');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('createdAtMs');
  });

  it('rejects a non-array alerts field', () => {
    const result = parseDeployMonitorEvent(JSON.stringify({ eventId: 'e', createdAtMs: 1, host: 'h', alerts: {} }));
    expect(result.ok).toBe(false);
  });

  it('rejects an alert with an invalid kind', () => {
    const result = parseDeployMonitorEvent(
      JSON.stringify({
        eventId: 'e',
        createdAtMs: 1,
        host: 'h',
        alerts: [{ id: 'a1', kind: 'not-a-kind', status: 'crit', message: 'm' }],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('kind');
  });

  it('rejects an alert missing a message', () => {
    const result = parseDeployMonitorEvent(
      JSON.stringify({
        eventId: 'e',
        createdAtMs: 1,
        host: 'h',
        alerts: [{ id: 'a1', kind: 'alert', status: 'crit' }],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('message');
  });

  it('accepts an alert with an unrecognized status string (validated later by the severity mapper)', () => {
    const result = parseDeployMonitorEvent(
      JSON.stringify({
        eventId: 'e',
        createdAtMs: 1,
        host: 'h',
        alerts: [{ id: 'a1', kind: 'alert', status: 'mystery', message: 'm' }],
      }),
    );
    expect(result.ok).toBe(true);
  });
});
