import { describe, it, expect, vi } from 'vitest';
import { createFallbackTransport, AggregateAlertDeliveryError } from '../fallback';
import { AlertDeliveryError } from '../types';
import type { Alert, AlertDeliveryReceipt, AlertTransport, Severity } from '../types';

const ALERT: Alert = { severity: 'error', title: 'db down' };

function configuredFor(severities: Severity[] | true) {
  return (severity?: Severity): boolean => {
    if (severities === true) return true;
    if (!severity) return severities.length > 0;
    return severities.includes(severity);
  };
}

/** A transport with `deliver()` — the common case. */
function deliverTransport(opts: {
  configured?: Severity[] | true;
  result?: AlertDeliveryReceipt | (() => Promise<AlertDeliveryReceipt>);
  failWith?: unknown;
}): { transport: AlertTransport; calls: number[] } {
  const calls: number[] = [];
  let n = 0;
  const transport: AlertTransport = {
    isConfigured: configuredFor(opts.configured ?? true),
    async send() {
      await this.deliver!(ALERT);
    },
    deliver: vi.fn(async (): Promise<AlertDeliveryReceipt> => {
      calls.push(++n);
      if (opts.failWith !== undefined) throw opts.failWith;
      if (typeof opts.result === 'function') return opts.result();
      return opts.result ?? { attempts: 1 };
    }),
  };
  return { transport, calls };
}

/** A transport with only `send()` — no `deliver()` — to prove the composite never calls both. */
function sendOnlyTransport(opts: { configured?: Severity[] | true; failWith?: unknown }): {
  transport: AlertTransport;
  send: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn(async () => {
    if (opts.failWith !== undefined) throw opts.failWith;
  });
  const transport: AlertTransport = { isConfigured: configuredFor(opts.configured ?? true), send };
  return { transport, send };
}

describe('createFallbackTransport', () => {
  describe('isConfigured', () => {
    it('false when no child is configured', () => {
      const { transport: a } = deliverTransport({ configured: [] });
      const { transport: b } = deliverTransport({ configured: [] });
      const transport = createFallbackTransport([a, b]);
      expect(transport.isConfigured()).toBe(false);
      expect(transport.isConfigured('critical')).toBe(false);
    });

    it('true if ANY child is configured, with or without a severity', () => {
      const { transport: a } = deliverTransport({ configured: [] });
      const { transport: b } = deliverTransport({ configured: ['critical'] });
      const transport = createFallbackTransport([a, b]);
      expect(transport.isConfigured()).toBe(true);
      expect(transport.isConfigured('critical')).toBe(true);
      expect(transport.isConfigured('info')).toBe(false);
    });
  });

  describe('ordering and skipping', () => {
    it('skips a child unconfigured for the severity and tries the next', async () => {
      const { transport: skipped, calls: skippedCalls } = deliverTransport({ configured: ['info'] });
      const { transport: winner, calls: winnerCalls } = deliverTransport({
        configured: true,
        result: { attempts: 1, destinationId: 'chan-1' },
      });
      const transport = createFallbackTransport([skipped, winner]);
      const receipt = await transport.deliver!(ALERT);
      expect(skippedCalls).toHaveLength(0);
      expect(winnerCalls).toHaveLength(1);
      expect(receipt).toMatchObject({ destinationId: 'chan-1', route: '1', attempts: 1 });
      expect(receipt.attemptedRoutes).toEqual([{ label: '0', outcome: 'skipped' }]);
    });

    it('stops at the first success and never invokes a later child', async () => {
      const { transport: first } = deliverTransport({ result: { attempts: 1, destinationId: 'first' } });
      const { transport: second, calls: secondCalls } = deliverTransport({ result: { attempts: 1 } });
      const transport = createFallbackTransport([first, second]);
      const receipt = await transport.deliver!(ALERT);
      expect(receipt.destinationId).toBe('first');
      expect(secondCalls).toHaveLength(0);
      expect(receipt.attemptedRoutes).toBeUndefined();
      expect(receipt.route).toBe('0');
    });

    it('falls through a failing child to the next, recording the failure sanitized', async () => {
      const failure = new AlertDeliveryError('TIMEOUT', true, undefined, undefined, 'dm timed out, token xyz');
      const { transport: dm } = deliverTransport({ failWith: failure });
      const { transport: webhook } = deliverTransport({ result: { attempts: 1, destinationId: 'wh-1' } });
      const transport = createFallbackTransport([
        { transport: dm, label: 'dm' },
        { transport: webhook, label: 'webhook' },
      ]);
      const receipt = await transport.deliver!(ALERT);
      expect(receipt).toMatchObject({ destinationId: 'wh-1', route: 'webhook' });
      expect(receipt.attemptedRoutes).toEqual([{ label: 'dm', outcome: 'failed', code: 'TIMEOUT', retryable: true, destinationId: undefined }]);
      // the sanitized outcome never carries the raw error message/token
      expect(JSON.stringify(receipt.attemptedRoutes)).not.toContain('xyz');
    });
  });

  describe('deliver() vs send()', () => {
    it('calls deliver() when present, never also send()', async () => {
      const { transport, calls } = deliverTransport({ result: { attempts: 1 } });
      const sendSpy = vi.spyOn(transport, 'send');
      const fallback = createFallbackTransport([transport]);
      await fallback.deliver!(ALERT);
      expect(calls).toHaveLength(1);
      expect(sendSpy).not.toHaveBeenCalled();
    });

    it('falls back to send() for a child with no deliver(), and send() on the composite works end to end', async () => {
      const { transport, send } = sendOnlyTransport({});
      const fallback = createFallbackTransport([transport]);
      await fallback.send(ALERT);
      expect(send).toHaveBeenCalledTimes(1);
    });
  });

  describe('no configured candidates', () => {
    it('throws AlertDeliveryError(UNCONFIGURED)', async () => {
      const { transport: a } = deliverTransport({ configured: [] });
      const { transport: b } = deliverTransport({ configured: [] });
      const transport = createFallbackTransport([a, b]);
      await expect(transport.deliver!(ALERT)).rejects.toMatchObject({ code: 'UNCONFIGURED' });
    });
  });

  describe('attempts accounting', () => {
    it('counts child invocations, not skips, and not a child\'s internal HTTP attempts', async () => {
      const { transport: skipped } = deliverTransport({ configured: [] });
      const failure = new AlertDeliveryError('SERVER_ERROR', true);
      const { transport: failing } = deliverTransport({ failWith: failure });
      // this child reports its OWN internal attempts:3 (e.g. retried twice) — the
      // composite must not fold that into its own count.
      const { transport: winner } = deliverTransport({ result: { attempts: 3, destinationId: 'chan' } });
      const transport = createFallbackTransport([skipped, failing, winner]);
      const receipt = await transport.deliver!(ALERT);
      // 2 child invocations: `failing` (failed) + `winner` (succeeded). `skipped` doesn't count.
      expect(receipt.attempts).toBe(2);
      expect(receipt.destinationId).toBe('chan');
    });
  });

  // --- Canary 1: aggregate, not last-error -------------------------------
  describe('aggregate failure (not last-error)', () => {
    it('preserves a retryable DM failure even though the terminal webhook failure is last', async () => {
      const dmFailure = new AlertDeliveryError('TIMEOUT', true, undefined, undefined, 'dm timed out');
      const webhookFailure = new AlertDeliveryError('DESTINATION_REJECTED', false, undefined, undefined, 'webhook rejected');
      const { transport: dm } = deliverTransport({ failWith: dmFailure });
      const { transport: webhook } = deliverTransport({ failWith: webhookFailure });
      const transport = createFallbackTransport([
        { transport: dm, label: 'dm' },
        { transport: webhook, label: 'webhook' },
      ]);

      await expect(transport.deliver!(ALERT)).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(AggregateAlertDeliveryError);
        const agg = err as AggregateAlertDeliveryError;
        // retryable overall because the DM failure (first, non-terminal) was retryable —
        // a naive "rethrow the last error" implementation would report `false` here,
        // because the LAST (webhook) failure is terminal.
        expect(agg.retryable).toBe(true);
        expect(agg.outcomes).toEqual([
          { label: 'dm', outcome: 'failed', code: 'TIMEOUT', retryable: true, destinationId: undefined },
          { label: 'webhook', outcome: 'failed', code: 'DESTINATION_REJECTED', retryable: false, destinationId: undefined },
        ]);
        return true;
      });
    });
  });

  // --- Canary 2: onDegraded containment -----------------------------------
  describe('onDegraded containment', () => {
    it('a throwing onDegraded does not fail a successful, degraded delivery', async () => {
      const failure = new AlertDeliveryError('TIMEOUT', true);
      const { transport: dm } = deliverTransport({ failWith: failure });
      const { transport: webhook } = deliverTransport({ result: { attempts: 1, destinationId: 'wh-1' } });
      const onDegraded = vi.fn(() => {
        throw new Error('onDegraded boom');
      });
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const transport = createFallbackTransport([dm, webhook], { onDegraded });
        const receipt = await transport.deliver!(ALERT);
        expect(receipt.destinationId).toBe('wh-1');
        expect(onDegraded).toHaveBeenCalledTimes(1);
        expect(consoleErrorSpy).toHaveBeenCalled();
      } finally {
        consoleErrorSpy.mockRestore();
      }
    });

    it('does not fire onDegraded when the first configured child succeeds outright', async () => {
      const { transport: winner } = deliverTransport({ result: { attempts: 1 } });
      const onDegraded = vi.fn();
      const transport = createFallbackTransport([winner], { onDegraded });
      await transport.deliver!(ALERT);
      expect(onDegraded).not.toHaveBeenCalled();
    });

    it('fires onDegraded on total failure too, and a throwing observer still lets the real error surface', async () => {
      const failure = new AlertDeliveryError('SERVER_ERROR', true);
      const { transport: a } = deliverTransport({ failWith: failure });
      const { transport: b } = deliverTransport({ failWith: failure });
      const onDegraded = vi.fn(() => {
        throw new Error('onDegraded boom');
      });
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const transport = createFallbackTransport([a, b], { onDegraded });
        await expect(transport.deliver!(ALERT)).rejects.toBeInstanceOf(AggregateAlertDeliveryError);
        expect(onDegraded).toHaveBeenCalledTimes(1);
      } finally {
        consoleErrorSpy.mockRestore();
      }
    });

    // --- Finding 1: the observer's OWN error must never be logged unredacted ---
    it('never logs the observer\'s own thrown error text — a synthetic bot token in it must appear in NO console output', async () => {
      const SYNTHETIC_TOKEN = 'FAKE_BOT_TOKEN_a1b2c3d4e5f6';
      const failure = new AlertDeliveryError('TIMEOUT', true);
      const { transport: dm } = deliverTransport({ failWith: failure });
      const { transport: webhook } = deliverTransport({ result: { attempts: 1, destinationId: 'wh-1' } });
      const onDegraded = vi.fn(() => {
        throw new Error(`leaked secret: ${SYNTHETIC_TOKEN}`);
      });
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const transport = createFallbackTransport([dm, webhook], { onDegraded });
        const receipt = await transport.deliver!(ALERT);
        expect(receipt.destinationId).toBe('wh-1');
        expect(onDegraded).toHaveBeenCalledTimes(1);
        for (const call of [...consoleErrorSpy.mock.calls, ...consoleLogSpy.mock.calls, ...consoleWarnSpy.mock.calls]) {
          expect(JSON.stringify(call)).not.toContain(SYNTHETIC_TOKEN);
        }
      } finally {
        consoleErrorSpy.mockRestore();
        consoleLogSpy.mockRestore();
        consoleWarnSpy.mockRestore();
      }
    });

    // --- Finding 2: an async observer's rejection must be contained, not left unhandled ---
    it('an async onDegraded that rejects does not escape as an unhandled rejection, and delivery still succeeds', async () => {
      const failure = new AlertDeliveryError('TIMEOUT', true);
      const { transport: dm } = deliverTransport({ failWith: failure });
      const { transport: webhook } = deliverTransport({ result: { attempts: 1, destinationId: 'wh-1' } });
      let calls = 0;
      // Deliberately NOT `vi.fn()`: vitest's mock wrapper records the
      // returned promise's settlement internally (to populate
      // `mock.results`), which itself attaches a rejection handler and would
      // mask the exact "nobody attached a handler" condition this test
      // exists to catch. A plain function is the only way to observe the
      // real, unhandled-by-anyone-else rejection.
      const onDegraded = async (): Promise<void> => {
        calls++;
        throw new Error('async onDegraded boom');
      };
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const unhandled: unknown[] = [];
      const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
      process.on('unhandledRejection', onUnhandledRejection);
      try {
        const transport = createFallbackTransport([dm, webhook], { onDegraded });
        const receipt = await transport.deliver!(ALERT);
        expect(receipt.destinationId).toBe('wh-1');
        expect(calls).toBe(1);
        // Give the rejected promise's handler a turn to run. Node's
        // unhandled-rejection detection needs the microtask queue to fully
        // drain; under vitest's own async wrapping that takes more than one
        // macrotask tick, so wait several `setImmediate` turns rather than
        // just one.
        for (let i = 0; i < 5; i++) {
          await new Promise((resolve) => setImmediate(resolve));
        }
        expect(unhandled).toHaveLength(0);
      } finally {
        process.off('unhandledRejection', onUnhandledRejection);
        consoleErrorSpy.mockRestore();
      }
    });
  });
});
