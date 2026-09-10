"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AggregateAlertDeliveryError = void 0;
exports.createFallbackTransport = createFallbackTransport;
const types_1 = require("./types");
function normalize(children) {
    return children.map((child, index) => {
        const label = (index).toString();
        if ('transport' in child)
            return { transport: child.transport, label: child.label ?? label };
        return { transport: child, label };
    });
}
/**
 * Build a sanitized outcome for a child that was invoked and threw. Never
 * reads the caught error's `message` — only the typed, already-vetted
 * `AlertDeliveryError` fields (`code`/`retryable`/`destinationId`, each
 * documented on `AlertDeliveryError` as safe to surface) are copied out. A
 * child that throws something other than `AlertDeliveryError` (a violation
 * of the `AlertTransport` contract) is treated conservatively as an
 * unclassified, retryable failure rather than risking a leak of whatever it
 * put in its own error's message.
 */
function outcomeFromError(label, err) {
    if (err instanceof types_1.AlertDeliveryError) {
        return { label, outcome: 'failed', code: err.code, retryable: err.retryable, destinationId: err.destinationId };
    }
    return { label, outcome: 'failed', retryable: true };
}
/**
 * Thrown when every configured child of a `createFallbackTransport` failed.
 * Carries the sanitized per-child outcomes so a terminal failure from one
 * route (e.g. a webhook rejected outright) can't conceal a retryable one
 * from another (e.g. a DM that only timed out) behind a single rethrown
 * error. `retryable` is true iff ANY attempted child's failure was itself
 * retryable.
 */
class AggregateAlertDeliveryError extends types_1.AlertDeliveryError {
    constructor(outcomes, retryable, message) {
        super('ALL_ROUTES_FAILED', retryable, undefined, undefined, message);
        this.outcomes = outcomes;
    }
}
exports.AggregateAlertDeliveryError = AggregateAlertDeliveryError;
/**
 * Compose transports into one: try each configured child, in order, and
 * stop at the first that delivers. Exists so a primary route with strictly
 * more failure modes (e.g. a Discord bot DM — closed DMs, no mutual guild,
 * token rotation) can fall back to a more reliable one (e.g. a webhook)
 * without the alert being silently dropped.
 *
 * `isConfigured(severity?)` is true iff ANY child is configured for that
 * severity — configuration means a route exists, not that it works, same
 * contract every other transport here follows.
 *
 * `attempts` on the returned receipt counts CHILD TRANSPORTS INVOKED during
 * this delivery (every failed attempt plus the one that finally succeeded),
 * never counting a child skipped as unconfigured. It deliberately does NOT
 * try to fold in a child's own internal attempt count (e.g. the DM
 * transport's channel-open + message-POST + 429-retry accounting) — those
 * are different quantities the composite can't observe for a `send`-only
 * child, and inventing a merged number would misrepresent both.
 */
function createFallbackTransport(transports, options = {}) {
    const children = normalize(transports);
    const isConfigured = (severity) => children.some(({ transport }) => transport.isConfigured(severity));
    const notifyDegraded = (info) => {
        try {
            options.onDegraded?.(info);
        }
        catch (err) {
            console.error(`alert-kit: onDegraded callback threw: ${err instanceof Error ? err.message : String(err)}`);
        }
    };
    const deliver = async (alert) => {
        const attemptedRoutes = [];
        let anyConfigured = false;
        let attempts = 0;
        let winner;
        for (const { transport, label } of children) {
            if (!transport.isConfigured(alert.severity)) {
                attemptedRoutes.push({ label, outcome: 'skipped' });
                continue;
            }
            anyConfigured = true;
            attempts++;
            try {
                // Call `deliver()` if the child implements it, else `send()` —
                // never both, so a child is never invoked twice for one attempt.
                const receipt = transport.deliver ? await transport.deliver(alert) : ((await transport.send(alert)), { attempts: 1 });
                winner = { label, receipt };
                break;
            }
            catch (err) {
                attemptedRoutes.push(outcomeFromError(label, err));
            }
        }
        if (!anyConfigured) {
            throw new types_1.AlertDeliveryError('UNCONFIGURED', false, undefined, undefined, `No fallback route is configured for severity "${alert.severity}"`);
        }
        if (!winner) {
            const retryable = attemptedRoutes.some((o) => o.outcome === 'failed' && o.retryable === true);
            const failedCount = attemptedRoutes.filter((o) => o.outcome === 'failed').length;
            notifyDegraded({ severity: alert.severity, title: alert.title, wonBy: undefined, attemptedRoutes });
            throw new AggregateAlertDeliveryError(attemptedRoutes, retryable, `All ${failedCount} configured fallback route(s) failed for severity "${alert.severity}"`);
        }
        if (attemptedRoutes.length > 0) {
            notifyDegraded({ severity: alert.severity, title: alert.title, wonBy: winner.label, attemptedRoutes });
        }
        return {
            ...winner.receipt,
            attempts,
            route: winner.label,
            ...(attemptedRoutes.length > 0 ? { attemptedRoutes } : {}),
        };
    };
    return { isConfigured, deliver, async send(alert) { await deliver(alert); } };
}
