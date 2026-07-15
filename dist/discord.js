"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.redactWebhookUrl = redactWebhookUrl;
exports.createDiscordTransport = createDiscordTransport;
const types_1 = require("./types");
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_RETRY_AFTER_SEC = 60;
// Discord's documented embed limits. We enforce them by TRUNCATING rather than
// dropping the alert or letting the request through — a 400 from Discord means
// the alert is lost entirely, which is worse than a shortened message.
const LIMITS = {
    title: 256,
    description: 4096,
    fieldName: 256,
    fieldValue: 1024,
    footerText: 2048,
    maxFields: 25,
};
// Discord's separate, AGGREGATE limit: total text across title + description
// + footer + every field name/value must be <= 6000 code points, even though
// each component individually fits its own per-component limit above (25
// max-length fields alone sum to ~32,000). Exceeding it gets the whole POST
// rejected with a 400 — losing the alert, the exact failure per-component
// truncation exists to prevent.
const MAX_EMBED_TOTAL = 6000;
const DEFAULT_COLORS = {
    info: 0x3498db,
    warn: 0xf1c40f,
    error: 0xe74c3c,
    critical: 0x992d22,
};
// Placeholder for a title/field name/field value that would otherwise be
// empty. Discord rejects an empty title, field name, or field value with a
// 400 — which loses the alert entirely, the same failure truncation above
// exists to prevent.
const EMPTY = '—';
function orPlaceholder(value) {
    return value.trim() === '' ? EMPTY : value;
}
function truncate(value, max) {
    if (value.length <= max)
        return value; // length is an upper bound on code-point count
    const codePoints = [...value];
    if (codePoints.length <= max)
        return value;
    if (max <= 0)
        return '';
    if (max === 1)
        return codePoints[0];
    return `${codePoints.slice(0, max - 1).join('')}…`;
}
function codePointLength(value) {
    return [...value].length;
}
function buildFields(fields) {
    if (!fields)
        return undefined;
    const entries = Object.entries(fields).slice(0, LIMITS.maxFields);
    if (entries.length === 0)
        return undefined;
    return entries.map(([name, value]) => ({
        name: truncate(orPlaceholder(name), LIMITS.fieldName),
        value: truncate(orPlaceholder(String(value)), LIMITS.fieldValue),
        inline: true,
    }));
}
function buildEmbed(alert, colors) {
    const fields = buildFields(alert.fields);
    const embed = {
        title: truncate(orPlaceholder(alert.title), LIMITS.title),
        ...(alert.message ? { description: truncate(alert.message, LIMITS.description) } : {}),
        color: colors[alert.severity],
        timestamp: (alert.timestamp ?? new Date()).toISOString(),
        ...(alert.service ? { footer: { text: truncate(alert.service, LIMITS.footerText) } } : {}),
        ...(fields ? { fields } : {}),
    };
    return fitEmbedToBudget(embed);
}
function embedTextTotal(embed) {
    let total = codePointLength(embed.title);
    if (embed.description)
        total += codePointLength(embed.description);
    if (embed.footer)
        total += codePointLength(embed.footer.text);
    if (embed.fields) {
        for (const field of embed.fields)
            total += codePointLength(field.name) + codePointLength(field.value);
    }
    return total;
}
/**
 * Enforce Discord's 6,000-code-point AGGREGATE embed limit (see
 * MAX_EMBED_TOTAL above) on top of the per-component caps already applied by
 * `buildEmbed`. Priority, most important first: title (already <=256, always
 * kept as-is) > footer/service (always kept as-is) > description (trimmed to
 * fit) > fields (dropped from the end, as a last resort, once the
 * description alone can't bring the total under budget).
 */
function fitEmbedToBudget(embed) {
    let total = embedTextTotal(embed);
    if (total <= MAX_EMBED_TOTAL)
        return embed;
    const result = { ...embed, fields: embed.fields ? [...embed.fields] : undefined };
    if (result.description && total > MAX_EMBED_TOTAL) {
        const overBy = total - MAX_EMBED_TOTAL;
        const descLen = codePointLength(result.description);
        const truncated = truncateToCodePoints(result.description, Math.max(0, descLen - overBy));
        total -= descLen - codePointLength(truncated);
        if (truncated) {
            result.description = truncated;
        }
        else {
            delete result.description;
        }
    }
    while (total > MAX_EMBED_TOTAL && result.fields && result.fields.length > 0) {
        const dropped = result.fields.pop();
        total -= codePointLength(dropped.name) + codePointLength(dropped.value);
    }
    if (result.fields && result.fields.length === 0)
        delete result.fields;
    if (total > MAX_EMBED_TOTAL && result.fields && result.fields.length > 0) {
        const last = result.fields[result.fields.length - 1];
        const overBy = total - MAX_EMBED_TOTAL;
        const valLen = codePointLength(last.value);
        const truncatedVal = truncateToCodePoints(last.value, Math.max(0, valLen - overBy));
        total -= valLen - codePointLength(truncatedVal);
        last.value = truncatedVal;
    }
    return result;
}
/** Truncate to an exact code-point length, no ellipsis (used for budget trimming, not display truncation). */
function truncateToCodePoints(value, max) {
    if (max <= 0)
        return '';
    const codePoints = [...value];
    if (codePoints.length <= max)
        return value;
    return codePoints.slice(0, max).join('');
}
function sanitizeColor(color, fallback) {
    if (color === undefined)
        return fallback;
    return Number.isInteger(color) && color >= 0x000000 && color <= 0xffffff ? color : fallback;
}
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
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
            info: sanitizeColor(options.colors?.info, DEFAULT_COLORS.info),
            warn: sanitizeColor(options.colors?.warn, DEFAULT_COLORS.warn),
            error: sanitizeColor(options.colors?.error, DEFAULT_COLORS.error),
            critical: sanitizeColor(options.colors?.critical, DEFAULT_COLORS.critical),
        },
    };
}
/** True for a native `AbortError` (fetch/body-read rejection from an aborted `AbortSignal`). */
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
 */
function redactWebhookUrl(text, url) {
    let out = text;
    if (url && url.length > 0)
        out = out.split(url).join('<redacted-webhook-url>');
    out = out.replace(/https?:\/\/\S*?\/webhooks\/\S+/gi, '<redacted-webhook-url>');
    out = out.replace(/\bdiscord(?:app)?\.com\/api\/webhooks\/\S+/gi, '<redacted-webhook-url>');
    return out;
}
function isAbortError(err) {
    return err instanceof Error && err.name === 'AbortError';
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
            if (signal.aborted || isAbortError(err))
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
                if (controller.signal.aborted || isAbortError(err))
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
        if (controller.signal.aborted || isAbortError(err)) {
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
            options.onSkipped?.({ severity: alert.severity, title: alert.title });
            throw new types_1.AlertDeliveryError('UNCONFIGURED', false, undefined, undefined, `No Discord webhook route configured for severity "${alert.severity}"`);
        }
        if (options.validateUrl) {
            await options.validateUrl(route);
        }
        const config = resolveConfig(options);
        const retryOn429 = options.retryOn429 ?? true;
        const fetchImpl = options.fetchImpl ?? globalThis.fetch;
        const body = {
            ...(config.username ? { username: config.username } : {}),
            embeds: [buildEmbed({ ...alert, service: alert.service ?? config.service }, config.colors)],
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
            await delay(delayMs);
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
        options.onSent?.({ severity: alert.severity, title: alert.title, webhookId: destinationId });
        return { destinationId, attempts };
    };
    return { isConfigured, deliver, async send(alert) { await deliver(alert); } };
}
function classifyThrown(error, destinationId) {
    const message = error instanceof Error ? error.message : '';
    return new types_1.AlertDeliveryError(message.includes('timed out') || message.includes('deadline') ? 'TIMEOUT' : 'NETWORK', true, destinationId, undefined, message);
}
