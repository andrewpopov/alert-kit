/**
 * Shared internals for the Discord transports (webhook + bot DM). Everything
 * here is embed formatting / truncation / small utilities with no
 * transport-specific behavior — extracted so the two transports don't
 * duplicate Discord's embed limits and truncation rules. This module is
 * intentionally free of any per-transport config, routing, or HTTP concerns.
 */

import type { Alert, Severity } from './types';

// Discord's documented embed limits. We enforce them by TRUNCATING rather than
// dropping the alert or letting the request through — a 400 from Discord means
// the alert is lost entirely, which is worse than a shortened message.
const LIMITS = {
  title: 256,
  description: 4096,
  fieldName: 256,
  fieldValue: 1024,
  footerText: 2048,
  maxFields: 25,
} as const;

// Discord's separate, AGGREGATE limit: total text across title + description
// + footer + every field name/value must be <= 6000 code points, even though
// each component individually fits its own per-component limit above (25
// max-length fields alone sum to ~32,000). Exceeding it gets the whole POST
// rejected with a 400 — losing the alert, the exact failure per-component
// truncation exists to prevent.
const MAX_EMBED_TOTAL = 6000;

export const DEFAULT_COLORS: Record<Severity, number> = {
  info: 0x3498db,
  warn: 0xf1c40f,
  error: 0xe74c3c,
  critical: 0x992d22,
};

// Placeholder for a title/field name/field value that would otherwise be
// empty. Discord rejects an empty title, field name, or field value with a
// 400 — which loses the alert entirely, the same failure truncation above
// exists to prevent.
const EMPTY = '—';

export function orPlaceholder(value: string): string {
  return value.trim() === '' ? EMPTY : value;
}

export function truncate(value: string, max: number): string {
  if (value.length <= max) return value; // length is an upper bound on code-point count
  const codePoints = [...value];
  if (codePoints.length <= max) return value;
  if (max <= 0) return '';
  if (max === 1) return codePoints[0];
  return `${codePoints.slice(0, max - 1).join('')}…`;
}

export function codePointLength(value: string): number {
  return [...value].length;
}

export interface DiscordEmbedField {
  name: string;
  value: string;
  inline: boolean;
}

export interface DiscordEmbed {
  title: string;
  description?: string;
  color: number;
  timestamp: string;
  footer?: { text: string };
  fields?: DiscordEmbedField[];
}

export function buildFields(fields: Alert['fields']): DiscordEmbedField[] | undefined {
  if (!fields) return undefined;
  const entries = Object.entries(fields).slice(0, LIMITS.maxFields);
  if (entries.length === 0) return undefined;
  return entries.map(([name, value]) => ({
    name: truncate(orPlaceholder(name), LIMITS.fieldName),
    value: truncate(orPlaceholder(String(value)), LIMITS.fieldValue),
    inline: true,
  }));
}

export function buildEmbed(alert: Alert, colors: Record<Severity, number>): DiscordEmbed {
  const fields = buildFields(alert.fields);
  const embed: DiscordEmbed = {
    title: truncate(orPlaceholder(alert.title), LIMITS.title),
    ...(alert.message ? { description: truncate(alert.message, LIMITS.description) } : {}),
    color: colors[alert.severity],
    timestamp: (alert.timestamp ?? new Date()).toISOString(),
    ...(alert.service ? { footer: { text: truncate(alert.service, LIMITS.footerText) } } : {}),
    ...(fields ? { fields } : {}),
  };
  return fitEmbedToBudget(embed);
}

export function embedTextTotal(embed: DiscordEmbed): number {
  let total = codePointLength(embed.title);
  if (embed.description) total += codePointLength(embed.description);
  if (embed.footer) total += codePointLength(embed.footer.text);
  if (embed.fields) {
    for (const field of embed.fields) total += codePointLength(field.name) + codePointLength(field.value);
  }
  return total;
}

/**
 * Enforce Discord's 6,000-code-point AGGREGATE embed limit (see
 * MAX_EMBED_TOTAL above) on top of the per-component caps already applied by
 * `buildEmbed`. Priority, most important first: title (already <=256, always
 * kept as-is) > footer/service (always kept as-is) > description (trimmed to
 * fit) > fields (dropped from the end, as a last resort, once the
 * description alone can't bring the total under budget).
 */
export function fitEmbedToBudget(embed: DiscordEmbed): DiscordEmbed {
  let total = embedTextTotal(embed);
  if (total <= MAX_EMBED_TOTAL) return embed;

  const result: DiscordEmbed = { ...embed, fields: embed.fields ? [...embed.fields] : undefined };

  if (result.description && total > MAX_EMBED_TOTAL) {
    const overBy = total - MAX_EMBED_TOTAL;
    const descLen = codePointLength(result.description);
    const truncated = truncateToCodePoints(result.description, Math.max(0, descLen - overBy));
    total -= descLen - codePointLength(truncated);
    if (truncated) {
      result.description = truncated;
    } else {
      delete result.description;
    }
  }

  while (total > MAX_EMBED_TOTAL && result.fields && result.fields.length > 0) {
    const dropped = result.fields.pop() as DiscordEmbedField;
    total -= codePointLength(dropped.name) + codePointLength(dropped.value);
  }
  if (result.fields && result.fields.length === 0) delete result.fields;

  if (total > MAX_EMBED_TOTAL && result.fields && result.fields.length > 0) {
    const last = result.fields[result.fields.length - 1];
    const overBy = total - MAX_EMBED_TOTAL;
    const valLen = codePointLength(last.value);
    const truncatedVal = truncateToCodePoints(last.value, Math.max(0, valLen - overBy));
    total -= valLen - codePointLength(truncatedVal);
    last.value = truncatedVal;
  }

  return result;
}

/** Truncate to an exact code-point length, no ellipsis (used for budget trimming, not display truncation). */
export function truncateToCodePoints(value: string, max: number): string {
  if (max <= 0) return '';
  const codePoints = [...value];
  if (codePoints.length <= max) return value;
  return codePoints.slice(0, max).join('');
}

export function sanitizeColor(color: number | undefined, fallback: number): number {
  if (color === undefined) return fallback;
  return Number.isInteger(color) && color >= 0x000000 && color <= 0xffffff ? color : fallback;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True for a native `AbortError` (fetch/body-read rejection from an aborted `AbortSignal`). */
export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}
