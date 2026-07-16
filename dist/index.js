"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseDeployMonitorEvent = exports.alertsFromDeployEvent = exports.severityFromDeployStatus = exports.createAlerter = exports.createDiscordTransport = exports.AlertDeliveryError = void 0;
var types_1 = require("./types");
Object.defineProperty(exports, "AlertDeliveryError", { enumerable: true, get: function () { return types_1.AlertDeliveryError; } });
var discord_1 = require("./discord");
Object.defineProperty(exports, "createDiscordTransport", { enumerable: true, get: function () { return discord_1.createDiscordTransport; } });
var alerter_1 = require("./alerter");
Object.defineProperty(exports, "createAlerter", { enumerable: true, get: function () { return alerter_1.createAlerter; } });
var deploy_events_1 = require("./deploy-events");
Object.defineProperty(exports, "severityFromDeployStatus", { enumerable: true, get: function () { return deploy_events_1.severityFromDeployStatus; } });
Object.defineProperty(exports, "alertsFromDeployEvent", { enumerable: true, get: function () { return deploy_events_1.alertsFromDeployEvent; } });
Object.defineProperty(exports, "parseDeployMonitorEvent", { enumerable: true, get: function () { return deploy_events_1.parseDeployMonitorEvent; } });
