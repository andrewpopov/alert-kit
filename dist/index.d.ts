/**
 * @andrewpopov/alert-kit — the transport-pluggable alert primitive.
 *
 * Owns a small, opinionated contract (`AlertTransport`: `isConfigured` +
 * `send`) plus two built-in Discord transports — incoming webhooks, and bot
 * DMs via the Discord REST API directly — so apps can fire
 * `info`/`warn`/`error`/`critical` alerts without hand-rolling embed
 * formatting, per-severity routing, or 429 backoff each time.
 *
 * Env (webhook transport): DISCORD_WEBHOOK_URL (primary),
 * DISCORD_WEBHOOK_URL_INFO|_WARN|_ERROR|_CRITICAL (per-severity overrides),
 * DISCORD_ALERT_SERVICE (embed footer), DISCORD_ALERT_USERNAME (webhook name).
 *
 * Env (DM transport): DISCORD_BOT_TOKEN, DISCORD_ALERT_DM_USER_ID.
 */
export { AlertDeliveryError } from './types';
export type { Severity, Alert, AlertResult, AlertTransport, AlertDeliveryReceipt, AlertDeliveryFailureCode } from './types';
export { createDiscordTransport, redactWebhookUrl, type DiscordTransportOptions } from './discord';
export { createDiscordDmTransport, redactBotToken, type DiscordDmTransportOptions } from './discord-dm';
export { stepCheck, unsentAlertState, initialSuppressionState, type SuppressionStatus, type NotificationPhase, type SuppressionAlertKind, type SuppressionCheckResult, type SuppressionState, type SuppressionOptions, type SuppressionAlert, type SuppressionStep, } from './suppression';
export { createAlerter, type Alerter, type AlerterOptions } from './alerter';
export { severityFromDeployStatus, alertsFromDeployEvent, parseDeployMonitorEvent, type DeployMonitorEvent, type DeployMonitorAlert, type DeployMonitorStatus, type DeployMonitorKind, type ParseDeployMonitorEventResult, } from './deploy-events';
