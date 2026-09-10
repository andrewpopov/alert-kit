import { AlertDeliveryError, type Alert, type AlertDeliveryReceipt, type AlertTransport, type Severity } from './types';
import { buildEmbed, DEFAULT_COLORS, delay, isAbortError, sanitizeColor, type DiscordEmbed } from './discord-internal';

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RETRY_AFTER_SEC = 60;

interface DiscordWebhookBody {
  username?: string;
  embeds: DiscordEmbed[];
}

/** Parse the non-secret webhook id out of a Discord webhook URL's `.../webhooks/{id}/{token}` shape. */
function parseWebhookId(url: string): string | undefined {
  const match = url.match(/\/webhooks\/([^/]+)\/([^/?#]+)/);
  return match?.[1];
}

export interface DiscordTransportOptions {
  /** Config source. Defaults to `process.env`. Read lazily on every call. */
  env?: Record<string, string | undefined>;
  /**
   * Primary webhook URL, used when a severity has no dedicated route. Else
   * `env.DISCORD_WEBHOOK_URL`. If neither resolves for a given severity —
   * no `severityWebhookUrls`/env override AND no primary — the fleet-wide
   * default in `env.DISCORD_ALERT_WEBHOOK` is used as a last resort before
   * giving up. See `resolveRoutes` below.
   */
  webhookUrl?: string;
  /** Per-severity webhook URLs. Else `env.DISCORD_WEBHOOK_URL_INFO|_WARN|_ERROR|_CRITICAL`. */
  severityWebhookUrls?: Partial<Record<Severity, string>>;
  /** Service name shown in the embed footer. Else `env.DISCORD_ALERT_SERVICE`. */
  service?: string;
  /** Webhook display username. Else `env.DISCORD_ALERT_USERNAME`. */
  username?: string;
  /** Per-request timeout. Default 10_000ms. Always bounded — an unbounded alert POST can hang a request/deploy forever. */
  timeoutMs?: number;
  /** Optional total deadline covering the initial POST, 429 wait, and retry. */
  totalTimeoutMs?: number;
  /** Override the default per-severity embed colors. */
  colors?: Partial<Record<Severity, number>>;
  /** Retry once on HTTP 429, honoring `retry_after`. Default true. */
  retryOn429?: boolean;
  /** fetch override — test seam. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /**
   * Called after a successful POST. `webhookId` is the non-secret id segment
   * parsed out of the webhook URL (`undefined` if the URL doesn't match the
   * expected shape) — the full URL, which embeds a bearer token, is
   * deliberately withheld. Delivery has already succeeded by the time this
   * runs: a thrown/rejected `onSent` is caught and logged (via
   * `console.error`, redacted), never allowed to turn a completed delivery
   * into a rejected `send()`/`deliver()`.
   */
  onSent?: (info: { severity: Severity; title: string; webhookId: string | undefined }) => void;
  /** Called when an alert's severity has no configured route (transport still throws). */
  onSkipped?: (info: { severity: Severity; title: string }) => void;
  /**
   * Optional guard rail run against the resolved destination URL immediately
   * before every POST. Every consumer today passes a trusted env-sourced
   * URL, so this is unused by default — no validation unless a consumer
   * opts in. It exists so a FUTURE consumer that accepts a user-supplied
   * webhook URL has somewhere to plug in an SSRF check (e.g.
   * `@andrewpopov/url-guard`'s `assertSafeUrl`) without alert-kit growing
   * its own SSRF stack. Throw (or reject) to block the send; the rejection
   * propagates out of `send()` unchanged.
   */
  validateUrl?: (url: string) => void | Promise<void>;
}

/**
 * Fleet-wide default webhook, read from `env.DISCORD_ALERT_WEBHOOK` (via the
 * same `options.env ?? process.env` source as every other var here — so it
 * stays testable via `options.env`/`vi.stubEnv`, not raw `process.env`).
 *
 * This is a DELIBERATE env-coupling, not an accidental one: it lets every
 * consumer on the fleet get a working Discord alert channel with ZERO
 * per-app config, by relying on a convention-named var set once at the
 * fleet level, rather than requiring each app to thread a `webhookUrl`
 * through. It is the last resort in the resolution order — an explicit
 * `webhookUrl`/`severityWebhookUrls` option, or the existing per-app
 * `env.DISCORD_WEBHOOK_URL*` vars, always win over it. See `resolveRoutes`.
 */
function resolveFleetDefault(env: Record<string, string | undefined>): string | undefined {
  return env.DISCORD_ALERT_WEBHOOK?.trim() || undefined;
}

function resolveRoutes(options: DiscordTransportOptions): {
  primary: string | undefined;
  bySeverity: Partial<Record<Severity, string>>;
  fleetDefault: string | undefined;
} {
  const env = options.env ?? process.env;
  const primary = options.webhookUrl?.trim() || env.DISCORD_WEBHOOK_URL?.trim() || undefined;
  const bySeverity: Partial<Record<Severity, string>> = {
    info: options.severityWebhookUrls?.info?.trim() || env.DISCORD_WEBHOOK_URL_INFO?.trim() || undefined,
    warn: options.severityWebhookUrls?.warn?.trim() || env.DISCORD_WEBHOOK_URL_WARN?.trim() || undefined,
    error: options.severityWebhookUrls?.error?.trim() || env.DISCORD_WEBHOOK_URL_ERROR?.trim() || undefined,
    critical:
      options.severityWebhookUrls?.critical?.trim() || env.DISCORD_WEBHOOK_URL_CRITICAL?.trim() || undefined,
  };
  return { primary, bySeverity, fleetDefault: resolveFleetDefault(env) };
}

/** service/username/timeoutMs/colors, resolved lazily per call so late `dotenv` population isn't silently dropped. */
function resolveConfig(options: DiscordTransportOptions): {
  service: string | undefined;
  username: string | undefined;
  timeoutMs: number;
  totalTimeoutMs: number | undefined;
  colors: Record<Severity, number>;
} {
  const env = options.env ?? process.env;
  return {
    service: options.service?.trim() || env.DISCORD_ALERT_SERVICE?.trim() || undefined,
    username: options.username?.trim() || env.DISCORD_ALERT_USERNAME?.trim() || undefined,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    totalTimeoutMs: options.totalTimeoutMs,
    colors: {
      info: sanitizeColor(options.colors?.info, DEFAULT_COLORS.info),
      warn: sanitizeColor(options.colors?.warn, DEFAULT_COLORS.warn),
      error: sanitizeColor(options.colors?.error, DEFAULT_COLORS.error),
      critical: sanitizeColor(options.colors?.critical, DEFAULT_COLORS.critical),
    },
  };
}

/** `err.message` if it is an Error, else a safe stringification. Never throws. */
function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  try {
    return String(err);
  } catch {
    return 'unknown error';
  }
}

/**
 * Strip the webhook URL (a bearer credential) out of any text before it can be
 * logged. Redacts the exact URL we were given, plus anything webhook-shaped, so
 * a mangled or partially-quoted variant can't slip through.
 *
 * Takes `unknown`, not `string`, and coerces. Every real call site is a catch
 * block doing `redactWebhookUrl(err.message ?? err, url)`, where the value is a
 * string only when something threw an Error with a message — a thrown object,
 * a rejected `undefined`, or a numeric exit status all arrive as non-strings. If
 * this threw on those, it would throw from INSIDE the error handler of the very
 * alert that was reporting the original failure, and a redaction helper that
 * turns a logged failure into an unhandled one is worse than no helper.
 * db-backup's copy coerced from the start; this is that behaviour folded back in.
 */
export function redactWebhookUrl(text: unknown, url?: string): string {
  let out = String(text);
  if (url && url.length > 0) out = out.split(url).join('<redacted-webhook-url>');
  out = out.replace(/https?:\/\/\S*?\/webhooks\/\S+/gi, '<redacted-webhook-url>');
  out = out.replace(/\bdiscord(?:app)?\.com\/api\/webhooks\/\S+/gi, '<redacted-webhook-url>');
  return out;
}

async function readRetryAfterSec(res: Response, signal: AbortSignal): Promise<number> {
  let raw = NaN;
  const header = res.headers.get('retry-after');
  if (header && !Number.isNaN(Number(header))) {
    raw = Number(header);
  } else {
    try {
      const body = (await res.clone().json()) as { retry_after?: number };
      if (typeof body.retry_after === 'number') raw = body.retry_after;
    } catch (err) {
      // An aborted (timed-out) body read must propagate as a timeout, never
      // be swallowed into "no retry_after found" — that would fall back to
      // the 1s default and let `send()` fire a second POST instead of
      // failing with the timeout.
      if (signal.aborted || isAbortError(err)) throw err;
      // body wasn't JSON with retry_after — fall through to the default below.
    }
  }
  return Math.min(Math.max(Number.isFinite(raw) ? raw : 1, 0), MAX_RETRY_AFTER_SEC);
}

type Attempt =
  | { kind: 'ok' }
  | { kind: 'rateLimited'; retryAfterSec: number }
  | { kind: 'error'; status: number; snippet: string };

/**
 * One bounded POST attempt: the AbortController/timer covers fetch AND
 * whatever body read this attempt needs (json for a 429, text for any other
 * non-2xx) — a slow response body must not be able to hang the caller past
 * `timeoutMs` any more than slow headers can.
 */
async function attempt(
  url: string,
  body: DiscordWebhookBody,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<Attempt> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (res.status === 429) {
      return { kind: 'rateLimited', retryAfterSec: await readRetryAfterSec(res, controller.signal) };
    }
    if (!res.ok) {
      let snippet: string;
      try {
        snippet = (await res.text()).slice(0, 300);
      } catch (err) {
        // An aborted (timed-out) body read must propagate as a timeout, not
        // be mislabeled as an HTTP failure with an empty/blank snippet — the
        // real cause (a timeout) would otherwise be lost behind a
        // `status ${res.status}` message.
        if (controller.signal.aborted || isAbortError(err)) throw err;
        snippet = '';
      }
      return { kind: 'error', status: res.status, snippet };
    }
    return { kind: 'ok' };
  } catch (err) {
    // Normalize all three abort paths (fetch itself rejecting, the 429 body
    // read, and the non-2xx body read) to the same clear timeout error,
    // rather than letting whatever AbortError shape happened to surface leak
    // out (or, worse, get relabeled as an HTTP status above).
    if (controller.signal.aborted || isAbortError(err)) {
      throw new Error(`Discord webhook POST timed out after ${timeoutMs}ms`);
    }
    // NEVER rethrow a raw fetch error. The webhook URL is a bearer credential,
    // and fetch embeds it in some errors — a scheme-less URL yields
    // `TypeError: Failed to parse URL from discord.com/api/webhooks/<id>/<TOKEN>`.
    // Callers routinely log `error.message`, so a raw rethrow puts the token in
    // application logs. Redact before it ever leaves this function.
    throw new Error(`Discord webhook POST failed: ${redactWebhookUrl(describeError(err), url)}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Create a Discord transport bound to the given options. Config is read lazily. */
export function createDiscordTransport(options: DiscordTransportOptions = {}): AlertTransport {
  const isConfigured = (severity?: Severity): boolean => {
    const { primary, bySeverity, fleetDefault } = resolveRoutes(options);
    if (severity) return Boolean(bySeverity[severity] ?? primary ?? fleetDefault);
    return Boolean(primary) || Object.values(bySeverity).some(Boolean) || Boolean(fleetDefault);
  };

  // Resolution order, most to least specific: an explicit per-severity URL,
  // then the explicit/env-sourced primary, then — only once both of those
  // are exhausted for this severity — the fleet-wide default. An
  // explicitly-provided URL (argument/option OR the existing per-app
  // DISCORD_WEBHOOK_URL* env vars folded into `primary`/`bySeverity` by
  // `resolveRoutes`) always wins over the fleet default.
  const resolveRoute = (severity: Severity): string | undefined => {
    const { primary, bySeverity, fleetDefault } = resolveRoutes(options);
    return bySeverity[severity] ?? primary ?? fleetDefault;
  };

  const deliver = async (alert: Alert): Promise<AlertDeliveryReceipt> => {
      const route = resolveRoute(alert.severity);
      if (!route) {
        // Contained for the same reason as `onSkipped` in alerter.ts, and for
        // one more: an escaping callback error would REPLACE the
        // AlertDeliveryError below, and UNCONFIGURED is precisely the code
        // `alertBestEffort` keys on to return `{ sent: false }` without
        // throwing. A host's logging bug would otherwise turn "nothing is
        // configured" into a hard failure.
        try {
          options.onSkipped?.({ severity: alert.severity, title: alert.title });
        } catch (err) {
          console.error(`alert-kit: onSkipped callback threw: ${describeError(err)}`);
        }
        throw new AlertDeliveryError('UNCONFIGURED', false, undefined, undefined, `No Discord webhook route configured for severity "${alert.severity}"`);
      }
      const validateRoute = async (): Promise<void> => {
        if (options.validateUrl) await options.validateUrl(route);
      };

      const config = resolveConfig(options);
      const retryOn429 = options.retryOn429 ?? true;
      const fetchImpl = options.fetchImpl ?? globalThis.fetch;
      const body: DiscordWebhookBody = {
        ...(config.username ? { username: config.username } : {}),
        embeds: [buildEmbed({ ...alert, service: alert.service ?? config.service }, config.colors)],
      };

      const startedAt = Date.now();
      const remainingMs = (): number => {
        if (config.totalTimeoutMs === undefined) return config.timeoutMs;
        return config.totalTimeoutMs - (Date.now() - startedAt);
      };
      const destinationId = parseWebhookId(route);
      const attemptTimeout = (): number => {
        const remaining = remainingMs();
        if (remaining <= 0) throw new AlertDeliveryError('TIMEOUT', true, destinationId, undefined, `Discord webhook total deadline exceeded after ${config.totalTimeoutMs}ms`);
        return Math.min(config.timeoutMs, remaining);
      };

      let attempts = 1;
      let result: Attempt;
      await validateRoute();
      try { result = await attempt(route, body, fetchImpl, attemptTimeout()); }
      catch (error) { throw classifyThrown(error, destinationId); }
      if (result.kind === 'rateLimited' && retryOn429) {
        const delayMs = result.retryAfterSec * 1000;
        if (config.totalTimeoutMs !== undefined && delayMs >= remainingMs()) {
          throw new AlertDeliveryError('RATE_LIMITED', true, destinationId, delayMs, `Discord webhook total deadline exceeded after ${config.totalTimeoutMs}ms`);
        }
        await delay(delayMs);
        // Revalidate immediately before the retry POST too — same guard rail,
        // every attempt, not just the first. A redirect or a mutated route
        // between attempts is exactly what this hook exists to catch, and a
        // validation failure here must surface unwrapped, the same as the
        // first attempt's (i.e. NOT run inside the `attempt()` try/catch
        // below, which reclassifies errors via `classifyThrown`).
        await validateRoute();
        attempts++;
        try { result = await attempt(route, body, fetchImpl, attemptTimeout()); }
        catch (error) { throw classifyThrown(error, destinationId); }
      }

      if (result.kind === 'rateLimited') {
        throw new AlertDeliveryError('RATE_LIMITED', true, destinationId, result.retryAfterSec * 1000);
      }
      if (result.kind === 'error') {
        throw new AlertDeliveryError(result.status >= 500 ? 'SERVER_ERROR' : 'DESTINATION_REJECTED', result.status >= 500, destinationId, undefined, `Discord webhook POST failed with status ${result.status}`);
      }

      // A host callback must not be able to turn a completed delivery into a
      // failure: Discord already accepted the POST by this point, so an
      // `onSent` throw is contained (logged, redacted) rather than allowed to
      // reject `deliver()`/`send()` — otherwise the caller would see a
      // failure and retry a delivery that genuinely succeeded, causing a
      // duplicate alert.
      try {
        options.onSent?.({ severity: alert.severity, title: alert.title, webhookId: destinationId });
      } catch (err) {
        console.error(`alert-kit: onSent callback threw: ${redactWebhookUrl(describeError(err), route)}`);
      }
      return { destinationId, attempts };
  };
  return { isConfigured, deliver, async send(alert) { await deliver(alert); } };
}

function classifyThrown(error: unknown, destinationId: string | undefined): AlertDeliveryError {
  const message = error instanceof Error ? error.message : '';
  return new AlertDeliveryError(message.includes('timed out') || message.includes('deadline') ? 'TIMEOUT' : 'NETWORK', true, destinationId, undefined, message);
}
