import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createDiscordDmTransport, redactBotToken } from '../discord-dm';
import type { Alert } from '../types';

const TOKEN = 'BOT_TOKEN_ABCDEF123456';
const USER_ID = '111222333444555666';
const CHANNEL_ID = '999888777666555444';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
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

const OPEN_OK = () => jsonResponse(200, { id: CHANNEL_ID });

describe('createDiscordDmTransport', () => {
  describe('isConfigured', () => {
    it('false with neither token nor userId', () => {
      const transport = createDiscordDmTransport({ env: {} });
      expect(transport.isConfigured()).toBe(false);
    });

    it('false with only a token', () => {
      const transport = createDiscordDmTransport({ env: {}, botToken: TOKEN });
      expect(transport.isConfigured()).toBe(false);
    });

    it('false with only a userId', () => {
      const transport = createDiscordDmTransport({ env: {}, userId: USER_ID });
      expect(transport.isConfigured()).toBe(false);
    });

    it('true once both resolve, from env', () => {
      const transport = createDiscordDmTransport({
        env: { DISCORD_BOT_TOKEN: TOKEN, DISCORD_ALERT_DM_USER_ID: USER_ID },
      });
      expect(transport.isConfigured()).toBe(true);
      expect(transport.isConfigured('critical')).toBe(true);
    });
  });

  describe('happy path', () => {
    it('opens the DM channel then posts the embed, no username field, correct auth header', async () => {
      const { impl, calls } = fakeFetch([OPEN_OK(), jsonResponse(200, {})]);
      const transport = createDiscordDmTransport({ botToken: TOKEN, userId: USER_ID, fetchImpl: impl });
      const alert: Alert = { severity: 'error', title: 'DB down', message: 'connection refused' };
      const receipt = await transport.deliver!(alert);

      expect(calls).toHaveLength(2);
      expect(calls[0].url).toBe('https://discord.com/api/v10/users/@me/channels');
      expect(JSON.parse(calls[0].init.body as string)).toEqual({ recipient_id: USER_ID });
      expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(`Bot ${TOKEN}`);

      expect(calls[1].url).toBe(`https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`);
      const body = JSON.parse(calls[1].init.body as string);
      expect(body.username).toBeUndefined();
      expect(body.embeds[0]).toMatchObject({ title: 'DB down', description: 'connection refused', color: 0xe74c3c });
      expect((calls[1].init.headers as Record<string, string>).Authorization).toBe(`Bot ${TOKEN}`);

      expect(receipt).toEqual({ destinationId: CHANNEL_ID, attempts: 1 });
    });

    it('applies the configured service to the embed footer', async () => {
      const { impl, calls } = fakeFetch([OPEN_OK(), jsonResponse(200, {})]);
      const transport = createDiscordDmTransport({ botToken: TOKEN, userId: USER_ID, service: 'ops-health', fetchImpl: impl });
      await transport.send({ severity: 'info', title: 't' });
      const body = JSON.parse(calls[1].init.body as string);
      expect(body.embeds[0].footer).toEqual({ text: 'ops-health' });
    });
  });

  describe('failure classification', () => {
    it('401 invalid token -> DESTINATION_REJECTED, not retryable', async () => {
      const { impl } = fakeFetch([jsonResponse(401, { code: 0, message: '401: Unauthorized' })]);
      const transport = createDiscordDmTransport({ botToken: TOKEN, userId: USER_ID, fetchImpl: impl });
      const err = await transport.deliver!({ severity: 'info', title: 't' }).catch((e) => e);
      expect(err).toMatchObject({ code: 'DESTINATION_REJECTED', retryable: false });
    });

    it('403 with discord code 50007 (cannot send messages to this user) -> DESTINATION_REJECTED, not retryable', async () => {
      const { impl } = fakeFetch([OPEN_OK(), jsonResponse(403, { code: 50007, message: 'Cannot send messages to this user' })]);
      const transport = createDiscordDmTransport({ botToken: TOKEN, userId: USER_ID, fetchImpl: impl });
      const err = await transport.deliver!({ severity: 'info', title: 't' }).catch((e) => e);
      expect(err).toMatchObject({ code: 'DESTINATION_REJECTED', retryable: false, destinationId: CHANNEL_ID });
    });

    it.each([50278, 50001, 50013])('discord code %s -> DESTINATION_REJECTED, not retryable', async (discordCode) => {
      const { impl } = fakeFetch([OPEN_OK(), jsonResponse(400, { code: discordCode, message: 'nope' })]);
      const transport = createDiscordDmTransport({ botToken: TOKEN, userId: USER_ID, fetchImpl: impl });
      const err = await transport.deliver!({ severity: 'info', title: 't' }).catch((e) => e);
      expect(err).toMatchObject({ code: 'DESTINATION_REJECTED', retryable: false });
    });

    it('other 4xx / bad payload -> DESTINATION_REJECTED, not retryable', async () => {
      const { impl } = fakeFetch([OPEN_OK(), jsonResponse(400, { code: 50035, message: 'Invalid Form Body' })]);
      const transport = createDiscordDmTransport({ botToken: TOKEN, userId: USER_ID, fetchImpl: impl });
      const err = await transport.deliver!({ severity: 'info', title: 't' }).catch((e) => e);
      expect(err).toMatchObject({ code: 'DESTINATION_REJECTED', retryable: false });
    });

    it('5xx -> SERVER_ERROR, retryable', async () => {
      const { impl } = fakeFetch([OPEN_OK(), jsonResponse(503, { message: 'unavailable' })]);
      const transport = createDiscordDmTransport({ botToken: TOKEN, userId: USER_ID, fetchImpl: impl });
      const err = await transport.deliver!({ severity: 'info', title: 't' }).catch((e) => e);
      expect(err).toMatchObject({ code: 'SERVER_ERROR', retryable: true });
    });

    it('network failure -> NETWORK, retryable', async () => {
      const impl = vi.fn(async () => {
        throw new Error('getaddrinfo ENOTFOUND discord.com');
      }) as unknown as typeof fetch;
      const transport = createDiscordDmTransport({ botToken: TOKEN, userId: USER_ID, fetchImpl: impl });
      const err = await transport.deliver!({ severity: 'info', title: 't' }).catch((e) => e);
      expect(err).toMatchObject({ code: 'NETWORK', retryable: true });
    });

    it('timeout -> TIMEOUT, retryable', async () => {
      const abortError = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
      const impl = vi.fn(async () => {
        throw abortError;
      }) as unknown as typeof fetch;
      const transport = createDiscordDmTransport({ botToken: TOKEN, userId: USER_ID, fetchImpl: impl, timeoutMs: 5 });
      const err = await transport.deliver!({ severity: 'info', title: 't' }).catch((e) => e);
      expect(err).toMatchObject({ code: 'TIMEOUT', retryable: true });
    });
  });

  describe('429 handling', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('waits retry_after and retries once, resolving on the second attempt', async () => {
      const { impl, calls } = fakeFetch([OPEN_OK(), jsonResponse(429, { retry_after: 2 }), jsonResponse(200, {})]);
      const transport = createDiscordDmTransport({ botToken: TOKEN, userId: USER_ID, fetchImpl: impl });
      const send = transport.deliver!({ severity: 'info', title: 't' });
      await vi.advanceTimersByTimeAsync(2000);
      await expect(send).resolves.toMatchObject({ destinationId: CHANNEL_ID, attempts: 2 });
      expect(calls).toHaveLength(3);
    });

    it('a plain 429 whose retry would exceed the deadline throws RATE_LIMITED without retrying', async () => {
      const { impl, calls } = fakeFetch([OPEN_OK(), jsonResponse(429, { retry_after: 30 })]);
      const transport = createDiscordDmTransport({ botToken: TOKEN, userId: USER_ID, fetchImpl: impl, deadlineMs: 1_000 });
      const err = await transport.deliver!({ severity: 'info', title: 't' }).catch((e) => e);
      expect(err).toMatchObject({ code: 'RATE_LIMITED', retryable: true });
      expect(calls).toHaveLength(2);
    });

    it.each([40003, 40004])(
      'discord code %s on send_message is RATE_LIMITED/retryable but is NOT retried locally',
      async (discordCode) => {
        const { impl, calls } = fakeFetch([OPEN_OK(), jsonResponse(429, { code: discordCode, retry_after: 1 })]);
        const transport = createDiscordDmTransport({ botToken: TOKEN, userId: USER_ID, fetchImpl: impl });
        const err = await transport.deliver!({ severity: 'info', title: 't' }).catch((e) => e);
        expect(err).toMatchObject({ code: 'RATE_LIMITED', retryable: true });
        // Only the initial open + initial send — no local retry attempt.
        expect(calls).toHaveLength(2);
      },
    );

    it('code 40003 on open_dm (opening DMs too fast) is RATE_LIMITED/retryable but not retried locally', async () => {
      const { impl, calls } = fakeFetch([jsonResponse(429, { code: 40003, retry_after: 1 })]);
      const transport = createDiscordDmTransport({ botToken: TOKEN, userId: USER_ID, fetchImpl: impl });
      const err = await transport.deliver!({ severity: 'info', title: 't' }).catch((e) => e);
      expect(err).toMatchObject({ code: 'RATE_LIMITED', retryable: true });
      expect(calls).toHaveLength(1);
    });
  });

  describe('malformed channel id', () => {
    it('a missing/non-string id from open_dm throws SERVER_ERROR rather than trusting it', async () => {
      const { impl } = fakeFetch([jsonResponse(200, { id: 12345 })]);
      const transport = createDiscordDmTransport({ botToken: TOKEN, userId: USER_ID, fetchImpl: impl });
      const err = await transport.deliver!({ severity: 'info', title: 't' }).catch((e) => e);
      expect(err).toMatchObject({ code: 'SERVER_ERROR' });
    });
  });

  describe('deadline', () => {
    it('an already-exhausted deadline throws TIMEOUT before any fetch call', async () => {
      const { impl, calls } = fakeFetch([OPEN_OK(), jsonResponse(200, {})]);
      const transport = createDiscordDmTransport({ botToken: TOKEN, userId: USER_ID, fetchImpl: impl, deadlineMs: -1 });
      const err = await transport.deliver!({ severity: 'info', title: 't' }).catch((e) => e);
      expect(err).toMatchObject({ code: 'TIMEOUT' });
      expect(calls).toHaveLength(0);
    });
  });

  describe('lazy config resolution', () => {
    it('reads botToken/userId/service from env at send time, not at transport-creation time', async () => {
      const { impl, calls } = fakeFetch([OPEN_OK(), jsonResponse(200, {})]);
      const env: Record<string, string | undefined> = {};
      const transport = createDiscordDmTransport({ env, fetchImpl: impl });
      env.DISCORD_BOT_TOKEN = TOKEN;
      env.DISCORD_ALERT_DM_USER_ID = USER_ID;
      env.DISCORD_ALERT_SERVICE = 'late-service';
      await transport.send({ severity: 'info', title: 't' });
      expect(JSON.parse(calls[0].init.body as string)).toEqual({ recipient_id: USER_ID });
      const body = JSON.parse(calls[1].init.body as string);
      expect(body.embeds[0].footer).toEqual({ text: 'late-service' });
    });
  });
});

describe('redactBotToken', () => {
  it('redacts the exact token given', () => {
    expect(redactBotToken(`Authorization: Bot ${TOKEN}`, TOKEN)).not.toContain(TOKEN);
  });

  it('redacts a Bot-prefixed token heuristically even without the exact token supplied', () => {
    const out = redactBotToken(`failed with header Authorization: Bot ${TOKEN}`);
    expect(out).not.toContain(TOKEN);
  });

  it('coerces non-string input instead of throwing', () => {
    expect(() => redactBotToken(undefined, TOKEN)).not.toThrow();
    expect(() => redactBotToken(42, TOKEN)).not.toThrow();
  });
});

// The highest-value test in this file: the bot token must never appear in a
// thrown error, a delivery receipt, or anything written to the console — even
// when the fetch implementation itself throws an error whose message embeds
// the request (as some real fetch/undici implementations do for a malformed
// request).
describe('the bot token is never leaked', () => {
  it('never appears in a thrown error across the whole failure surface, including a fetch error that embeds the auth header', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const scenarios: Array<() => Promise<unknown>> = [
        // A fetch implementation whose thrown error embeds the full request,
        // headers included — the exact shape this test exists to catch.
        async () => {
          const impl = vi.fn(async (url: string, init: RequestInit) => {
            throw new Error(
              `request to ${url} failed, reason: connect ECONNREFUSED — sent headers: ${JSON.stringify(init.headers)}`,
            );
          }) as unknown as typeof fetch;
          const transport = createDiscordDmTransport({ botToken: TOKEN, userId: USER_ID, fetchImpl: impl });
          return transport.deliver!({ severity: 'critical', title: 't' });
        },
        // A malformed-URL-style fetch throw (mirrors the webhook transport's
        // documented failure mode) — shouldn't apply here since URLs are
        // fixed, but confirm a generic throw is still safe.
        async () => {
          const impl = vi.fn(async () => {
            throw new TypeError(`Failed to parse URL, Authorization: Bot ${TOKEN}`);
          }) as unknown as typeof fetch;
          const transport = createDiscordDmTransport({ botToken: TOKEN, userId: USER_ID, fetchImpl: impl });
          return transport.deliver!({ severity: 'critical', title: 't' });
        },
        // A non-2xx response whose body somehow echoes the request back
        // (some providers do this for malformed auth).
        async () => {
          const impl = fakeFetch([jsonResponse(400, { code: 0, message: `Bot ${TOKEN} is malformed` })]).impl;
          const transport = createDiscordDmTransport({ botToken: TOKEN, userId: USER_ID, fetchImpl: impl });
          return transport.deliver!({ severity: 'critical', title: 't' });
        },
      ];

      for (const run of scenarios) {
        const err = await run().catch((e) => e);
        expect(err).toBeInstanceOf(Error);
        const message = (err as Error).message;
        expect(message).not.toContain(TOKEN);
        expect(JSON.stringify(err)).not.toContain(TOKEN);
      }

      for (const call of [...consoleErrorSpy.mock.calls, ...consoleLogSpy.mock.calls]) {
        expect(JSON.stringify(call)).not.toContain(TOKEN);
      }
    } finally {
      consoleErrorSpy.mockRestore();
      consoleLogSpy.mockRestore();
    }
  });

  it('never appears in a successful receipt', async () => {
    const { impl } = fakeFetch([OPEN_OK(), jsonResponse(200, {})]);
    const transport = createDiscordDmTransport({ botToken: TOKEN, userId: USER_ID, fetchImpl: impl });
    const receipt = await transport.deliver!({ severity: 'info', title: 't' });
    expect(JSON.stringify(receipt)).not.toContain(TOKEN);
  });
});
