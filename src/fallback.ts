import {
  AlertDeliveryError,
  type Alert,
  type AlertDeliveryReceipt,
  type AlertTransport,
  type AttemptedRouteOutcome,
  type Severity,
} from './types';

/** A child transport, optionally given a stable label for logs/receipts. */
export interface FallbackTransportEntry {
  transport: AlertTransport;
  /**
   * Stable, non-secret label for this route (e.g. `'dm'`, `'webhook'`),
   * surfaced in the winning receipt's `route`, in `attemptedRoutes`, and in
   * `onDegraded`. Defaults to the entry's position in the `transports`
   * array (as a string) when omitted.
   */
  label?: string;
}

/**
 * A fallback child is either a bare transport (labeled by its index) or an
 * entry naming it explicitly. Colocating the label with its transport
 * — rather than a second, parallel array of labels — means reordering or
 * editing the list can't silently desync a transport from the wrong label.
 */
export type FallbackTransportChild = AlertTransport | FallbackTransportEntry;

/** Sanitized, non-secret summary of one delivery attempt through `createFallbackTransport`. */
export interface DegradedInfo {
  severity: Severity;
  title: string;
  /** Label of the route that ultimately delivered, or `undefined` if every configured route failed. */
  wonBy?: string;
  /** Every route skipped or attempted before `wonBy` (or, on total failure, every route that was attempted or skipped). */
  attemptedRoutes: AttemptedRouteOutcome[];
}

export interface FallbackTransportOptions {
  /**
   * Called whenever a delivery attempt did not succeed via the first
   * configured child — i.e. some earlier child was skipped as unconfigured
   * for this alert's severity, or was attempted and failed — including the
   * case where every configured child ultimately failed. Receives only
   * sanitized, non-secret data (see `DegradedInfo`).
   *
   * Contained the same way `onSent`/`onSkipped` are in `discord.ts`: a
   * throwing or slow observer is caught and logged (via `console.error`),
   * never allowed to fail an alert that actually succeeded, trigger another
   * delivery attempt, or delay the caller past the delivery itself.
   */
  onDegraded?: (info: DegradedInfo) => void;
}

function normalize(children: FallbackTransportChild[]): Array<{ transport: AlertTransport; label: string }> {
  return children.map((child, index) => {
    const label = (index).toString();
    if ('transport' in child) return { transport: child.transport, label: child.label ?? label };
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
function outcomeFromError(label: string, err: unknown): AttemptedRouteOutcome {
  if (err instanceof AlertDeliveryError) {
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
export class AggregateAlertDeliveryError extends AlertDeliveryError {
  constructor(
    readonly outcomes: AttemptedRouteOutcome[],
    retryable: boolean,
    message: string,
  ) {
    super('ALL_ROUTES_FAILED', retryable, undefined, undefined, message);
  }
}

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
export function createFallbackTransport(
  transports: FallbackTransportChild[],
  options: FallbackTransportOptions = {},
): AlertTransport {
  const children = normalize(transports);

  const isConfigured = (severity?: Severity): boolean => children.some(({ transport }) => transport.isConfigured(severity));

  const notifyDegraded = (info: DegradedInfo): void => {
    try {
      options.onDegraded?.(info);
    } catch (err) {
      console.error(`alert-kit: onDegraded callback threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const deliver = async (alert: Alert): Promise<AlertDeliveryReceipt> => {
    const attemptedRoutes: AttemptedRouteOutcome[] = [];
    let anyConfigured = false;
    let attempts = 0;
    let winner: { label: string; receipt: AlertDeliveryReceipt } | undefined;

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
      } catch (err) {
        attemptedRoutes.push(outcomeFromError(label, err));
      }
    }

    if (!anyConfigured) {
      throw new AlertDeliveryError('UNCONFIGURED', false, undefined, undefined, `No fallback route is configured for severity "${alert.severity}"`);
    }

    if (!winner) {
      const retryable = attemptedRoutes.some((o) => o.outcome === 'failed' && o.retryable === true);
      const failedCount = attemptedRoutes.filter((o) => o.outcome === 'failed').length;
      notifyDegraded({ severity: alert.severity, title: alert.title, wonBy: undefined, attemptedRoutes });
      throw new AggregateAlertDeliveryError(
        attemptedRoutes,
        retryable,
        `All ${failedCount} configured fallback route(s) failed for severity "${alert.severity}"`,
      );
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
