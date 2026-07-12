"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAlerter = createAlerter;
/** Create an alerter bound to a transport. The transport owns delivery; this owns strict-vs-best-effort semantics. */
function createAlerter(transport, options = {}) {
    const send = async (a) => {
        if (!transport.isConfigured(a.severity)) {
            throw new Error(`Alerting is not configured for severity "${a.severity}"`);
        }
        await transport.send(a);
    };
    const sendBestEffort = async (a) => {
        if (!transport.isConfigured(a.severity)) {
            options.onSkipped?.({ severity: a.severity, title: a.title });
            return { sent: false };
        }
        await transport.send(a);
        return { sent: true };
    };
    const bySeverity = (severity) => (title, opts = {}) => sendBestEffort({ ...opts, severity, title });
    return {
        isConfigured: () => transport.isConfigured(),
        alert: send,
        alertBestEffort: sendBestEffort,
        info: bySeverity('info'),
        warn: bySeverity('warn'),
        error: bySeverity('error'),
        critical: bySeverity('critical'),
    };
}
