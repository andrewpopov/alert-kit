import type { Alert, AlertResult, AlertTransport, Severity } from './types';

export interface Alerter {
  /** Whether the bound transport has any route configured. */
  isConfigured(): boolean;
  /** Send an alert. **Throws** if unconfigured or the transport rejects. */
  alert(a: Alert): Promise<void>;
  /**
   * Send if configured; otherwise no-op and return `{ sent: false }` WITHOUT
   * throwing — so flows can call unconditionally. A genuine transport failure
   * (configured but rejected, e.g. no route for this severity) still throws.
   */
  alertBestEffort(a: Alert): Promise<AlertResult>;
  info(title: string, opts?: Omit<Alert, 'severity' | 'title'>): Promise<AlertResult>;
  warn(title: string, opts?: Omit<Alert, 'severity' | 'title'>): Promise<AlertResult>;
  error(title: string, opts?: Omit<Alert, 'severity' | 'title'>): Promise<AlertResult>;
  critical(title: string, opts?: Omit<Alert, 'severity' | 'title'>): Promise<AlertResult>;
}

export interface AlerterOptions {
  /** Called after a best-effort alert is skipped for lack of transport config. */
  onSkipped?: (info: { severity: Severity; title: string }) => void;
}

/** Create an alerter bound to a transport. The transport owns delivery; this owns strict-vs-best-effort semantics. */
export function createAlerter(transport: AlertTransport, options: AlerterOptions = {}): Alerter {
  const send = async (a: Alert): Promise<void> => {
    if (!transport.isConfigured(a.severity)) {
      throw new Error(`Alerting is not configured for severity "${a.severity}"`);
    }
    await transport.send(a);
  };

  const sendBestEffort = async (a: Alert): Promise<AlertResult> => {
    if (!transport.isConfigured(a.severity)) {
      options.onSkipped?.({ severity: a.severity, title: a.title });
      return { sent: false };
    }
    await transport.send(a);
    return { sent: true };
  };

  const bySeverity =
    (severity: Severity) =>
    (title: string, opts: Omit<Alert, 'severity' | 'title'> = {}): Promise<AlertResult> =>
      sendBestEffort({ ...opts, severity, title });

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
