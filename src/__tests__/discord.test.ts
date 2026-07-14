import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createDiscordTransport } from '../discord';
import { createAlerter } from '../alerter';
import type { Alert } from '../types';

const PRIMARY = 'https://discord.com/api/webhooks/primary';
const CRITICAL = 'https://discord.com/api/webhooks/critical';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => text,
    clone() {
      return jsonResponse(status, body, headers);
    },
  } as unknown as Response;
}

function fakeFetch(responses: Response[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const queue = [...responses];
  const impl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (!next) throw new Error('fakeFetch: no more queued responses');
    return next;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe('createDiscordTransport', () => {
  describe('isConfigured / no route', () => {
    it('is unconfigured with no webhookUrl and no severity urls', () => {
      const transport = createDiscordTransport({ env: {} });
      expect(transport.isConfigured()).toBe(false);
    });

    it('best-effort alerter skips without calling fetch when unconfigured', async () => {
      const { impl, calls } = fakeFetch([]);
      const transport = createDiscordTransport({ env: {}, fetchImpl: impl });
      const alerter = createAlerter(transport);
      await expect(alerter.alertBestEffort({ severity: 'info', title: 'hi' })).resolves.toEqual({ sent: false });
      expect(calls).toHaveLength(0);
    });

    it('strict alert() throws when unconfigured', async () => {
      const transport = createDiscordTransport({ env: {} });
      const alerter = createAlerter(transport);
      await expect(alerter.alert({ severity: 'info', title: 'hi' })).rejects.toThrow(/not configured/);
    });

    it('isConfigured true with only a severity url set, but an unrouted severity throws on send', async () => {
      const transport = createDiscordTransport({ env: {}, severityWebhookUrls: { critical: CRITICAL } });
      expect(transport.isConfigured()).toBe(true);
      await expect(transport.send({ severity: 'info', title: 'x' })).rejects.toThrow(/No Discord webhook route/);
    });
  });

  describe('posting an embed', () => {
    it('posts with correct color, title, description, ISO timestamp, footer, and inline fields', async () => {
      const { impl, calls } = fakeFetch([jsonResponse(200, {})]);
      const now = new Date('2026-01-01T00:00:00.000Z');
      const transport = createDiscordTransport({
        webhookUrl: PRIMARY,
        service: 'cairn-prod',
        fetchImpl: impl,
      });
      const alert: Alert = {
        severity: 'error',
        title: 'DB down',
        message: 'connection refused',
        fields: { host: 'db1', attempt: 3, retrying: true },
        timestamp: now,
      };
      await transport.send(alert);

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(PRIMARY);
      const body = JSON.parse(calls[0].init.body as string);
      expect(body.embeds[0]).toMatchObject({
        title: 'DB down',
        description: 'connection refused',
        color: 0xe74c3c,
        timestamp: '2026-01-01T00:00:00.000Z',
        footer: { text: 'cairn-prod' },
      });
      expect(body.embeds[0].fields).toEqual([
        { name: 'host', value: 'db1', inline: true },
        { name: 'attempt', value: '3', inline: true },
        { name: 'retrying', value: 'true', inline: true },
      ]);
    });

    it('uses default severity colors', async () => {
      for (const [severity, color] of [
        ['info', 0x3498db],
        ['warn', 0xf1c40f],
        ['error', 0xe74c3c],
        ['critical', 0x992d22],
      ] as const) {
        const { impl, calls } = fakeFetch([jsonResponse(200, {})]);
        const transport = createDiscordTransport({ webhookUrl: PRIMARY, fetchImpl: impl });
        await transport.send({ severity, title: 't' });
        const body = JSON.parse(calls[0].init.body as string);
        expect(body.embeds[0].color).toBe(color);
      }
    });
  });

  describe('per-severity routing', () => {
    it('uses the severity-specific URL when set', async () => {
      const { impl, calls } = fakeFetch([jsonResponse(200, {})]);
      const transport = createDiscordTransport({
        webhookUrl: PRIMARY,
        severityWebhookUrls: { critical: CRITICAL },
        fetchImpl: impl,
      });
      await transport.send({ severity: 'critical', title: 't' });
      expect(calls[0].url).toBe(CRITICAL);
    });

    it('falls back to primary when no severity-specific URL is set', async () => {
      const { impl, calls } = fakeFetch([jsonResponse(200, {})]);
      const transport = createDiscordTransport({
        webhookUrl: PRIMARY,
        severityWebhookUrls: { critical: CRITICAL },
        fetchImpl: impl,
      });
      await transport.send({ severity: 'warn', title: 't' });
      expect(calls[0].url).toBe(PRIMARY);
    });
  });

  describe('truncation', () => {
    it('truncates an over-long title, description, and field value with a trailing ellipsis', async () => {
      const { impl, calls } = fakeFetch([jsonResponse(200, {})]);
      const transport = createDiscordTransport({ webhookUrl: PRIMARY, fetchImpl: impl });
      await transport.send({
        severity: 'info',
        title: 'x'.repeat(300),
        message: 'y'.repeat(5000),
        fields: { note: 'z'.repeat(2000) },
      });
      const body = JSON.parse(calls[0].init.body as string);
      expect(body.embeds[0].title).toHaveLength(256);
      expect(body.embeds[0].title.endsWith('…')).toBe(true);
      expect(body.embeds[0].description).toHaveLength(4096);
      expect(body.embeds[0].description.endsWith('…')).toBe(true);
      expect(body.embeds[0].fields[0].value).toHaveLength(1024);
      expect(body.embeds[0].fields[0].value.endsWith('…')).toBe(true);
    });

    it('caps fields at 25', async () => {
      const { impl, calls } = fakeFetch([jsonResponse(200, {})]);
      const transport = createDiscordTransport({ webhookUrl: PRIMARY, fetchImpl: impl });
      const fields: Record<string, string> = {};
      for (let i = 0; i < 40; i++) fields[`f${i}`] = String(i);
      await transport.send({ severity: 'info', title: 't', fields });
      const body = JSON.parse(calls[0].init.body as string);
      expect(body.embeds[0].fields).toHaveLength(25);
    });
  });

  describe('429 handling', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('waits retry_after and retries once, resolving on the second 200', async () => {
      const { impl, calls } = fakeFetch([
        jsonResponse(429, { retry_after: 2 }),
        jsonResponse(200, {}),
      ]);
      const onSent = vi.fn();
      const send = createDiscordTransport({ webhookUrl: PRIMARY, fetchImpl: impl, onSent }).send({
        severity: 'info',
        title: 't',
      });
      await vi.advanceTimersByTimeAsync(2000);
      await expect(send).resolves.toBeUndefined();
      expect(calls).toHaveLength(2);
    });

    it('fails before retrying when Retry-After would exceed the configured total deadline', async () => {
      const { impl, calls } = fakeFetch([jsonResponse(429, { retry_after: 2 })]);
      const transport = createDiscordTransport({ webhookUrl: PRIMARY, fetchImpl: impl, totalTimeoutMs: 1_000 });
      await expect(transport.send({ severity: 'info', title: 't' })).rejects.toThrow(/total deadline exceeded after 1000ms/);
      expect(calls).toHaveLength(1);
    });
  });

  describe('non-2xx', () => {
    it('throws including the status in the message', async () => {
      const { impl } = fakeFetch([jsonResponse(500, { message: 'internal error' })]);
      const transport = createDiscordTransport({ webhookUrl: PRIMARY, fetchImpl: impl });
      await expect(transport.send({ severity: 'info', title: 't' })).rejects.toThrow(/status 500/);
    });
  });

  describe('timeout', () => {
    const TIMEOUT_MSG = /Discord webhook POST timed out after \d+ms/;

    it('rejects when fetch rejects with an AbortError-like error', async () => {
      const abortError = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
      const impl = vi.fn(async () => {
        throw abortError;
      }) as unknown as typeof fetch;
      const transport = createDiscordTransport({ webhookUrl: PRIMARY, fetchImpl: impl, timeoutMs: 5 });
      await expect(transport.send({ severity: 'info', title: 't' })).rejects.toThrow(TIMEOUT_MSG);
    });

    it('actually drives the timer -> abort -> signal wiring, not just a pre-made AbortError', async () => {
      vi.useFakeTimers();
      try {
        const impl = vi.fn(
          (_url: string, init: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              init.signal?.addEventListener('abort', () => {
                reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
              });
            }),
        ) as unknown as typeof fetch;
        const transport = createDiscordTransport({ webhookUrl: PRIMARY, fetchImpl: impl, timeoutMs: 50 });
        const send = transport.send({ severity: 'info', title: 't' });
        const assertion = expect(send).rejects.toThrow(TIMEOUT_MSG);
        await vi.advanceTimersByTimeAsync(50);
        await assertion;
      } finally {
        vi.useRealTimers();
      }
    });

    it('C2: a 500 whose body only rejects on abort surfaces the timeout, not a mislabeled "status 500"', async () => {
      vi.useFakeTimers();
      try {
        const impl = vi.fn(
          (_url: string, init: RequestInit) =>
            new Promise<Response>((resolve, reject) => {
              const res = {
                ok: false,
                status: 500,
                headers: { get: () => null },
                json: async () => ({}),
                text: () =>
                  new Promise<string>((_r, rejectBody) => {
                    init.signal?.addEventListener('abort', () => {
                      rejectBody(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
                    });
                  }),
                clone() {
                  return res;
                },
              } as unknown as Response;
              init.signal?.addEventListener('abort', () => {
                reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
              });
              resolve(res);
            }),
        ) as unknown as typeof fetch;
        const transport = createDiscordTransport({ webhookUrl: PRIMARY, fetchImpl: impl, timeoutMs: 50 });
        const send = transport.send({ severity: 'info', title: 't' });
        const assertion = expect(send).rejects.toThrow(TIMEOUT_MSG);
        await vi.advanceTimersByTimeAsync(50);
        await assertion;
        await expect(send).rejects.not.toThrow(/status 500/);
      } finally {
        vi.useRealTimers();
      }
    });

    it('C1: a 429 whose body only rejects on abort surfaces the timeout and does NOT retry', async () => {
      vi.useFakeTimers();
      try {
        const impl = vi.fn((_url: string, init: RequestInit) => {
          return new Promise<Response>((resolve) => {
            const res = {
              ok: false,
              status: 429,
              headers: { get: () => null },
              text: async () => '',
              json: () =>
                new Promise((_r, rejectBody) => {
                  init.signal?.addEventListener('abort', () => {
                    rejectBody(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
                  });
                }),
              clone() {
                return res;
              },
            } as unknown as Response;
            resolve(res);
          });
        }) as unknown as typeof fetch;
        const transport = createDiscordTransport({ webhookUrl: PRIMARY, fetchImpl: impl, timeoutMs: 50 });
        const send = transport.send({ severity: 'info', title: 't' });
        const assertion = expect(send).rejects.toThrow(TIMEOUT_MSG);
        await vi.advanceTimersByTimeAsync(50);
        await assertion;
        expect(impl).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('code-point-safe truncation', () => {
    it('does not split a surrogate pair at the truncation boundary', async () => {
      const { impl, calls } = fakeFetch([jsonResponse(200, {})]);
      const transport = createDiscordTransport({ webhookUrl: PRIMARY, fetchImpl: impl });
      const title = `x${'😀'.repeat(300)}`;
      await transport.send({ severity: 'info', title });
      const body = JSON.parse(calls[0].init.body as string);
      const out = body.embeds[0].title as string;
      expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(out)).toBe(false);
      expect(out.endsWith('…')).toBe(true);
      expect([...out].length).toBeLessThanOrEqual(256);
    });
  });

  describe('empty title/field placeholder', () => {
    it('replaces an empty title and empty field value with the placeholder, not an empty string', async () => {
      const { impl, calls } = fakeFetch([jsonResponse(200, {})]);
      const transport = createDiscordTransport({ webhookUrl: PRIMARY, fetchImpl: impl });
      await transport.send({ severity: 'error', title: '   ', fields: { detail: '' } });
      const body = JSON.parse(calls[0].init.body as string);
      expect(body.embeds[0].title).toBe('—');
      expect(body.embeds[0].fields[0].value).toBe('—');
    });
  });

  describe('severity-aware isConfigured', () => {
    it('is configured for a severity with only a dedicated route, and for severities that fall back to primary', () => {
      const transport = createDiscordTransport({ env: {}, severityWebhookUrls: { critical: CRITICAL } });
      expect(transport.isConfigured('critical')).toBe(true);
      expect(transport.isConfigured('info')).toBe(false);
    });

    it('best-effort alerter skips a specific unrouted severity without calling fetch, even when another severity is routed', async () => {
      const { impl, calls } = fakeFetch([]);
      const transport = createDiscordTransport({ env: {}, severityWebhookUrls: { critical: CRITICAL }, fetchImpl: impl });
      const alerter = createAlerter(transport);
      await expect(alerter.info('hi')).resolves.toEqual({ sent: false });
      expect(calls).toHaveLength(0);
    });

    it('strict alert() rejects for a specific unrouted severity, even when another severity is routed', async () => {
      const transport = createDiscordTransport({ env: {}, severityWebhookUrls: { critical: CRITICAL } });
      const alerter = createAlerter(transport);
      await expect(alerter.alert({ severity: 'info', title: 't' })).rejects.toThrow(/not configured/);
    });
  });

  describe('webhook URL credential handling', () => {
    const WEBHOOK_WITH_TOKEN = 'https://discord.com/api/webhooks/123456789012345678/super-secret-token';

    it('onSent receives a non-secret webhookId, never the token or full URL', async () => {
      const { impl, calls } = fakeFetch([jsonResponse(200, {})]);
      const onSent = vi.fn();
      const transport = createDiscordTransport({ webhookUrl: WEBHOOK_WITH_TOKEN, fetchImpl: impl, onSent });
      await transport.send({ severity: 'info', title: 't' });
      expect(calls).toHaveLength(1);
      expect(onSent).toHaveBeenCalledWith({ severity: 'info', title: 't', webhookId: '123456789012345678' });
      const [info] = onSent.mock.calls[0] as [{ webhookId?: string }];
      expect(JSON.stringify(info)).not.toContain('super-secret-token');
    });

    it('a thrown error never contains the webhook URL', async () => {
      const { impl } = fakeFetch([jsonResponse(500, { message: 'internal error' })]);
      const transport = createDiscordTransport({ webhookUrl: WEBHOOK_WITH_TOKEN, fetchImpl: impl });
      await expect(transport.send({ severity: 'info', title: 't' })).rejects.toSatisfy((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        return !message.includes(WEBHOOK_WITH_TOKEN) && !message.includes('super-secret-token');
      });
    });
  });

  describe('retry_after clamping', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('clamps a negative retry_after to a non-negative delay and still retries', async () => {
      const { impl, calls } = fakeFetch([jsonResponse(429, { retry_after: -5 }), jsonResponse(200, {})]);
      const send = createDiscordTransport({ webhookUrl: PRIMARY, fetchImpl: impl }).send({
        severity: 'info',
        title: 't',
      });
      await vi.advanceTimersByTimeAsync(0);
      await expect(send).resolves.toBeUndefined();
      expect(calls).toHaveLength(2);
    });
  });

  describe('C3: aggregate 6000-code-point embed budget', () => {
    function embedTotal(embed: {
      title: string;
      description?: string;
      footer?: { text: string };
      fields?: Array<{ name: string; value: string }>;
    }): number {
      let total = [...embed.title].length;
      if (embed.description) total += [...embed.description].length;
      if (embed.footer) total += [...embed.footer.text].length;
      if (embed.fields) {
        for (const f of embed.fields) total += [...f.name].length + [...f.value].length;
      }
      return total;
    }

    it('trims an oversized embed (4096-char description + 25 max-length fields) to <= 6000 total, keeping the title', async () => {
      const { impl, calls } = fakeFetch([jsonResponse(200, {})]);
      const transport = createDiscordTransport({ webhookUrl: PRIMARY, fetchImpl: impl });
      const fields: Record<string, string> = {};
      for (let i = 0; i < 25; i++) fields[`field-${i}`] = 'v'.repeat(1024);
      await transport.send({
        severity: 'info',
        title: 'Important Title',
        message: 'd'.repeat(4096),
        fields,
      });
      const body = JSON.parse(calls[0].init.body as string);
      const embed = body.embeds[0];
      expect(embed.title).toBe('Important Title');
      expect(embedTotal(embed)).toBeLessThanOrEqual(6000);
      // 25 fields at 1024 chars each (~25,600) plus a 4096-char description
      // can't possibly fit under 6000 — fields must have been trimmed.
      expect((embed.fields ?? []).length).toBeLessThan(25);
    });

    it('leaves a normal small alert unchanged (no over-eager truncation)', async () => {
      const { impl, calls } = fakeFetch([jsonResponse(200, {})]);
      const transport = createDiscordTransport({ webhookUrl: PRIMARY, fetchImpl: impl, service: 'svc' });
      await transport.send({
        severity: 'info',
        title: 'Small alert',
        message: 'all is well',
        fields: { a: '1', b: '2' },
      });
      const body = JSON.parse(calls[0].init.body as string);
      const embed = body.embeds[0];
      expect(embed.title).toBe('Small alert');
      expect(embed.description).toBe('all is well');
      expect(embed.footer).toEqual({ text: 'svc' });
      expect(embed.fields).toEqual([
        { name: 'a', value: '1', inline: true },
        { name: 'b', value: '2', inline: true },
      ]);
    });
  });

  describe('C4: custom color validation', () => {
    it('falls back to the default info color when given NaN', async () => {
      const { impl, calls } = fakeFetch([jsonResponse(200, {})]);
      const transport = createDiscordTransport({ webhookUrl: PRIMARY, fetchImpl: impl, colors: { info: NaN } });
      await transport.send({ severity: 'info', title: 't' });
      const body = JSON.parse(calls[0].init.body as string);
      expect(body.embeds[0].color).toBe(0x3498db);
      expect(typeof body.embeds[0].color).toBe('number');
      expect(body.embeds[0].color).not.toBeNull();
    });

    it('falls back to the default info color when given a negative value', async () => {
      const { impl, calls } = fakeFetch([jsonResponse(200, {})]);
      const transport = createDiscordTransport({ webhookUrl: PRIMARY, fetchImpl: impl, colors: { info: -1 } });
      await transport.send({ severity: 'info', title: 't' });
      const body = JSON.parse(calls[0].init.body as string);
      expect(body.embeds[0].color).toBe(0x3498db);
    });

    it('falls back to the default info color when given an out-of-range value', async () => {
      const { impl, calls } = fakeFetch([jsonResponse(200, {})]);
      const transport = createDiscordTransport({
        webhookUrl: PRIMARY,
        fetchImpl: impl,
        colors: { info: 0x1000000 },
      });
      await transport.send({ severity: 'info', title: 't' });
      const body = JSON.parse(calls[0].init.body as string);
      expect(body.embeds[0].color).toBe(0x3498db);
    });

    it('accepts a valid custom color', async () => {
      const { impl, calls } = fakeFetch([jsonResponse(200, {})]);
      const transport = createDiscordTransport({ webhookUrl: PRIMARY, fetchImpl: impl, colors: { info: 0x123456 } });
      await transport.send({ severity: 'info', title: 't' });
      const body = JSON.parse(calls[0].init.body as string);
      expect(body.embeds[0].color).toBe(0x123456);
    });
  });

  describe('lazy config resolution', () => {
    it('reads service/username/timeoutMs/colors from env at send time, not at transport-creation time', async () => {
      const { impl, calls } = fakeFetch([jsonResponse(200, {})]);
      const env: Record<string, string | undefined> = {};
      const transport = createDiscordTransport({ webhookUrl: PRIMARY, env, fetchImpl: impl });
      // Simulate late `dotenv` population happening after transport creation.
      env.DISCORD_ALERT_SERVICE = 'late-service';
      env.DISCORD_ALERT_USERNAME = 'late-bot';
      await transport.send({ severity: 'info', title: 't' });
      const body = JSON.parse(calls[0].init.body as string);
      expect(body.username).toBe('late-bot');
      expect(body.embeds[0].footer).toEqual({ text: 'late-service' });
    });
  });
});

describe('createAlerter convenience methods', () => {
  it('error(title, { fields }) posts with severity error', async () => {
    const { impl, calls } = fakeFetch([jsonResponse(200, {})]);
    const transport = createDiscordTransport({ webhookUrl: PRIMARY, fetchImpl: impl });
    const alerter = createAlerter(transport);
    await alerter.error('Something broke', { fields: { code: 500 } });
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.embeds[0].color).toBe(0xe74c3c);
    expect(body.embeds[0].title).toBe('Something broke');
    expect(body.embeds[0].fields).toEqual([{ name: 'code', value: '500', inline: true }]);
  });
});

// The webhook URL is a BEARER CREDENTIAL. fetch embeds it in some errors — a
// scheme-less URL yields `TypeError: Failed to parse URL from
// discord.com/api/webhooks/<id>/<TOKEN>`. Callers routinely log `error.message`
// (bewks does), so a raw rethrow puts the token straight into application logs.
// smarthome and savoro both hand-rolled guards against exactly this; the kit did
// not, which made it NOT a superset of the code it replaces. This path had zero
// test coverage, which is why the leak shipped.
describe('the webhook URL is never leaked in an error', () => {
  const TOKEN = 'SUPER_SECRET_TOKEN';

  it('redacts the webhook URL from a malformed-URL fetch error', async () => {
    const transport = createDiscordTransport({
      webhookUrl: `discord.com/api/webhooks/123/${TOKEN}`, // no scheme -> fetch throws with the URL in the message
    });
    await expect(transport.send({ severity: 'info', title: 't' })).rejects.toThrow(
      /<redacted-webhook-url>/,
    );
    await expect(transport.send({ severity: 'info', title: 't' })).rejects.not.toThrow(
      new RegExp(TOKEN),
    );
  });

  it('redacts the webhook URL from an arbitrary transport error', async () => {
    const impl = (() => {
      throw new Error(`connect failed to https://discord.com/api/webhooks/9/${TOKEN}`);
    }) as unknown as typeof fetch;
    const transport = createDiscordTransport({
      webhookUrl: `https://discord.com/api/webhooks/9/${TOKEN}`,
      fetchImpl: impl,
    });
    const err = await transport.send({ severity: 'info', title: 't' }).catch((e: Error) => e);
    expect((err as Error).message).not.toContain(TOKEN);
    expect((err as Error).message).toContain('<redacted-webhook-url>');
  });

  it('still says WHAT failed after redaction', async () => {
    const transport = createDiscordTransport({ webhookUrl: `discord.com/api/webhooks/1/${TOKEN}` });
    await expect(transport.send({ severity: 'info', title: 't' })).rejects.toThrow(/failed/i);
  });
});
