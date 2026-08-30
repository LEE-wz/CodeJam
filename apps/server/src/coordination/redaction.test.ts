import { describe, expect, it } from "vitest";
import { createCoordinationEventFactory } from "./events.js";
import {
  ALLOWED_EVENT_DETAIL_KEYS,
  MAX_EVENT_DETAIL_ARRAY_ITEMS,
  MAX_EVENT_DETAIL_CHARS,
  REDACTION_PLACEHOLDER,
  TRUNCATION_MARKER,
  defaultRedactor,
} from "./redaction.js";

/**
 * Values that must never survive redaction. Each is a shape that could
 * realistically reach an event or log line through an error message.
 */
const SECRET_BEARING_TEXT: ReadonlyArray<readonly [string, string]> = [
  ["Authorization: Bearer abc123.def-456_ghi", "abc123.def-456_ghi"],
  ["bearer sk-live-0123456789abcdefghij", "sk-live-0123456789abcdefghij"],
  ["authorization=Basic YWxhZGRpbjpvcGVuc2VzYW1l", "YWxhZGRpbjpvcGVuc2VzYW1l"],
  ["Cookie: session=9f8e7d6c5b4a; theme=dark", "9f8e7d6c5b4a"],
  ["set-cookie: sid=abcdef1234567890; HttpOnly", "abcdef1234567890"],
  ["leaseToken=7c9e6679-7425-40de-944b-e07fc1f90ae7", "7c9e6679-7425-40de-944b-e07fc1f90ae7"],
  ["lease_token: 7c9e6679-7425-40de-944b", "7c9e6679-7425-40de-944b"],
  ["api_key=AKIAIOSFODNN7EXAMPLE", "AKIAIOSFODNN7EXAMPLE"],
  ["password: hunter2-correct-horse", "hunter2-correct-horse"],
  ["secret=s3cr3t-value-here", "s3cr3t-value-here"],
  [
    "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  ],
];

describe("defaultRedactor.text", () => {
  it.each(SECRET_BEARING_TEXT)("removes the secret in %j", (input, secret) => {
    const redacted = defaultRedactor.text(input, MAX_EVENT_DETAIL_CHARS);
    expect(redacted).not.toContain(secret);
    expect(redacted).toContain("[redacted]");
  });

  it("redacts before truncating, so a secret cannot survive past the cap", () => {
    const padding = "x".repeat(MAX_EVENT_DETAIL_CHARS);
    const redacted = defaultRedactor.text(
      `${padding} Authorization: Bearer supersecrettoken12345`,
      MAX_EVENT_DETAIL_CHARS,
    );
    expect(redacted).not.toContain("supersecrettoken12345");
  });

  it("truncates visibly and never exceeds the cap", () => {
    const redacted = defaultRedactor.text("y".repeat(1000), MAX_EVENT_DETAIL_CHARS);
    expect(redacted).toHaveLength(MAX_EVENT_DETAIL_CHARS);
    expect(redacted.endsWith(TRUNCATION_MARKER)).toBe(true);
  });

  it("leaves ordinary short text untouched apart from trimming", () => {
    expect(defaultRedactor.text("  Section 'scope' is missing.  ", 100)).toBe(
      "Section 'scope' is missing.",
    );
  });

  it("replaces control characters that would corrupt a log line", () => {
    expect(defaultRedactor.text("a\u0000b\u001Bc\nd", 100)).toBe("a b c d");
  });

  it("returns an empty string for a non-positive cap", () => {
    expect(defaultRedactor.text("anything", 0)).toBe("");
  });
});

describe("defaultRedactor.eventDetails", () => {
  it("drops every key outside the allowlist", () => {
    const details = defaultRedactor.eventDetails({
      role: "planner",
      prompt: "[CONTEXT] the entire prompt envelope",
      rawOutput: '{"type":"proposal"}',
      leaseToken: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      authorization: "Bearer abc123",
      cookie: "sid=abc",
      objective: "the user objective",
    });

    expect(details).toEqual({ role: "planner" });
  });

  it("never accepts a lease token under any spelling", () => {
    for (const key of ["leaseToken", "lease_token", "lease-token", "token", "leasetoken"]) {
      expect(ALLOWED_EVENT_DETAIL_KEYS).not.toContain(key);
      expect(defaultRedactor.eventDetails({ [key]: "7c9e6679-7425" })).toEqual({});
    }
  });

  it("redacts and bounds allowlisted string values", () => {
    const details = defaultRedactor.eventDetails({
      name: `Rollout ${"z".repeat(400)}`,
      reason: "runner failed with Authorization: Bearer abc123def456",
    });

    expect(details.name).toHaveLength(MAX_EVENT_DETAIL_CHARS);
    expect(String(details.name).endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(details.reason).not.toContain("abc123def456");
  });

  it("bounds string arrays and marks the drop visibly", () => {
    const validationErrors = Array.from({ length: 25 }, (_, index) => `error ${index}`);
    const details = defaultRedactor.eventDetails({ validationErrors });

    expect(details.validationErrors).toHaveLength(MAX_EVENT_DETAIL_ARRAY_ITEMS + 1);
    expect((details.validationErrors as string[]).at(-1)).toBe(
      `${TRUNCATION_MARKER} +${25 - MAX_EVENT_DETAIL_ARRAY_ITEMS} more`,
    );
  });

  it("redacts each item of a string array", () => {
    const details = defaultRedactor.eventDetails({
      validationErrors: ["ok", "Cookie: sid=abcdef1234567890"],
    });
    expect((details.validationErrors as string[])[1]).not.toContain("abcdef1234567890");
  });

  it("drops unknown objects rather than stringifying them", () => {
    const details = defaultRedactor.eventDetails({
      reason: { nested: "object" },
      code: ["not", "a", "code"],
      name: new Date("2026-08-30T00:00:00.000Z"),
      role: undefined,
      sequence: Number.NaN,
      sizeChars: Number.POSITIVE_INFINITY,
    });

    // `code` is a string array here, which is a legal SafeEventValue shape.
    expect(details).toEqual({ code: ["not", "a", "code"] });
    expect(JSON.stringify(details)).not.toContain("[object Object]");
  });

  it("drops a mixed array whole rather than partially keeping it", () => {
    expect(defaultRedactor.eventDetails({ issueCodes: ["ok", 42] })).toEqual({});
    expect(defaultRedactor.eventDetails({ issueCodes: [["nested"]] })).toEqual({});
  });

  it("keeps booleans, finite numbers, and null", () => {
    expect(
      defaultRedactor.eventDetails({ truncated: false, sizeChars: 0, outputDigest: null }),
    ).toEqual({ truncated: false, sizeChars: 0, outputDigest: null });
  });

  it("returns keys in a stable sorted order so snapshots do not churn", () => {
    const forwards = defaultRedactor.eventDetails({ role: "critic", agentId: "a", code: "c" });
    const backwards = defaultRedactor.eventDetails({ code: "c", agentId: "a", role: "critic" });
    expect(Object.keys(forwards)).toEqual(["agentId", "code", "role"]);
    expect(Object.keys(backwards)).toEqual(Object.keys(forwards));
  });
});

// ------------------------------------------------------ P11-02 new event

describe("run.reconciled redaction", () => {
  it("keeps only allowlisted details and strips a lease token from the reason", () => {
    const draft = createCoordinationEventFactory().runReconciled({
      runId: "run-1",
      turnId: "turn-1",
      code: "RUN_ABANDONED",
      reason: "loop exited holding leaseToken=abcd-1234-secret",
    });

    expect(Object.keys(draft.details).sort()).toEqual(["code", "reason"]);
    expect(draft.details.code).toBe("RUN_ABANDONED");
    expect(draft.details.reason).not.toContain("abcd-1234-secret");
    expect(draft.details.reason).toContain(REDACTION_PLACEHOLDER);
    expect(draft.message).toBe("Run reconciled after an orchestration exit.");
  });
});
