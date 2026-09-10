"use strict";
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
 *
 * `createFallbackTransport` composes any transports (e.g. DM primary +
 * webhook fallback) so an alert isn't dropped when the primary route can't
 * deliver.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseDeployMonitorEvent = exports.alertsFromDeployEvent = exports.severityFromDeployStatus = exports.createAlerter = exports.initialSuppressionState = exports.unsentAlertState = exports.stepCheck = exports.AggregateAlertDeliveryError = exports.createFallbackTransport = exports.redactBotToken = exports.createDiscordDmTransport = exports.redactWebhookUrl = exports.createDiscordTransport = exports.AlertDeliveryError = void 0;
var types_1 = require("./types");
Object.defineProperty(exports, "AlertDeliveryError", { enumerable: true, get: function () { return types_1.AlertDeliveryError; } });
var discord_1 = require("./discord");
Object.defineProperty(exports, "createDiscordTransport", { enumerable: true, get: function () { return discord_1.createDiscordTransport; } });
Object.defineProperty(exports, "redactWebhookUrl", { enumerable: true, get: function () { return discord_1.redactWebhookUrl; } });
var discord_dm_1 = require("./discord-dm");
Object.defineProperty(exports, "createDiscordDmTransport", { enumerable: true, get: function () { return discord_dm_1.createDiscordDmTransport; } });
Object.defineProperty(exports, "redactBotToken", { enumerable: true, get: function () { return discord_dm_1.redactBotToken; } });
var fallback_1 = require("./fallback");
Object.defineProperty(exports, "createFallbackTransport", { enumerable: true, get: function () { return fallback_1.createFallbackTransport; } });
Object.defineProperty(exports, "AggregateAlertDeliveryError", { enumerable: true, get: function () { return fallback_1.AggregateAlertDeliveryError; } });
var suppression_1 = require("./suppression");
Object.defineProperty(exports, "stepCheck", { enumerable: true, get: function () { return suppression_1.stepCheck; } });
Object.defineProperty(exports, "unsentAlertState", { enumerable: true, get: function () { return suppression_1.unsentAlertState; } });
Object.defineProperty(exports, "initialSuppressionState", { enumerable: true, get: function () { return suppression_1.initialSuppressionState; } });
var alerter_1 = require("./alerter");
Object.defineProperty(exports, "createAlerter", { enumerable: true, get: function () { return alerter_1.createAlerter; } });
var deploy_events_1 = require("./deploy-events");
Object.defineProperty(exports, "severityFromDeployStatus", { enumerable: true, get: function () { return deploy_events_1.severityFromDeployStatus; } });
Object.defineProperty(exports, "alertsFromDeployEvent", { enumerable: true, get: function () { return deploy_events_1.alertsFromDeployEvent; } });
Object.defineProperty(exports, "parseDeployMonitorEvent", { enumerable: true, get: function () { return deploy_events_1.parseDeployMonitorEvent; } });
