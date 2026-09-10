/**
 * Shared internals for the Discord transports (webhook + bot DM). Everything
 * here is embed formatting / truncation / small utilities with no
 * transport-specific behavior — extracted so the two transports don't
 * duplicate Discord's embed limits and truncation rules. This module is
 * intentionally free of any per-transport config, routing, or HTTP concerns.
 */
import type { Alert, Severity } from './types';
export declare const DEFAULT_COLORS: Record<Severity, number>;
export declare function orPlaceholder(value: string): string;
export declare function truncate(value: string, max: number): string;
export declare function codePointLength(value: string): number;
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
    footer?: {
        text: string;
    };
    fields?: DiscordEmbedField[];
}
export declare function buildFields(fields: Alert['fields']): DiscordEmbedField[] | undefined;
export declare function buildEmbed(alert: Alert, colors: Record<Severity, number>): DiscordEmbed;
export declare function embedTextTotal(embed: DiscordEmbed): number;
/**
 * Enforce Discord's 6,000-code-point AGGREGATE embed limit (see
 * MAX_EMBED_TOTAL above) on top of the per-component caps already applied by
 * `buildEmbed`. Priority, most important first: title (already <=256, always
 * kept as-is) > footer/service (always kept as-is) > description (trimmed to
 * fit) > fields (dropped from the end, as a last resort, once the
 * description alone can't bring the total under budget).
 */
export declare function fitEmbedToBudget(embed: DiscordEmbed): DiscordEmbed;
/** Truncate to an exact code-point length, no ellipsis (used for budget trimming, not display truncation). */
export declare function truncateToCodePoints(value: string, max: number): string;
export declare function sanitizeColor(color: number | undefined, fallback: number): number;
export declare function delay(ms: number): Promise<void>;
/** True for a native `AbortError` (fetch/body-read rejection from an aborted `AbortSignal`). */
export declare function isAbortError(err: unknown): boolean;
