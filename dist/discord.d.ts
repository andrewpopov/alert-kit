import type { AlertTransport, Severity } from './types';
export interface DiscordTransportOptions {
    /** Config source. Defaults to `process.env`. Read lazily on every call. */
    env?: Record<string, string | undefined>;
    /** Primary webhook URL, used when a severity has no dedicated route. Else `env.DISCORD_WEBHOOK_URL`. */
    webhookUrl?: string;
    /** Per-severity webhook URLs. Else `env.DISCORD_WEBHOOK_URL_INFO|_WARN|_ERROR|_CRITICAL`. */
    severityWebhookUrls?: Partial<Record<Severity, string>>;
    /** Service name shown in the embed footer. Else `env.DISCORD_ALERT_SERVICE`. */
    service?: string;
    /** Webhook display username. Else `env.DISCORD_ALERT_USERNAME`. */
    username?: string;
    /** Per-request timeout. Default 10_000ms. Always bounded — an unbounded alert POST can hang a request/deploy forever. */
    timeoutMs?: number;
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
     * deliberately withheld.
     */
    onSent?: (info: {
        severity: Severity;
        title: string;
        webhookId: string | undefined;
    }) => void;
    /** Called when an alert's severity has no configured route (transport still throws). */
    onSkipped?: (info: {
        severity: Severity;
        title: string;
    }) => void;
}
/** Create a Discord transport bound to the given options. Config is read lazily. */
export declare function createDiscordTransport(options?: DiscordTransportOptions): AlertTransport;
