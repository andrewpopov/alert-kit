import { describe, it, expect, vi } from 'vitest';
import { createAlerter } from '../alerter';
import type { Alert, AlertTransport } from '../types';

function fakeTransport(configured: boolean) {
  const sent: Alert[] = [];
  const transport: AlertTransport = {
    isConfigured: () => configured,
    send: vi.fn(async (a: Alert) => {
      sent.push(a);
    }),
  };
  return { transport, sent };
}

describe('createAlerter', () => {
  it('alert() throws when unconfigured', async () => {
    const { transport } = fakeTransport(false);
    const alerter = createAlerter(transport);
    await expect(alerter.alert({ severity: 'info', title: 't' })).rejects.toThrow('Alerting is not configured');
  });

  it('alert() delivers via the transport when configured', async () => {
    const { transport, sent } = fakeTransport(true);
    const alerter = createAlerter(transport);
    await alerter.alert({ severity: 'warn', title: 't' });
    expect(sent).toHaveLength(1);
  });

  it('alertBestEffort() returns {sent:false} without throwing when unconfigured, and calls onSkipped', async () => {
    const { transport } = fakeTransport(false);
    const onSkipped = vi.fn();
    const alerter = createAlerter(transport, { onSkipped });
    await expect(alerter.alertBestEffort({ severity: 'info', title: 't' })).resolves.toEqual({ sent: false });
    expect(onSkipped).toHaveBeenCalledWith({ severity: 'info', title: 't' });
  });

  it('alertBestEffort() returns {sent:true} when configured', async () => {
    const { transport } = fakeTransport(true);
    const alerter = createAlerter(transport);
    await expect(alerter.alertBestEffort({ severity: 'info', title: 't' })).resolves.toEqual({ sent: true });
  });

  it('alertBestEffort() still throws on a genuine transport failure when configured', async () => {
    const transport: AlertTransport = {
      isConfigured: () => true,
      send: vi.fn(async () => {
        throw new Error('boom');
      }),
    };
    const alerter = createAlerter(transport);
    await expect(alerter.alertBestEffort({ severity: 'info', title: 't' })).rejects.toThrow('boom');
  });

  it('info/warn/error/critical are best-effort convenience wrappers', async () => {
    const { transport, sent } = fakeTransport(true);
    const alerter = createAlerter(transport);
    await alerter.info('a');
    await alerter.warn('b');
    await alerter.error('c', { fields: { x: 1 } });
    await alerter.critical('d');
    expect(sent.map((a) => a.severity)).toEqual(['info', 'warn', 'error', 'critical']);
    expect(sent[2]).toMatchObject({ title: 'c', fields: { x: 1 } });
  });
});
