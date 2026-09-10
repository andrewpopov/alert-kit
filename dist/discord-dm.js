"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.redactBotToken = redactBotToken;
exports.createDiscordDmTransport = createDiscordDmTransport;
const types_1 = require("./types");
const discord_internal_1 = require("./discord-internal");
// Fixed, trusted API endpoints — never built from untrusted input. The bot
// token authenticates the request; there is no "webhook id" segment in the
// URL for this transport, so (unlike the webhook path) there is nothing
// destination-specific to validate before the POST.
const API_BASE = 'https://discord.com/api/v10';
// Per-request timeout: bounds a single HTTP call (channel open, message
// send, or a retry of either).
const DEFAULT_TIMEOUT_MS = 5000;
// Total operation deadline: bounds channel open + message POST + any 429
// retry wait, END TO END. Kept conservative (a few seconds) on purpose — the
// health monitor this transport exists for needs to fail fast enough that a
// caller still has time left to try a fallback transport before ITS OWN
// deadline runs out.
const DEFAULT_DEADLINE_MS = 8000;
// Discord error codes (distinct from HTTP status — read from the JSON body's
// numeric `code` field) that mean "rate limited" but must NOT be retried
// locally: the caller should fall back instead of burning its deadline on a
// bounded retry that Discord has already told us won't help soon.
const NO_LOCAL_RETRY_CODES = new Set([40003, 40004]);
/** service/userId/botToken/service, resolved lazily per call so late `dotenv` population isn't silently dropped. */
function resolveConfig(options) {
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
function redactBotToken(text, token) {
    let out = String(text);
    if (token && token.length > 0)
        out = out.split(token).join('<redacted-bot-token>');
    out = out.replace(/\bBot\s+\S{10,}/gi, 'Bot <redacted-bot-token>');
    return out;
}
function extractDiscordCode(json) {
    if (json && typeof json === 'object' && 'code' in json) {
        const code = json.code;
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
function parseRetryAfterSec(json, header) {
    let raw = NaN;
    if (header && !Number.isNaN(Number(header))) {
        raw = Number(header);
    }
    else if (json && typeof json === 'object' && 'retry_after' in json) {
        const value = json.retry_after;
        if (typeof value === 'number')
            raw = value;
    }
    return Math.max(Number.isFinite(raw) ? raw : 1, 0);
}
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
 */
async function post(fetchImpl, url, token, payload, timeoutMs, op) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetchImpl(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bot ${token}` },
            body: JSON.stringify(payload),
            signal: controller.signal,
        });
        let json;
        try {
            json = await res.json();
        }
        catch (err) {
            if (controller.signal.aborted || (0, discord_internal_1.isAbortError)(err))
                throw err;
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
    }
    catch (err) {
        if (controller.signal.aborted || (0, discord_internal_1.isAbortError)(err)) {
            throw new types_1.AlertDeliveryError('TIMEOUT', true, undefined, undefined, `Discord DM ${op} timed out after ${timeoutMs}ms`);
        }
        // NEVER include the caught error's own message/cause — see the doc
        // comment above. redactBotToken is applied anyway as a last line of
        // defense in case that discipline is ever broken by a future edit.
        throw new types_1.AlertDeliveryError('NETWORK', true, undefined, undefined, redactBotToken(`Discord DM ${op} failed: network error`, token));
    }
    finally {
        clearTimeout(timer);
    }
}
function classifyApiError(op, status, discordCode, destinationId) {
    if (discordCode !== undefined && NO_LOCAL_RETRY_CODES.has(discordCode)) {
        return new types_1.AlertDeliveryError('RATE_LIMITED', true, destinationId, undefined, `Discord DM ${op} rate-limited (code ${discordCode})`);
    }
    if (status >= 500) {
        return new types_1.AlertDeliveryError('SERVER_ERROR', true, destinationId, undefined, `Discord DM ${op} failed with status ${status}`);
    }
    const codeSuffix = discordCode !== undefined ? `, code ${discordCode}` : '';
    return new types_1.AlertDeliveryError('DESTINATION_REJECTED', false, destinationId, undefined, `Discord DM ${op} rejected (status ${status}${codeSuffix})`);
}
/** Validate the DM channel-open response's `id` as a plain, non-empty string — never trust it blindly. */
function extractChannelId(json) {
    const id = json && typeof json === 'object' ? json.id : undefined;
    if (typeof id !== 'string' || id.length === 0) {
        throw new types_1.AlertDeliveryError('SERVER_ERROR', true, undefined, undefined, 'Discord DM open_dm returned an unexpected response (missing channel id)');
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
function createDiscordDmTransport(options = {}) {
    // `severity` is accepted (per `AlertTransport`) but unused: there is no
    // per-severity routing for a single DM recipient — "configured" means only
    // "a token and a recipient id both resolve".
    const isConfigured = (_severity) => {
        const config = resolveConfig(options);
        return Boolean(config.botToken) && Boolean(config.userId);
    };
    const deliver = async (alert) => {
        const config = resolveConfig(options);
        if (!config.botToken || !config.userId) {
            throw new types_1.AlertDeliveryError('UNCONFIGURED', false, undefined, undefined, 'Discord DM transport is not configured (missing bot token or recipient user id)');
        }
        const token = config.botToken;
        const fetchImpl = options.fetchImpl ?? globalThis.fetch;
        const startedAt = Date.now();
        const remainingMs = () => config.deadlineMs - (Date.now() - startedAt);
        const nextTimeout = (op) => {
            const remaining = remainingMs();
            if (remaining <= 0) {
                throw new types_1.AlertDeliveryError('TIMEOUT', true, undefined, undefined, `Discord DM ${op} exceeded the overall deadline (${config.deadlineMs}ms)`);
            }
            return Math.min(config.timeoutMs, remaining);
        };
        // --- open (or reuse, per Discord) the DM channel ---
        const openChannel = () => post(fetchImpl, `${API_BASE}/users/@me/channels`, token, { recipient_id: config.userId }, nextTimeout('open_dm'), 'open_dm');
        let openResult = await openChannel();
        if (openResult.kind === 'rateLimited') {
            if (openResult.discordCode !== undefined && NO_LOCAL_RETRY_CODES.has(openResult.discordCode)) {
                throw new types_1.AlertDeliveryError('RATE_LIMITED', true, undefined, undefined, `Discord DM open_dm rate-limited (code ${openResult.discordCode})`);
            }
            const delayMs = openResult.retryAfterSec * 1000;
            if (delayMs >= remainingMs()) {
                throw new types_1.AlertDeliveryError('RATE_LIMITED', true, undefined, delayMs, 'Discord DM open_dm rate-limited; retry would exceed the overall deadline');
            }
            await (0, discord_internal_1.delay)(delayMs);
            openResult = await openChannel();
        }
        if (openResult.kind === 'rateLimited') {
            throw new types_1.AlertDeliveryError('RATE_LIMITED', true, undefined, openResult.retryAfterSec * 1000, 'Discord DM open_dm rate-limited (429)');
        }
        if (openResult.kind === 'error') {
            throw classifyApiError('open_dm', openResult.status, openResult.discordCode, undefined);
        }
        const channelId = extractChannelId(openResult.json);
        // --- send the alert embed ---
        const body = { embeds: [(0, discord_internal_1.buildEmbed)({ ...alert, service: alert.service ?? config.service }, discord_internal_1.DEFAULT_COLORS)] };
        const sendMessage = () => post(fetchImpl, `${API_BASE}/channels/${channelId}/messages`, token, body, nextTimeout('send_message'), 'send_message');
        let attempts = 1;
        let sendResult = await sendMessage();
        if (sendResult.kind === 'rateLimited') {
            if (sendResult.discordCode !== undefined && NO_LOCAL_RETRY_CODES.has(sendResult.discordCode)) {
                throw new types_1.AlertDeliveryError('RATE_LIMITED', true, channelId, undefined, `Discord DM send_message rate-limited (code ${sendResult.discordCode})`);
            }
            const delayMs = sendResult.retryAfterSec * 1000;
            if (delayMs >= remainingMs()) {
                throw new types_1.AlertDeliveryError('RATE_LIMITED', true, channelId, delayMs, 'Discord DM send_message rate-limited; retry would exceed the overall deadline');
            }
            await (0, discord_internal_1.delay)(delayMs);
            attempts++;
            sendResult = await sendMessage();
        }
        if (sendResult.kind === 'rateLimited') {
            throw new types_1.AlertDeliveryError('RATE_LIMITED', true, channelId, sendResult.retryAfterSec * 1000, 'Discord DM send_message rate-limited (429)');
        }
        if (sendResult.kind === 'error') {
            throw classifyApiError('send_message', sendResult.status, sendResult.discordCode, channelId);
        }
        return { destinationId: channelId, attempts };
    };
    return { isConfigured, deliver, async send(alert) { await deliver(alert); } };
}
