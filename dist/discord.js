"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.redactWebhookUrl = redactWebhookUrl;
exports.createDiscordTransport = createDiscordTransport;
const types_1 = require("./types");
const discord_internal_1 = require("./discord-internal");
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_RETRY_AFTER_SEC = 60;
/** Parse the non-secret webhook id out of a Discord webhook URL's `.../webhooks/{id}/{token}` shape. */
function parseWebhookId(url) {
    const match = url.match(/\/webhooks\/([^/]+)\/([^/?#]+)/);
    return match?.[1];
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
function resolveFleetDefault(env) {
    return env.DISCORD_ALERT_WEBHOOK?.trim() || undefined;
}
function resolveRoutes(options) {
    const env = options.env ?? process.env;
    const primary = options.webhookUrl?.trim() || env.DISCORD_WEBHOOK_URL?.trim() || undefined;
    const bySeverity = {
        info: options.severityWebhookUrls?.info?.trim() || env.DISCORD_WEBHOOK_URL_INFO?.trim() || undefined,
        warn: options.severityWebhookUrls?.warn?.trim() || env.DISCORD_WEBHOOK_URL_WARN?.trim() || undefined,
        error: options.severityWebhookUrls?.error?.trim() || env.DISCORD_WEBHOOK_URL_ERROR?.trim() || undefined,
        critical: options.severityWebhookUrls?.critical?.trim() || env.DISCORD_WEBHOOK_URL_CRITICAL?.trim() || undefined,
    };
    return { primary, bySeverity, fleetDefault: resolveFleetDefault(env) };
}
/** service/username/timeoutMs/colors, resolved lazily per call so late `dotenv` population isn't silently dropped. */
function resolveConfig(options) {
    const env = options.env ?? process.env;
    return {
        service: options.service?.trim() || env.DISCORD_ALERT_SERVICE?.trim() || undefined,
        username: options.username?.trim() || env.DISCORD_ALERT_USERNAME?.trim() || undefined,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        totalTimeoutMs: options.totalTimeoutMs,
        colors: {
            info: (0, discord_internal_1.sanitizeColor)(options.colors?.info, discord_internal_1.DEFAULT_COLORS.info),
            warn: (0, discord_internal_1.sanitizeColor)(options.colors?.warn, discord_internal_1.DEFAULT_COLORS.warn),
            error: (0, discord_internal_1.sanitizeColor)(options.colors?.error, discord_internal_1.DEFAULT_COLORS.error),
            critical: (0, discord_internal_1.sanitizeColor)(options.colors?.critical, discord_internal_1.DEFAULT_COLORS.critical),
        },
    };
}
/** `err.message` if it is an Error, else a safe stringification. Never throws. */
function describeError(err) {
    if (err instanceof Error)
        return `${err.name}: ${err.message}`;
    try {
        return String(err);
    }
    catch {
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
function redactWebhookUrl(text, url) {
    let out = String(text);
    if (url && url.length > 0)
        out = out.split(url).join('<redacted-webhook-url>');
    out = out.replace(/https?:\/\/\S*?\/webhooks\/\S+/gi, '<redacted-webhook-url>');
    out = out.replace(/\bdiscord(?:app)?\.com\/api\/webhooks\/\S+/gi, '<redacted-webhook-url>');
    return out;
}
async function readRetryAfterSec(res, signal) {
    let raw = NaN;
    const header = res.headers.get('retry-after');
    if (header && !Number.isNaN(Number(header))) {
        raw = Number(header);
    }
    else {
        try {
            const body = (await res.clone().json());
            if (typeof body.retry_after === 'number')
                raw = body.retry_after;
        }
        catch (err) {
            // An aborted (timed-out) body read must propagate as a timeout, never
            // be swallowed into "no retry_after found" — that would fall back to
            // the 1s default and let `send()` fire a second POST instead of
            // failing with the timeout.
            if (signal.aborted || (0, discord_internal_1.isAbortError)(err))
                throw err;
            // body wasn't JSON with retry_after — fall through to the default below.
        }
    }
    return Math.min(Math.max(Number.isFinite(raw) ? raw : 1, 0), MAX_RETRY_AFTER_SEC);
}
/**
 * One bounded POST attempt: the AbortController/timer covers fetch AND
 * whatever body read this attempt needs (json for a 429, text for any other
 * non-2xx) — a slow response body must not be able to hang the caller past
 * `timeoutMs` any more than slow headers can.
 */
async function attempt(url, body, fetchImpl, timeoutMs) {
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
            let snippet;
            try {
                snippet = (await res.text()).slice(0, 300);
            }
            catch (err) {
                // An aborted (timed-out) body read must propagate as a timeout, not
                // be mislabeled as an HTTP failure with an empty/blank snippet — the
                // real cause (a timeout) would otherwise be lost behind a
                // `status ${res.status}` message.
                if (controller.signal.aborted || (0, discord_internal_1.isAbortError)(err))
                    throw err;
                snippet = '';
            }
            return { kind: 'error', status: res.status, snippet };
        }
        return { kind: 'ok' };
    }
    catch (err) {
        // Normalize all three abort paths (fetch itself rejecting, the 429 body
        // read, and the non-2xx body read) to the same clear timeout error,
        // rather than letting whatever AbortError shape happened to surface leak
        // out (or, worse, get relabeled as an HTTP status above).
        if (controller.signal.aborted || (0, discord_internal_1.isAbortError)(err)) {
            throw new Error(`Discord webhook POST timed out after ${timeoutMs}ms`);
        }
        // NEVER rethrow a raw fetch error. The webhook URL is a bearer credential,
        // and fetch embeds it in some errors — a scheme-less URL yields
        // `TypeError: Failed to parse URL from discord.com/api/webhooks/<id>/<TOKEN>`.
        // Callers routinely log `error.message`, so a raw rethrow puts the token in
        // application logs. Redact before it ever leaves this function.
        throw new Error(`Discord webhook POST failed: ${redactWebhookUrl(describeError(err), url)}`);
    }
    finally {
        clearTimeout(timer);
    }
}
/** Create a Discord transport bound to the given options. Config is read lazily. */
function createDiscordTransport(options = {}) {
    const isConfigured = (severity) => {
        const { primary, bySeverity, fleetDefault } = resolveRoutes(options);
        if (severity)
            return Boolean(bySeverity[severity] ?? primary ?? fleetDefault);
        return Boolean(primary) || Object.values(bySeverity).some(Boolean) || Boolean(fleetDefault);
    };
    // Resolution order, most to least specific: an explicit per-severity URL,
    // then the explicit/env-sourced primary, then — only once both of those
    // are exhausted for this severity — the fleet-wide default. An
    // explicitly-provided URL (argument/option OR the existing per-app
    // DISCORD_WEBHOOK_URL* env vars folded into `primary`/`bySeverity` by
    // `resolveRoutes`) always wins over the fleet default.
    const resolveRoute = (severity) => {
        const { primary, bySeverity, fleetDefault } = resolveRoutes(options);
        return bySeverity[severity] ?? primary ?? fleetDefault;
    };
    const deliver = async (alert) => {
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
            }
            catch (err) {
                console.error(`alert-kit: onSkipped callback threw: ${redactWebhookUrl(describeError(err))}`);
            }
            throw new types_1.AlertDeliveryError('UNCONFIGURED', false, undefined, undefined, `No Discord webhook route configured for severity "${alert.severity}"`);
        }
        const validateRoute = async () => {
            if (options.validateUrl)
                await options.validateUrl(route);
        };
        const config = resolveConfig(options);
        const retryOn429 = options.retryOn429 ?? true;
        const fetchImpl = options.fetchImpl ?? globalThis.fetch;
        const body = {
            ...(config.username ? { username: config.username } : {}),
            embeds: [(0, discord_internal_1.buildEmbed)({ ...alert, service: alert.service ?? config.service }, config.colors)],
        };
        const startedAt = Date.now();
        const remainingMs = () => {
            if (config.totalTimeoutMs === undefined)
                return config.timeoutMs;
            return config.totalTimeoutMs - (Date.now() - startedAt);
        };
        const destinationId = parseWebhookId(route);
        const attemptTimeout = () => {
            const remaining = remainingMs();
            if (remaining <= 0)
                throw new types_1.AlertDeliveryError('TIMEOUT', true, destinationId, undefined, `Discord webhook total deadline exceeded after ${config.totalTimeoutMs}ms`);
            return Math.min(config.timeoutMs, remaining);
        };
        let attempts = 1;
        let result;
        await validateRoute();
        try {
            result = await attempt(route, body, fetchImpl, attemptTimeout());
        }
        catch (error) {
            throw classifyThrown(error, destinationId);
        }
        if (result.kind === 'rateLimited' && retryOn429) {
            const delayMs = result.retryAfterSec * 1000;
            if (config.totalTimeoutMs !== undefined && delayMs >= remainingMs()) {
                throw new types_1.AlertDeliveryError('RATE_LIMITED', true, destinationId, delayMs, `Discord webhook total deadline exceeded after ${config.totalTimeoutMs}ms`);
            }
            await (0, discord_internal_1.delay)(delayMs);
            // Revalidate immediately before the retry POST too — same guard rail,
            // every attempt, not just the first. A redirect or a mutated route
            // between attempts is exactly what this hook exists to catch, and a
            // validation failure here must surface unwrapped, the same as the
            // first attempt's (i.e. NOT run inside the `attempt()` try/catch
            // below, which reclassifies errors via `classifyThrown`).
            await validateRoute();
            attempts++;
            try {
                result = await attempt(route, body, fetchImpl, attemptTimeout());
            }
            catch (error) {
                throw classifyThrown(error, destinationId);
            }
        }
        if (result.kind === 'rateLimited') {
            throw new types_1.AlertDeliveryError('RATE_LIMITED', true, destinationId, result.retryAfterSec * 1000);
        }
        if (result.kind === 'error') {
            throw new types_1.AlertDeliveryError(result.status >= 500 ? 'SERVER_ERROR' : 'DESTINATION_REJECTED', result.status >= 500, destinationId, undefined, `Discord webhook POST failed with status ${result.status}`);
        }
        // A host callback must not be able to turn a completed delivery into a
        // failure: Discord already accepted the POST by this point, so an
        // `onSent` throw is contained (logged, redacted) rather than allowed to
        // reject `deliver()`/`send()` — otherwise the caller would see a
        // failure and retry a delivery that genuinely succeeded, causing a
        // duplicate alert.
        try {
            options.onSent?.({ severity: alert.severity, title: alert.title, webhookId: destinationId });
        }
        catch (err) {
            console.error(`alert-kit: onSent callback threw: ${redactWebhookUrl(describeError(err), route)}`);
        }
        return { destinationId, attempts };
    };
    return { isConfigured, deliver, async send(alert) { await deliver(alert); } };
}
function classifyThrown(error, destinationId) {
    const message = error instanceof Error ? error.message : '';
    return new types_1.AlertDeliveryError(message.includes('timed out') || message.includes('deadline') ? 'TIMEOUT' : 'NETWORK', true, destinationId, undefined, message);
}
