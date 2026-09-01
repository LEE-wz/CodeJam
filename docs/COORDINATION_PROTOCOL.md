# Session Coordination Protocol

All Agent output is untrusted JSON. The expected artifact type comes from the
backend-authored turn kind; an Agent cannot choose which schema is parsed.

## Transcript artifacts

### `user_message`

Backend-authored and turn-less:

```json
{"schemaVersion":1,"type":"user_message","content":"Compare launch risks."}
```

Content is trimmed and limited to 4,000 characters. It carries
`createdBy: {"kind":"user"}`, an idempotency key when supplied by the client,
and a monotonic `transcriptSequence`.

### `session_message`

Agent-authored chat output:

```json
{"schemaVersion":1,"type":"session_message","content":"Fraud review should precede growth.","done":true}
```

`content` is a non-empty bounded string. `done` is optional and advisory; it
never ends an auction-routed session or bypasses awarded execution. The backend
adds Agent/turn provenance and the next transcript sequence.

Invalid examples include prose around the JSON, unknown fields, an empty
content string, or a forged provenance field.

## Private auction artifact: `session_bid`

A bid is evidence, not chat. It is never included in the transcript and losing
bids never enter later prompts.

```json
{
  "schemaVersion": 1,
  "type": "session_bid",
  "recommendation": "team",
  "confidenceBps": 8400,
  "estimatedOutputTokens": 1200,
  "rationale": "Security and operations should answer in sequence.",
  "candidateAnswer": null,
  "plan": {
    "mode": "sequential",
    "assignments": [
      {"agentId":"agent-security","position":1,"instruction":"Identify launch threats."},
      {"agentId":"agent-ops","position":2,"instruction":"Turn those threats into controls."}
    ]
  }
}
```

Structural rules:

- recommendation is `direct | team | abstain`;
- confidence is an integer from 0–10,000 basis points;
- estimated output tokens must fit the applicable durable execution budget;
- candidate answers are bounded and allowed only where the recommendation and
  policy permit them;
- assignments name distinct current participants;
- positions are contiguous from 1;
- `single` has exactly one assignment, `sequential` and `parallel` stay
  within roster and concurrency limits;
- instruction strings are non-empty and bounded;
- unknown fields and forged provenance are rejected.

A malformed plan is therefore a malformed bid. It retries on the same bid turn
with bounded field-specific feedback and never reaches scheduling.

## Backend artifact: `session_award`

Agents cannot emit awards. The repository creates one immutable award per
`(runId, userArtifactId)`:

```json
{
  "schemaVersion": 1,
  "type": "session_award",
  "userArtifactId": "artifact-user",
  "outcome": "execute_plan",
  "selectedAgentId": "agent-security",
  "winningBidArtifactId": "artifact-bid",
  "scoringVersion": "confidence_cost_v1",
  "scoreBps": 7310,
  "components": {
    "confidenceBps": 8400,
    "costPenaltyBps": 600,
    "reliabilityPenaltyBps": 490
  },
  "explanation": "Highest-ranked valid bid under confidence_cost_v1."
}
```

Outcomes are candidate publication or plan execution. A fallback award may omit
a winning bid and names the configured fallback evidence instead. Scoring
explanations contain counts, enums, ids, and arithmetic—never prompts or raw
output.

## Parsing and validation order

1. Enforce the raw output character cap.
2. Parse exactly one JSON value; prose-wrapped JSON is invalid.
3. Validate the schema for the turn's expected artifact type.
4. Validate backend-known provenance and run/turn relationship.
5. Apply cross-field rules, roster membership, plan structure, and durable
   policy budgets.
6. Either commit atomically with the live lease or record bounded validation
   feedback and retry on the same turn.

Parsing never falls back to a different artifact type.

## Scoped context

Session execution and bid turns receive:

- the run objective and participant roster;
- `session_message` and `user_message` transcript entries through the
  turn's immutable `inputThroughSequence`;
- the newest user prompt in full;
- a recency window when the 40,000-character context budget is exceeded.

Private bids are excluded. Winning execution additionally receives the selected
award, the winning plan, and only that Agent's assignment. Losing bids, scoring
inputs not present in the award, provider thread ids, lease tokens, and raw
rejected output are never visible.

Old stored turns without `inputThroughSequence` use their explicit
`inputArtifactIds` and remain readable.

## Retry, fallback, and failure

- Invalid output retries on the same Agent and same turn up to the durable
  attempt limit.
- Timeouts and runtime errors use the same bounded attempt lifecycle.
- A bidder exhausting attempts is excluded from the round.
- Once all bidders settle, award when the minimum valid-bid threshold is met.
- Otherwise apply exactly one configured fallback:
  `default_agent | round_robin | fail`.
- Winning execution failure does not silently promote the runner-up.
- A stale or wrong-lease completion records bounded evidence and cannot commit.
- Stop cancels the active wave; End is a separate idle terminal operation.

## Valid and invalid plan examples

Valid parallel plan inside a bid:

```json
{"mode":"parallel","assignments":[
  {"agentId":"agent-a","position":1,"instruction":"Assess users."},
  {"agentId":"agent-b","position":2,"instruction":"Assess operations."}
]}
```

Invalid (gapped positions and duplicate participant):

```json
{"mode":"sequential","assignments":[
  {"agentId":"agent-a","position":1,"instruction":"First."},
  {"agentId":"agent-a","position":3,"instruction":"Again."}
]}
```

The retry feedback names the structural rules but does not echo the
Agent-supplied ids or instruction content.

## Feedback

`accepted | rejected` feedback attaches to an award without mutating it.
Mechanical execution success is tracked separately from user acceptance.
Confidence is labelled primarily self-reported until enough rated history
exists.
