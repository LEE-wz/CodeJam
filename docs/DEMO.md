# Session Demo

A three-minute demonstration of Session: several Agents holding one durable
conversation, with the middleware — not the models — providing every guarantee.

> **Note on rehearsal.** The timing range below is an estimate from component
> measurements, not from a completed rehearsal. `P15-13` (three full rehearsals
> and an outside reader) has not been run. Treat the beats as a script to
> rehearse, not as verified timings.

## Setup

### Before the room

1. Start the stack and confirm health:
   ```bash
   docker compose up -d
   curl -fsS localhost:3001/api/health
   ```
2. Create the Agents from [AGENT_TEMPLATES.md](AGENT_TEMPLATES.md). For a
   three-minute demo, **four participants plus one coordinator** is the right
   size — ten is impressive but slow, and each participant is a live model call.
3. Confirm every Agent shows `ready`. A participant that is not exactly `ready`
   makes Start fail with `AGENT_NOT_READY`.
4. Have a completed fallback run open in a second tab (see *Fallback* below).
5. Check provider capacity. A wave is N concurrent model calls; sustained `429`
   is the most common way a live demo dies.

### Seeded objective

> Design the trust and safety model for a peer-to-peer marketplace.

## The three-minute script

### Beat 1 — Create the session (~20s)

Create a session, name it, paste the objective, select the participants, leave
planning on **coordinator**.

**Say:** "These Agents have never spoken to each other. There's no shared memory
between them — the middleware holds the transcript."

**Expect:** status `created`.

### Beat 2 — First prompt, ordered round (~45s)

Start, then send:

> Which risks matter most for a first launch?

**Say:** "The coordinator Agent proposes who answers and in what order. It's a
proposal — the backend validates its shape and does the scheduling itself. The
Agent can't schedule anything."

**Expect:** a `session_plan` commits, then turns commit in `position` order.
Transcript shows per-Agent attribution. Status returns to `awaiting_input`.

### Beat 3 — Fan-out round (~40s)

> Each of you: name one thing you'd cut from v1.

**Say:** "Independent question, so the plan comes back parallel. These are
running concurrently, capped by `maxParallelTurns` — every one is a live model
process, so the cap is a real resource control."

**Expect:** several turns in flight at once, never more than the cap. Messages
appear in `transcriptSequence` order with correct attribution.

### Beat 4 — Follow-up in the same session (~25s)

> Given all that, what ships first?

**Say:** "Same session, third prompt. The transcript persists — this is a
conversation, not three separate runs."

**Expect:** contributions reference earlier turns.

### Beat 5 — Stop versus End (~20s)

Send a prompt, then hit **Stop** mid-wave.

**Say:** "Stop cancels the whole wave. Late results from cancelled attempts are
ignored — they can't change state, because only a live lease can commit. Stop
halts work; End finishes the session. Different actions."

**Expect:** every running attempt cancelled, every turn settled, no stuck
spinner.

### Beat 6 — Evidence (~30s)

Open the timeline.

**Say:** "Every turn, attempt, artifact, and decision, with reasons. And notice
what's *not* here — no prompts, no raw output, no lease tokens. Events carry
bounded metadata behind an allowlist, so a secret can't reach the timeline even
by being passed under a new key."

## Failure demos

### Invalid output, recovered

Include the **deliberately unreliable Agent**. Its first turn emits prose
instead of JSON.

**Expect:** `attempt.invalid_output`, then a retry on the same Agent with
structured feedback, then a commit.

**Say:** "That's a real model failure caught by real validation. The middleware
retried it with feedback about what was wrong. Nothing was simulated."

### Rejected plan

Point the coordinator at a rule that produces a structurally invalid plan (for
example, positions starting at 2).

**Expect:** the plan is rejected and retried within the attempt budget.

**Say:** "Structurally invalid, so it never got scheduled. The middleware checks
shape — participants, distinct ids, contiguous positions, bounded instructions.
It does not check whether the plan is a *good* plan. That's deliberate: the
middleware guarantees determinism, not quality."

### Restart mid-session

With the session in `awaiting_input`, restart the server, then send another
prompt.

**Expect:** the session is still alive and accepts the prompt.

**Say:** "A session with no work in flight survives a restart. A run that *was*
mid-flight fails honestly with `SERVER_RESTARTED` — we don't pretend we can
reconstruct an external model call. Either way the Agents come back usable."

## Fallbacks

If the live path fails, switch to a recorded run. Label it on screen as a
recording — never present a recording as live.

Prepare one each of: an ordered session, a parallel session, a multi-prompt
session that survived a restart, and a stored plan-rejection recovery.

> **Status:** these recordings are `P15-12` and have **not** been captured. They
> require live provider capacity. Capture them before demoing.

### Common failures

| Symptom | Cause | Response |
|---|---|---|
| Waves fail in bursts, `MAX_ATTEMPTS_EXCEEDED` | Provider `429` | Switch to fallback. Fewer participants next run. |
| Start refused, `AGENT_NOT_READY` | A participant isn't `ready` | Restart that Agent. |
| Agent won't join | Reserved by an active run | End or stop the other session. |
| Slow first render | Long transcript | Use a fresh session for the demo. |

### Latency fallback

If a wave is slow, narrate the timeline while it runs — the evidence view is
the point, and it fills naturally. If it exceeds ~90 seconds, switch to the
recording.

### Round-robin fallback

If the coordinator is unreliable, recreate the session with
`sessionPlanning: "round_robin"`. Membership is then derived — the participants
who have not yet answered the current prompt — with no coordinator turn and no
plan to reject. Less to show, but nothing to go wrong.

## Reset between runs

```bash
docker compose down
rm -rf data/ workspaces/
docker compose up -d
```

This clears **all** runtime state including Agents. To keep Agents, End the
session instead and start a fresh one.

## Honest limitations to state

- Single process, single user. No identity, tenancy, or audit.
- Interrupted runs fail rather than resume, by design.
- Comfortable to ~2,000 committed turns; requests past 50,000 are refused.
- The middleware guarantees structure and determinism, never quality.

## Related

- [Agent templates](AGENT_TEMPLATES.md)
- [Operations](COORDINATION_OPERATIONS.md)
- [Architecture](COORDINATION_ARCHITECTURE.md)
