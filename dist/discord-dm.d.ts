import { type AlertTransport } from './types';
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
export declare function redactBotToken(text: unknown, token?: string): string;
/**
 * Create a Discord bot-DM transport: opens (or reuses, per Discord) a DM
 * channel with a fixed recipient and posts the alert embed into it via the
 * bot's own REST credentials — no dependency on any webhook or on the host
 * app's own API process. Config is read lazily, same as the webhook
 * transport.
 */
export declare function createDiscordDmTransport(options?: DiscordDmTransportOptions): AlertTransport;
