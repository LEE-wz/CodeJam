import type { Redactor } from "./contracts.js";
import type { SafeEventValue } from "./types.js";

export type { Redactor } from "./contracts.js";

/** Maximum characters retained for any single string inside event details. */
export const MAX_EVENT_DETAIL_CHARS = 200;

/** Maximum items retained in any string array inside event details. */
export const MAX_EVENT_DETAIL_ARRAY_ITEMS = 10;

/** Appended whenever the redactor drops content, so truncation is always visible. */
export const TRUNCATION_MARKER = "… [truncated]";

export const REDACTION_PLACEHOLDER = "[redacted]";

/**
 * Keys permitted inside `CoordinationEvent.details`.
 *
 * This is an allowlist, not a denylist: anything absent here is dropped, so a
 * lease token, prompt, or raw output can never reach an event by being passed
 * under a new key. Every key names a bounded enum, identifier, count, digest,
 * or short label - never model input or output.
 */
export const ALLOWED_EVENT_DETAIL_KEYS = [
  "agentId",
  "artifactType",
  "attemptNumber",
  "code",
  "decision",
  "errorCount",
  "expectedArtifactType",
  "inputArtifactCount",
  "issueCodes",
  "issueCount",
  "kind",
  "maxRevisions",
  "maxTurns",
  "name",
  "outputDigest",
  "participantAgentIds",
  "phase",
  "promptDigest",
  "reason",
  "requiredSectionKeys",
  "revision",
  "role",
  "sequence",
  "sizeChars",
  "timeoutMs",
  "truncated",
  "validationErrors",
  "workflow",
] as const;

export type AllowedEventDetailKey = (typeof ALLOWED_EVENT_DETAIL_KEYS)[number];

const ALLOWED_KEY_SET: ReadonlySet<string> = new Set(ALLOWED_EVENT_DETAIL_KEYS);

/**
 * Secret-bearing shapes removed from any text the redactor touches. These run
 * before truncation, so a secret can never survive by sitting past the cap.
 */
const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // `Authorization: Bearer <token>` and bare bearer tokens.
  [/\bbearer\s+[\w.~+/=-]+/gi, `Bearer ${REDACTION_PLACEHOLDER}`],
  // Any authorization/cookie/set-cookie header, colon or equals form.
  [/\b(authorization|set-cookie|cookie)\s*[:=]\s*[^\r\n]*/gi, `$1: ${REDACTION_PLACEHOLDER}`],
  // Common secret-ish assignments, including our own lease token.
  [
    /\b(lease[_-]?token|leaseToken|api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|pwd)\s*[:=]\s*[^\s,;}"']+/gi,
    `$1=${REDACTION_PLACEHOLDER}`,
  ],
  // JWTs, which carry their own delimiters and would otherwise pass as prose.
  [/\beyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]+/g, REDACTION_PLACEHOLDER],
  // Provider-style prefixed keys.
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}/g, REDACTION_PLACEHOLDER],
];

/** Control characters would corrupt a log line or terminal rendering. */
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/g;

const truncate = (value: string, maxChars: number): string => {
  if (maxChars <= 0) {
    return "";
  }
  if (value.length <= maxChars) {
    return value;
  }
  if (maxChars <= TRUNCATION_MARKER.length) {
    return value.slice(0, maxChars);
  }
  return value.slice(0, maxChars - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
};

const redactText = (value: string, maxChars: number): string => {
  let safe = value.replace(CONTROL_CHARACTERS, " ");
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    safe = safe.replace(pattern, replacement);
  }
  return truncate(safe.trim(), maxChars);
};

const redactStringArray = (values: readonly unknown[]): string[] | undefined => {
  // A mixed or nested array is dropped whole rather than partially stringified.
  if (!values.every((item) => typeof item === "string")) {
    return undefined;
  }
  const kept = (values as readonly string[])
    .slice(0, MAX_EVENT_DETAIL_ARRAY_ITEMS)
    .map((item) => redactText(item, MAX_EVENT_DETAIL_CHARS));
  const dropped = values.length - kept.length;
  return dropped > 0 ? [...kept, `${TRUNCATION_MARKER} +${dropped} more`] : kept;
};

const redactDetailValue = (value: unknown): SafeEventValue | undefined => {
  if (value === null) {
    return null;
  }
  if (typeof value === "string") {
    return redactText(value, MAX_EVENT_DETAIL_CHARS);
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (Array.isArray(value)) {
    return redactStringArray(value);
  }
  // Objects, functions, symbols, bigints, and undefined are dropped. They must
  // never be stringified into an event.
  return undefined;
};

export const defaultRedactor: Redactor = {
  text(value: string, maxChars: number): string {
    return redactText(value, maxChars);
  },

  eventDetails(value: Record<string, unknown>): Record<string, SafeEventValue> {
    const details: Record<string, SafeEventValue> = {};
    for (const key of Object.keys(value).sort()) {
      if (!ALLOWED_KEY_SET.has(key)) {
        continue;
      }
      const safe = redactDetailValue(value[key]);
      if (safe !== undefined) {
        details[key] = safe;
      }
    }
    return details;
  },
};
