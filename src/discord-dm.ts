import { AlertDeliveryError, type Alert, type AlertDeliveryReceipt, type AlertTransport, type Severity } from './types';
import { buildEmbed, DEFAULT_COLORS, delay, isAbortError } from './discord-internal';

// Fixed, trusted API endpoints — never built from untrusted input. The bot
// token authenticates the request; there is no "webhook id" segment in the
// URL for this transport, so (unlike the webhook path) there is nothing
// destination-specific to validate before the POST.
const API_BASE = 'https://discord.com/api/v10';

// Per-request timeout: bounds a single HTTP call (channel open, message
// send, or a retry of either).
const DEFAULT_TIMEOUT_MS = 5_000;
// Total operation deadline: bounds channel open + message POST + any 429
// retry wait, END TO END. Kept conservative (a few seconds) on purpose — the
// health monitor this transport exists for needs to fail fast enough that a
// caller still has time left to try a fallback transport before ITS OWN
// deadline runs out.
const DEFAULT_DEADLINE_MS = 8_000;

// Discord error codes (distinct from HTTP status — read from the JSON body's
// numeric `code` field) that mean "rate limited" but must NOT be retried
// locally: the caller should fall back instead of burning its deadline on a
// bounded retry that Discord has already told us won't help soon.
const NO_LOCAL_RETRY_CODES = new Set([40003, 40004]);

export interface DiscordDmTransportOptions {
  /** Config source. Defaults to `process.env`. Read lazily on every call. */
  env?: Record<string, string | undefined>;
  /** Bot token for `Authorization: Bot <token>`. Else `env.DISCORD_BOT_TOKEN`. */
  botToken?: string;
  /** Discord user id to DM. Else `env.DISCORD_ALERT_DM_USER_ID`. */
  userId?: string;
  /** Service name shown in the embed footer. Else `env.DISCORD_ALERT_SERVICE`. */
  service?: string;
  /** fetch override — test seam. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-HTTP-call timeout. Default 5_000ms. */
  timeoutMs?: number;
  /**
   * Total deadline covering channel open, message POST, and any 429 retry
   * wait. Default 8_000ms — deliberately conservative so a caller with its
   * own deadline still has time left to try a fallback transport after this
   * one gives up.
   */
  deadlineMs?: number;
}

interface ResolvedConfig {
  botToken: string | undefined;
  userId: string | undefined;
  service: string | undefined;
  timeoutMs: number;
  deadlineMs: number;
}

/** service/userId/botToken/service, resolved lazily per call so late `dotenv` population isn't silently dropped. */
function resolveConfig(options: DiscordDmTransportOptions): ResolvedConfig {
  const env = options.env ?? process.env;
  return {
    botToken: options.botToken?.trim() || env.DISCORD_BOT_TOKEN?.trim() || undefined,
    userId: options.userId?.trim() || env.DISCORD_ALERT_DM_USER_ID?.trim() || undefined,
    service: options.service?.trim() || env.DISCORD_ALERT_SERVICE?.trim() || undefined,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    deadlineMs: options.deadlineMs ?? DEFAULT_DEADLINE_MS,
  };
}

/**
 * Redact a bot token (a bearer credential, distinct from the webhook URLs
 * `redactWebhookUrl` handles) out of any text before it can be logged.
 * Redacts the exact token we were given, plus anything shaped like an
 * `Authorization: Bot <token>` header, so a mangled or partially-quoted
 * variant — e.g. one embedded by a fetch implementation's own thrown error
 * message — can't slip through. Takes `unknown` and coerces, for the same
 * reason `redactWebhookUrl` does: every real call site is a last line of
 * defense around a value that might not be a string.
 */
export function redactBotToken(text: unknown, token?: string): string {
  let out = String(text);
  if (token && token.length > 0) out = out.split(token).join('<redacted-bot-token>');
  out = out.replace(/\bBot\s+\S{10,}/gi, 'Bot <redacted-bot-token>');
  return out;
}

function extractDiscordCode(json: unknown): number | undefined {
  if (json && typeof json === 'object' && 'code' in json) {
    const code = (json as { code?: unknown }).code;
    return typeof code === 'number' ? code : undefined;
  }
  return undefined;
}

/**
 * Discord's `retry_after` (seconds), from the `Retry-After` header or the
 * JSON body, whichever is present. Unlike the webhook transport's
 * `readRetryAfterSec`, this is NOT capped at 60s — the deadline check at the
 * call site (`delayMs >= remainingMs()`) already bounds the practical impact
 * of an excessive value by throwing before the wait, so a separate cap isn't
 * needed here.
 */
function parseRetryAfterSec(json: unknown, header: string | null): number {
  let raw = NaN;
  if (header && !Number.isNaN(Number(header))) {
    raw = Number(header);
  } else if (json && typeof json === 'object' && 'retry_after' in json) {
    const value = (json as { retry_after?: unknown }).retry_after;
    if (typeof value === 'number') raw = value;
  }
  return Math.max(Number.isFinite(raw) ? raw : 1, 0);
}

type ApiAttempt =
  | { kind: 'ok'; json: unknown }
  | { kind: 'rateLimited'; retryAfterSec: number; discordCode: number | undefined }
  | { kind: 'error'; status: number; discordCode: number | undefined };

/**
 * One bounded POST to the Discord API. Reads the response body (needed to
 * get the numeric Discord `code` and, on a 429, `retry_after`) INSIDE the
 * same timeout as the fetch itself — a slow body must not be able to hang
 * the caller past `timeoutMs` any more than slow headers can, same
 * discipline as the webhook path's `attempt()`.
 *
 * Never rethrows a raw fetch error: the bot token lives only in the
 * `Authorization` header, and some fetch implementations embed request
 * details (including headers) in a thrown error's message. Every error this
 * throws is a fixed, fixed-shape `AlertDeliveryError` built from an
 * allowlist (operation name, HTTP status, Discord code) — never from the
 * caught error's own message or `cause`.
 *
 * The abort signal is only a request to the fetch implementation; nothing
 * forces it to honor `signal` (an injected `fetchImpl`, or its body reader,
 * may ignore it entirely). So the fetch + body-read is raced against an
 * independent `setTimeout` that rejects with the same `TIMEOUT`
 * classification on its own — this bounds OUR wait regardless of whether the
 * implementation cooperates. We still call `controller.abort()` too, since
 * that is still the right thing for a well-behaved implementation; an
 * implementation that ignores it may simply leave its underlying request
 * running in the background, which we have no way to stop, only to stop
 * waiting on.
 */
async function post(
  fetchImpl: typeof fetch,
  url: string,
  token: string,
  payload: unknown,
  timeoutMs: number,
  op: 'open_dm' | 'send_message',
): Promise<ApiAttempt> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const timeoutError = new AlertDeliveryError('TIMEOUT', true, undefined, undefined, `Discord DM ${op} timed out after ${timeoutMs}ms`);
  let deadlineTimer!: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    deadlineTimer = setTimeout(() => reject(timeoutError), timeoutMs);
  });

  const attempt = (async (): Promise<ApiAttempt> => {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bot ${token}` },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    let json: unknown;
    try {
      json = await res.json();
    } catch (err) {
      if (controller.signal.aborted || isAbortError(err)) throw err;
      json = undefined;
    }

    const discordCode = extractDiscordCode(json);
    if (res.status === 429) {
      return { kind: 'rateLimited', retryAfterSec: parseRetryAfterSec(json, res.headers.get('retry-after')), discordCode };
    }
    if (!res.ok) {
      return { kind: 'error', status: res.status, discordCode };
    }
    return { kind: 'ok', json };
  })();

  try {
    return await Promise.race([attempt, deadline]);
  } catch (err) {
    if (err === timeoutError) throw timeoutError;
    if (controller.signal.aborted || isAbortError(err)) {
      throw timeoutError;
    }
    // NEVER include the caught error's own message/cause — see the doc
    // comment above. redactBotToken is applied anyway as a last line of
    // defense in case that discipline is ever broken by a future edit.
    throw new AlertDeliveryError('NETWORK', true, undefined, undefined, redactBotToken(`Discord DM ${op} failed: network error`, token));
  } finally {
    clearTimeout(timer);
    clearTimeout(deadlineTimer);
  }
}

function classifyApiError(op: 'open_dm' | 'send_message', status: number, discordCode: number | undefined, destinationId: string | undefined): AlertDeliveryError {
  if (discordCode !== undefined && NO_LOCAL_RETRY_CODES.has(discordCode)) {
    return new AlertDeliveryError('RATE_LIMITED', true, destinationId, undefined, `Discord DM ${op} rate-limited (code ${discordCode})`);
  }
  if (status >= 500) {
    return new AlertDeliveryError('SERVER_ERROR', true, destinationId, undefined, `Discord DM ${op} failed with status ${status}`);
  }
  const codeSuffix = discordCode !== undefined ? `, code ${discordCode}` : '';
  return new AlertDeliveryError('DESTINATION_REJECTED', false, destinationId, undefined, `Discord DM ${op} rejected (status ${status}${codeSuffix})`);
}

// A Discord snowflake is a decimal integer, up to 20 digits (a `uint64` at
// most encodes 20 decimal digits). Anything else out of a channel-open
// response is a provider anomaly, not a real channel id — and, because this
// value is interpolated straight into the next request's URL and surfaced on
// the receipt/`onDegraded` payload, an unvalidated value could carry
// something sensitive that a malformed or compromised response echoed back.
const SNOWFLAKE_RE = /^\d{1,20}$/;

/**
 * Validate the DM channel-open response's `id` as a decimal Discord
 * snowflake before using it — never trust it blindly. A response shaped like
 * `{id: "<something sensitive>"}` must never reach the message-POST URL or
 * be exposed via the receipt/`onDegraded`, so the rejected value itself is
 * never included in the thrown error.
 */
function extractChannelId(json: unknown): string {
  const id = json && typeof json === 'object' ? (json as { id?: unknown }).id : undefined;
  if (typeof id !== 'string' || !SNOWFLAKE_RE.test(id)) {
    throw new AlertDeliveryError('SERVER_ERROR', true, undefined, undefined, 'Discord DM open_dm returned an unexpected response (invalid channel id)');
  }
  return id;
}

/**
 * Create a Discord bot-DM transport: opens (or reuses, per Discord) a DM
 * channel with a fixed recipient and posts the alert embed into it via the
 * bot's own REST credentials — no dependency on any webhook or on the host
 * app's own API process. Config is read lazily, same as the webhook
 * transport.
 */
export function createDiscordDmTransport(options: DiscordDmTransportOptions = {}): AlertTransport {
  // `severity` is accepted (per `AlertTransport`) but unused: there is no
  // per-severity routing for a single DM recipient — "configured" means only
  // "a token and a recipient id both resolve".
  const isConfigured = (_severity?: Severity): boolean => {
    const config = resolveConfig(options);
    return Boolean(config.botToken) && Boolean(config.userId);
  };

  const deliver = async (alert: Alert): Promise<AlertDeliveryReceipt> => {
    const config = resolveConfig(options);
    if (!config.botToken || !config.userId) {
      throw new AlertDeliveryError('UNCONFIGURED', false, undefined, undefined, 'Discord DM transport is not configured (missing bot token or recipient user id)');
    }
    const token = config.botToken;
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;

    const startedAt = Date.now();
    const remainingMs = (): number => config.deadlineMs - (Date.now() - startedAt);
    const nextTimeout = (op: 'open_dm' | 'send_message'): number => {
      const remaining = remainingMs();
      if (remaining <= 0) {
        throw new AlertDeliveryError('TIMEOUT', true, undefined, undefined, `Discord DM ${op} exceeded the overall deadline (${config.deadlineMs}ms)`);
      }
      return Math.min(config.timeoutMs, remaining);
    };

    // --- open (or reuse, per Discord) the DM channel ---
    const openChannel = (): Promise<ApiAttempt> =>
      post(fetchImpl, `${API_BASE}/users/@me/channels`, token, { recipient_id: config.userId }, nextTimeout('open_dm'), 'open_dm');

    let openResult = await openChannel();
    if (openResult.kind === 'rateLimited') {
      if (openResult.discordCode !== undefined && NO_LOCAL_RETRY_CODES.has(openResult.discordCode)) {
        throw new AlertDeliveryError('RATE_LIMITED', true, undefined, undefined, `Discord DM open_dm rate-limited (code ${openResult.discordCode})`);
      }
      const delayMs = openResult.retryAfterSec * 1000;
      if (delayMs >= remainingMs()) {
        throw new AlertDeliveryError('RATE_LIMITED', true, undefined, delayMs, 'Discord DM open_dm rate-limited; retry would exceed the overall deadline');
      }
      await delay(delayMs);
      openResult = await openChannel();
    }
    if (openResult.kind === 'rateLimited') {
      throw new AlertDeliveryError('RATE_LIMITED', true, undefined, openResult.retryAfterSec * 1000, 'Discord DM open_dm rate-limited (429)');
    }
    if (openResult.kind === 'error') {
      throw classifyApiError('open_dm', openResult.status, openResult.discordCode, undefined);
    }
    const channelId = extractChannelId(openResult.json);

    // --- send the alert embed ---
    const body = { embeds: [buildEmbed({ ...alert, service: alert.service ?? config.service }, DEFAULT_COLORS)] };
    const sendMessage = (): Promise<ApiAttempt> =>
      post(fetchImpl, `${API_BASE}/channels/${channelId}/messages`, token, body, nextTimeout('send_message'), 'send_message');

    let attempts = 1;
    let sendResult = await sendMessage();
    if (sendResult.kind === 'rateLimited') {
      if (sendResult.discordCode !== undefined && NO_LOCAL_RETRY_CODES.has(sendResult.discordCode)) {
        throw new AlertDeliveryError('RATE_LIMITED', true, channelId, undefined, `Discord DM send_message rate-limited (code ${sendResult.discordCode})`);
      }
      const delayMs = sendResult.retryAfterSec * 1000;
      if (delayMs >= remainingMs()) {
        throw new AlertDeliveryError('RATE_LIMITED', true, channelId, delayMs, 'Discord DM send_message rate-limited; retry would exceed the overall deadline');
      }
      await delay(delayMs);
      attempts++;
      sendResult = await sendMessage();
    }
    if (sendResult.kind === 'rateLimited') {
      throw new AlertDeliveryError('RATE_LIMITED', true, channelId, sendResult.retryAfterSec * 1000, 'Discord DM send_message rate-limited (429)');
    }
    if (sendResult.kind === 'error') {
      throw classifyApiError('send_message', sendResult.status, sendResult.discordCode, channelId);
    }

    return { destinationId: channelId, attempts };
  };

  return { isConfigured, deliver, async send(alert) { await deliver(alert); } };
}
