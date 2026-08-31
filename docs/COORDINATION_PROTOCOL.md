# Session Protocol

What an Agent is allowed to say, how the middleware validates it, and what
happens when it says something invalid.

The governing principle, unchanged since Phase 0: **the Agent proposes, the
backend disposes.** Every artifact below is *input* to a state machine. No field
in any payload can change policy, participants, limits, scheduling, or another
run. Validation is structural only — the middleware never judges whether a
contribution is *good*.

## 1. Artifact types

A session run uses three artifact types. (`proposal`, `review`, and `final`
belong to the older verified-handoff workflow, which the server still supports
but the Session UI no longer surfaces.)

| Type | Author | Purpose |
|---|---|---|
| `user_message` | The user | A prompt entering the transcript |
| `session_plan` | A coordinator Agent | A proposal for who answers this round |
| `session_message` | A participant Agent | One contribution to the transcript |

Every artifact carries `schemaVersion: 1` and a `type` discriminator. Agent
artifacts additionally carry `turnId`, `createdByRole`, `createdByAgentId`,
`sizeChars`, and `createdAt`. A `user_message` carries `createdBy: { kind:
"user" }` instead, and may carry a client-supplied idempotency key.

All transcript entries — user and Agent alike — share a single
`transcriptSequence`, giving one total order over the conversation.

## 2. `user_message`

```json
{
  "schemaVersion": 1,
  "type": "user_message",
  "content": "Draft the escrow release rules for the marketplace."
}
```

`content` is bounded by `messageMinChars` (1) and a larger user bound than an
Agent message. It is durable: this is the transcript, and it is meant to
persist. It never appears in events.

## 3. `session_message`

One participant's contribution.

```json
{
  "schemaVersion": 1,
  "type": "session_message",
  "content": "Escrow should release on confirmed delivery, not on shipment.",
  "done": true
}
```

| Field | Rule |
|---|---|
| `content` | 1–500 characters (`messageMinChars`–`messageMaxChars`) |
| `done` | Optional boolean. **Advisory only.** |

### What `done` actually does

`done` is a signal, not a command. **An Agent never ends a session.** What the
signal means depends on how the round is driven:

- Under `sessionPlanning: "round_robin"`, a wave ends when every participant's
  most recent message *in that wave* carries `done: true` — unanimous consent
  across one full round. A later message from the same participant that omits
  the flag clears that participant's signal.
- Under `sessionPlanning: "coordinator"` (the default since P14-05), `done` is
  **not consulted at all**. The round ends when every assignment in the
  committed plan has committed.

In both cases the round ends by returning the run to `awaiting_input`, where it
accepts another prompt. It does **not** complete the run. A session becomes
terminal only on an explicit user End, on failure, or at the hard `maxTurns`
ceiling — which fails the run with `MAX_TURNS_EXCEEDED` rather than completing
it.

All of this is computed from committed artifacts by backend code. The trust
boundary is unchanged.

`done` is valid on any session message. The older rule that rejected it on a
countdown message was removed with that protocol in P14-07.

## 4. `session_plan`

A coordinator Agent's proposal for one round.

```json
{
  "schemaVersion": 1,
  "type": "session_plan",
  "mode": "sequential",
  "assignments": [
    { "agentId": "a1e...", "position": 1, "instruction": "State the payment risk." },
    { "agentId": "b2f...", "position": 2, "instruction": "Respond with the abuse angle." }
  ]
}
```

| Field | Rule |
|---|---|
| `mode` | `"sequential"` or `"parallel"` |
| `assignments[].agentId` | Must be a participant of this run |
| `assignments[].position` | 1-based, contiguous from 1 to the assignment count, no duplicates |
| `assignments[].instruction` | 1–500 characters (`planInstructionMaxChars`) |

In `sequential` mode `position` is the execution order. In `parallel` mode it
only orders assignments for display, because every assignment is scheduled in
one wave.

### What the middleware validates, and what it refuses to

**Validated (structural):** every `agentId` is a participant; ids are distinct;
positions are contiguous and 1-based; instructions are non-empty and bounded;
the assignment count is within the participant count.

**Not validated (substantive):** whether the plan is sensible, whether the right
Agent was chosen, whether the instructions are good. The middleware has no
opinion. A structurally valid plan that is strategically poor is accepted and
executed.

A plan that fails structural validation is rejected as invalid output and
retried within the turn's attempt budget, exactly like any other malformed
artifact. Scheduling, leases, limits, cancellation, and completion remain
backend-owned throughout.

## 5. Parsing and validation order

An attempt's raw output is processed in a fixed order. Each step can fail, and
the step that fails determines the event recorded.

1. **Size check.** Output beyond `outputMaxChars` fails with `OUTPUT_TOO_LARGE`.
2. **Fence stripping.** At most **one** outer Markdown JSON code fence is
   removed (ADR-05). This tolerates a common model habit without building a
   permissive parser. A second fence is not stripped.
3. **JSON parse.** A parse failure is `INVALID_AGENT_OUTPUT`.
4. **Discriminator check.** `schemaVersion` must be `1` and `type` must match
   the artifact the turn expects. A `session_message` where a `session_plan` was
   scheduled is invalid, and vice versa.
5. **Schema validation.** Zod validates the payload shape and field bounds.
6. **Referential validation.** Plan-specific rules from §4 — participant
   membership, distinct ids, contiguous positions.

Only after all six does the artifact reach `commitAcceptedArtifact`, and only
with a live lease.

## 6. Retry semantics

An invalid or failed attempt is retried on the **same** Agent, within the turn's
`maxAttemptsPerTurn` budget (ADR-06). The retry prompt carries structured
feedback about what was wrong — the failing issue codes, not a raw diff.

A retry is not a revision. In the verified-handoff workflow, a Critic rejection
is a *successful committed review* that increments the revision counter and
routes back to the Planner (ADR-07); that is a workflow transition, not an
error path. A session run has no revision concept.

Exhausting the attempt budget fails the run with `MAX_ATTEMPTS_EXCEEDED`. Under
a parallel wave this happens only after every sibling has settled, so no attempt
is left orphaned mid-flight. A sibling's failure never aborts its siblings.

## 7. Scoped context and the recency window

An Agent does not receive the raw database. `RoleScopedContextBuilder` renders
the transcript as `Name: content` lines and applies a fixed truncation ladder
against `policy.contextMaxChars` (default 12,000).

Two properties matter operationally:

- **Scope.** An Agent sees the shared transcript and its own instruction. It
  does not see lease tokens, other runs, policy internals, or the raw state
  machine.
- **Recency.** When the transcript exceeds the budget, older entries are dropped
  before newer ones. A long session therefore prompts against a recent window,
  not the whole history. This is why a very long session degrades in coherence
  before it degrades in performance.

A session turn pins the transcript it was built from as a single
`inputThroughSequence` bound rather than listing every artifact id — the P15-05
data-model fix that made storage linear.

## 8. Invalid examples

Rejected — `content` exceeds `messageMaxChars`:

```json
{ "schemaVersion": 1, "type": "session_message", "content": "<501+ characters>" }
```

Rejected — positions are not contiguous from 1:

```json
{
  "schemaVersion": 1, "type": "session_plan", "mode": "sequential",
  "assignments": [
    { "agentId": "a1e...", "position": 1, "instruction": "..." },
    { "agentId": "b2f...", "position": 3, "instruction": "..." }
  ]
}
```

Rejected — `agentId` is not a participant of this run:

```json
{
  "schemaVersion": 1, "type": "session_plan", "mode": "parallel",
  "assignments": [
    { "agentId": "not-a-participant", "position": 1, "instruction": "..." }
  ]
}
```

Rejected — wrong artifact type for the scheduled turn:

```json
{ "schemaVersion": 1, "type": "session_plan", "mode": "parallel", "assignments": [] }
```

when a `session_message` was expected. (An empty `assignments` array is also
invalid on its own.)

## 9. Related documents

- [Architecture](COORDINATION_ARCHITECTURE.md) — where validation sits in the pipeline
- [API](COORDINATION_API.md) — how artifacts reach the client
- [Operations](COORDINATION_OPERATIONS.md) — limits and redaction
- [Decisions](DECISIONS.md) — ADR-04, ADR-05, ADR-06, ADR-07
