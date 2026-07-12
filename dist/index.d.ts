/**
 * @andrewpopov/alert-kit — the transport-pluggable alert primitive.
 *
 * Owns a small, opinionated contract (`AlertTransport`: `isConfigured` +
 * `send`) plus one built-in transport — Discord, via incoming webhooks — so
 * apps can fire `info`/`warn`/`error`/`critical` alerts without hand-rolling
 * embed formatting, per-severity routing, or 429 backoff each time.
 *
 * Env (Discord transport): DISCORD_WEBHOOK_URL (primary),
 * DISCORD_WEBHOOK_URL_INFO|_WARN|_ERROR|_CRITICAL (per-severity overrides),
 * DISCORD_ALERT_SERVICE (embed footer), DISCORD_ALERT_USERNAME (webhook name).
 */
export type { Severity, Alert, AlertResult, AlertTransport } from './types';
export { createDiscordTransport, type DiscordTransportOptions } from './discord';
export { createAlerter, type Alerter, type AlerterOptions } from './alerter';
