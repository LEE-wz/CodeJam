# Parallel Phase 14 — Adaptive Auction Coordination

**Track:** Auction alternative. This sheet does not replace or amend
[`../14-coordinator-planning.md`](../14-coordinator-planning.md).  
**Goal:** route simple prompts directly without a multi-Agent tax, collect
specialised plans for prompts that warrant an auction, select a winner through
a deterministic and auditable score, and execute either the winning Agent alone
or its validated team plan.  
**Ends at:** Auction Checkpoint 14 — one long-lived session demonstrates direct,
explicit-auction, and automatic-escalation rounds; awards are restart-safe;
actual and projected token use are separated; and an awarded team plan performs
both ordered and parallel coordination.

## Entry criteria

- Parallel Auction Checkpoint 13 is complete on its own branch with no flaky
  wave, stop, restart, usage, or isolation tests.
- The auction mini-RFC identifies this sheet as the alternative Phase 14
  authority and records the routing, bid, award, scoring, publication, fallback,
  and feedback contracts below.
- Agent specialisations are visible, bounded, and snapshotted into the session.
- Actual usage reaches coordination attempts and fresh bid threads are proven.
- The countdown engine still exists and remains tested. Delete it only after an
  awarded sequential team plan replaces its acceptance demonstration.

If "best", confidence, projected usage, direct acceptance, minimum valid bids,
or user feedback is not defined mechanically, stop before implementation. The
backend may validate and score declared evidence; it must not pretend that this
proves semantic plan quality.

## Required outputs

- `direct`, `auction`, and `auto` routing policies with explicit user override.
- A deterministic primary-Agent selector that needs no model call.
- Strict `session_bid` and backend-authored `session_award` artifacts.
- A one-call automatic fast path whose primary candidate is either published or
  reused as the first bid.
- Deterministic, versioned confidence-and-cost scoring with hard eligibility
  limits and stable tie-breaking.
- Bounded fallback for invalid, missing, timed-out, or over-budget bids.
- Single-winner, sequential-team, and parallel-team execution.
- Separate actual bidding usage, projected execution usage, and actual execution
  usage in the API and UI.
- Optional user outcome feedback for later calibration without blocking a
  session.
- Restart, race, budget, scoring, failure, and end-to-end tests.

## Routing contract

Add a session policy:

```ts
interface SessionAuctionPolicy {
  routingMode: "direct" | "auction" | "auto";
  defaultAgentId?: AgentId;
  directConfidenceThresholdBps: number; // recommended default 8000
  directOutputTokenBudget: number;      // recommended default 4000
  minimumValidBids: number;             // recommended default 2
  maxBidOutputTokens: number;           // hard cap for each short bid
  maxBidAttempts: number;
  auctionExecutionTokenBudget: number;
  fallback: "default_agent" | "round_robin" | "fail";
  scoringVersion: "confidence_cost_v1";
}
```

All defaults and bounds are backend-owned and validated by the route and
service. A user message may request `direct` or `auction` for that round; it may
not increase budgets, concurrency, attempts, or participant scope. The UI shows
`Auto`, `Direct`, and `Auction`, with `Auto` as the proposed default.

### Deterministic primary selection

Choosing the first Agent must not itself require an endpoint call. Use this
stable order:

1. Agent explicitly selected for the round;
2. previous awarded Agent for a follow-up in the same session;
3. highest bounded specialisation-tag match, using a documented local matcher;
4. session `defaultAgentId`;
5. first available participant in stored participant order.

Tag matching is advisory routing, never a quality claim. Ties resolve by stored
participant order and then Agent ID. If the selected primary is busy, use the
same ordered candidates before applying fallback.

### Direct mode

Schedule one ordinary execution turn for the selected primary. There is no bid
wave and no selection call. The result is a normal `session_message` and the
round returns to `awaiting_input`.

Direct failure may trigger an auction only when
`auctionOnDirectFailure` is enabled by policy; otherwise it follows the ordinary
execution retry/failure contract. This prevents a hidden cost expansion when a
caller explicitly selected direct execution.

### Auction mode

Schedule one `session_bid` turn for every eligible participant as a
`session_bidding` wave. Wait for all bid attempts to settle, validate the set,
apply the minimum-valid-bid rule, commit exactly one award, and then execute its
plan.

### Auto mode without a wasted simple-task call

Schedule a bid-capable primary turn. The same structured artifact contains a
bounded candidate answer and plan, so the call has value in both outcomes:

- If it recommends direct execution and passes the confidence, budget, and
  policy gates, atomically award and publish its candidate answer. No other
  endpoint call occurs.
- If it recommends auction, fails a direct gate, or cannot produce a valid
  candidate, reuse any valid plan/metrics as the primary bid and request bids
  from the remaining eligible participants.
- If the primary attempt fails completely, start the remaining bid wave without
  it. Apply the bounded no-valid-bid fallback after settlement.

The backend does not parse prompt text to decide semantic complexity. Explicit
user mode, structured policy, specialization metadata, and the primary's
bounded recommendation determine routing. High-risk use cases should be marked
through structured request metadata or forced to `auction`; keyword lists are
not a safety boundary.

## Bid contract

Add turn kind and artifact type `session_bid`. Use a strict discriminated
schema, with all text and arrays bounded:

```jsonc
{
  "schemaVersion": 1,
  "type": "session_bid",
  "recommendation": "direct" | "auction",
  "candidateAnswer": "required when recommendation is direct",
  "plan": {
    "summary": "bounded approach",
    "mode": "single" | "sequential" | "parallel",
    "assignments": [
      {
        "agentId": "participant id",
        "position": 1,
        "instruction": "bounded instruction"
      }
    ],
    "risks": ["bounded risk"],
    "assumptions": ["bounded assumption"]
  },
  "confidenceBps": 7800,
  "estimatedOutputTokens": 1800
}
```

The platform computes estimated execution input from the exact prompt shape or
a documented conservative estimator. Agents do not declare input size. Validate
mechanically:

- the recommendation and plan mode are known literals;
- confidence is an integer from 0 through 10,000;
- output estimate is a positive integer within the hard policy ceiling;
- direct recommendation has a non-empty bounded candidate answer;
- every assignment Agent is a snapshotted session participant;
- Agent IDs are distinct and positions are contiguous from one;
- `single` has exactly one assignment to the bidder;
- sequential and parallel assignment counts fit participant and policy bounds;
- all instructions, risks, assumptions, arrays, and the total artifact are
  bounded;
- no bid field changes policy, scoring weights, participants, or budget.

Bid prompts contain the same user message, transcript window, objective, output
contract, and policy-visible budgets. Only the snapshotted specialisation block
changes per Agent. Losing bids are evidence, not input to other bidders.

## Award and scoring contract

`session_award` is backend-authored and immutable:

```jsonc
{
  "schemaVersion": 1,
  "type": "session_award",
  "userArtifactId": "current round key",
  "winningBidArtifactId": "selected bid",
  "selectedAgentId": "winner",
  "outcome": "publish_candidate" | "execute_plan",
  "scoringVersion": "confidence_cost_v1",
  "scoreBps": 6240,
  "components": {
    "calibratedConfidenceBps": 7200,
    "normalizedProjectedCostBps": 3100,
    "reliabilityPenaltyBps": 200
  },
  "estimatedExecution": {
    "inputTokens": 2400,
    "outputTokens": 1800
  }
}
```

The workflow derives whether an award already exists for `lastUserArtifactId`.
Award creation uses one expected-version mutation, so restart and competing
loops can never produce two awards.

### Eligibility before ranking

Reject a bid from ranking when it is structurally invalid, exceeds a hard
budget, references an unavailable participant, proposes concurrency above
policy, or cannot be executed within the remaining session turn ceiling. Keep
the attempt and rejection as evidence.

Actual bid tokens are already spent and therefore are reported in total session
cost but do not make one remaining execution cheaper than another. Rank by
projected execution cost, not sunk bid cost.

### Versioned deterministic score

For `confidence_cost_v1`, use integer basis-point arithmetic with no
floating-point or iteration-order dependence:

```text
score =
  70% × calibrated confidence
  − 25% × normalized projected execution cost
  −  5% × reliability penalty
```

The precise integer rounding and cost weights for input, cached input, and
output tokens must be specified in the mini-RFC and snapshot-tested. Apply:

- a cold-start confidence penalty or neutral prior;
- a bounded historical calibration penalty when rated outcomes exist;
- a bounded reliability penalty for recent execution failures and severe token
  underestimation;
- stable tie-breaking by higher calibrated confidence, lower projected cost,
  stored participant order, then Agent ID.

The UI must call this the highest-ranked valid bid under the configured scoring
version, not the objectively best Agent. The backend never semantically grades a
plan.

## Publication and execution

### Accepted direct candidate

When Auto accepts the primary candidate, one atomic repository command commits
the award and publishes a normalized `session_message` projection containing
the bid's candidate answer. The message records `sourceBidArtifactId` and the
selected Agent as provenance, receives the next transcript sequence, and is the
only bid content shown as chat. This backend publication is not a second model
turn and cannot alter the candidate text beyond the normal bounded
normalization.

### Winning plan

- `single`: schedule one execution turn for the winning Agent with the user
  prompt, transcript, winning plan, and its assignment.
- `sequential`: schedule assignments strictly by position; each later Agent sees
  earlier committed messages from this awarded round.
- `parallel`: schedule one bounded execution wave using the parallel Phase 13
  supervisor.

Only the winning bid is included in execution prompts. Losing bids remain in
the evidence ledger and are excluded from transcript context. An invalid award
state fails safely rather than silently re-ranking with different inputs.

## Fallback and failure behaviour

- Invalid bid output retries on the same Agent within `maxBidAttempts`.
- A bidder that exhausts attempts is excluded from the round, not from the
  session.
- Once all bidders settle, award if at least `minimumValidBids` remain.
- If fewer valid bids remain, apply the configured bounded fallback exactly
  once: default Agent, round-robin Agent, or safe failure.
- A fallback Agent still receives an ordinary bounded execution turn; the
  backend never fabricates a model answer.
- Winning execution failure follows strict execution retry and failure
  semantics. It does not silently award the runner-up because that would make
  recovery dependent on timing and create surprising duplicate work.
- Stop cancels the active bid or execution wave and returns the session to
  `awaiting_input`; End remains terminal and requires no active work.
- Restart re-derives the next action from committed bids and award. It never
  reruns a settled bid, changes a committed winner, or duplicates publication.

## Feedback and calibration

Add optional per-award feedback such as `accepted | rejected`, with one current
rating per award and a durable audit event containing IDs and the enum only.
Feedback is not required to continue the session and never mutates the award.
It feeds later confidence calibration as prior evidence.

Mechanical execution success is tracked separately from user acceptance. A
well-formed response is not automatically a good response. With insufficient
rated history, the cold-start rule remains active and the UI labels confidence
as primarily self-reported.

## Tasks

### Contracts and routing

- [x] **PA14-01** Amend the auction-branch mini-RFC with the routing modes,
  primary selection, bid schema, scoring version, publication projection,
  fallback, feedback, and countdown replacement. Do not edit the main Phase 14
  sheet.
- [x] **PA14-02** Add the auction policy and route validation, including hard
  budgets, bid limits, valid-bid threshold, direct threshold, fallback, and
  scoring version. Old sessions normalize to a documented non-auction mode and
  remain readable.
- [x] **PA14-03** Implement deterministic primary selection with explicit
  selection, sticky follow-up ownership, specialization-tag match, default
  Agent, stable participant-order fallback, and busy-Agent handling.
- [x] **PA14-04** Implement direct routing as one ordinary execution turn with no
  bid wave. Prove that explicit direct mode cannot silently expand into an
  auction unless its policy says so.

### Bid and award protocol

- [x] **PA14-05** Add `session_bid` turn/artifact types, strict schema,
  exhaustive maps, payload caps, prompt template, context visibility, parsing,
  and mechanical cross-field validation.
- [x] **PA14-06** Schedule an atomic bid wave for every eligible participant in
  explicit auction mode and for remaining participants after Auto escalation.
  Exactly one bid opportunity exists per Agent per user-message round; retries
  do not create another opportunity.
- [ ] **PA14-07** Implement the one-call Auto primary candidate. Accept and
  publish it only when recommendation, confidence, budget, and policy gates all
  pass; otherwise reuse the valid artifact as the primary bid and expand the
  wave.
- [ ] **PA14-08** Implement deterministic eligibility, token-cost normalization,
  cold-start handling, calibration/reliability penalties, score arithmetic, and
  stable ties. Snapshot every boundary and publish a human-readable scoring
  explanation that contains no prompt or raw output.
- [ ] **PA14-09** Add backend-authored `session_award` and atomic award creation.
  Prove one award per `lastUserArtifactId` under concurrent calls and restart.

### Publication and winning execution

- [ ] **PA14-10** Implement atomic direct-candidate award and transcript
  publication with `sourceBidArtifactId`, selected-Agent provenance, and one
  transcript sequence. Losing and escalated candidates never appear in chat.
- [ ] **PA14-11** Execute single-Agent winning plans through a fresh thread with
  the winning assignment and plan explicitly included in the bounded prompt.
- [ ] **PA14-12** Execute sequential and parallel winning plans using the same
  structural assignment rules and Phase 13 execution supervisor. Preserve the
  main plan's ordered-transcript property without an engine-side semantic
  validator.
- [ ] **PA14-13** Implement the no-valid-bid fallback, strict winning-execution
  failure, stop, restart, and end semantics. All paths must be finite and
  restart-derived from durable evidence.

### API and web experience

- [ ] **PA14-14** Extend create-session and user-message APIs with routing mode,
  optional Agent selection, and structured risk/coordination preference without
  allowing per-message budget escalation.
- [ ] **PA14-15** Expose bid and award evidence, actual bid usage, projected
  execution usage, actual execution usage, scoring components, fallbacks, and
  partial bidder failure through the delta read model. Continue stripping
  leases, provider thread IDs, prompts, and raw rejected output.
- [ ] **PA14-16** Add UI controls for Auto, Direct, and Auction; selected/default
  Agent; a working state distinguishing evaluating bids from executing; an award
  summary; token estimates versus actuals; and an expandable evidence-only bid
  panel. The chat transcript shows only user messages and published responses.
- [ ] **PA14-17** Add optional award feedback and calibration labels. Never imply
  that unrated self-confidence has been objectively verified.

### Countdown removal and compatibility

- [ ] **PA14-18** Demonstrate the countdown acceptance scenario through an
  awarded sequential team plan and a fan-out scenario through an awarded
  parallel plan. Only then delete the countdown engine branch on the auction
  implementation branch while retaining stored countdown read/render support.
- [ ] **PA14-19** Keep verified-handoff behaviour and historical session data
  readable. Add fixtures for pre-auction sessions, old countdown sessions, and
  auction sessions with partial or absent optional usage.

### Tests and rehearsal

- [ ] **PA14-20** Add routing tests for explicit Direct, explicit Auction, Auto
  direct acceptance, every Auto escalation gate, sticky follow-up, specialization
  ties, unavailable primary, per-message override, and forbidden budget
  escalation.
- [ ] **PA14-21** Add bid-validation tests for every bound and cross-field rule,
  foreign or duplicate Agent IDs, invalid positions, unknown fields, malformed
  JSON, wrong artifact type, over-budget estimates, and injected policy changes.
- [ ] **PA14-22** Add scorer tests for cold start, exact thresholds, integer
  rounding, cached-input weighting, historical penalties, underestimation,
  stable ties, participant-order independence, and version rejection.
- [ ] **PA14-23** Add repository/workflow races: restart mid-bid wave, restart
  after bids before award, competing awards, restart after award before
  execution, direct publication collision, stop during bidding, stop during
  execution, feedback racing a read, and duplicate user submission.
- [ ] **PA14-24** Add failure tests: some invalid bidders, all invalid bidders,
  busy bidders, minimum-valid-bid boundary, each fallback, winner timeout,
  winner retry exhaustion, and proof that a runner-up is never silently
  executed.
- [ ] **PA14-25** Add token-accounting tests separating all actual bid attempts,
  projected winning execution, actual winning execution, cached input, retry
  overhead, and the direct fast path. Never claim a provider cost when only
  token counts are known.
- [ ] **PA14-26** Add web tests for all routing controls and states, evidence
  expansion, transcript exclusion of losing bids, award attribution, estimates
  versus actuals, feedback, accessibility, polling cleanup, and narrow-screen
  rendering.
- [ ] **PA14-27** Run a real multi-prompt rehearsal in one ten-Agent session:
  one simple Auto prompt accepted in a single call; one explicit Auction with a
  single winner; one Auto escalation; one awarded sequential countdown; one
  awarded parallel fan-out; one partial bidder failure; one stop-and-resume; and
  one server restart between bid settlement and award. Record every call's
  usage and wall-clock timing.

## Requirements and invariants

- Direct mode incurs exactly one model execution unless explicit policy permits
  failure escalation.
- Auto's primary call is never discarded: it becomes the published answer or a
  durable bid when valid.
- Every eligible bidder sees equivalent task context plus only its own
  snapshotted specialisation.
- Scoring is deterministic, versioned, integer-based, and reproducible from
  committed evidence.
- The highest-ranked valid bid is not described as objectively best.
- Actual bidding usage, projected execution usage, and actual execution usage
  are never conflated.
- Exactly one award exists per user-message round.
- A committed award is immutable and is not replaced after failure.
- Losing bids never enter another Agent's prompt or the chat transcript.
- Single, sequential, and parallel execution share the same lease, version,
  stop, retry, and restart guarantees.
- The backend validates structure and policy compliance, not semantic quality.
- Stored history, terminal immutability, redaction, and verified handoff remain
  intact.

## Verification

Use the standard Docker Compose verification command from
[`../../README.md`](../../README.md). Run scorer and race suites repeatedly
before the full check. Real rehearsals must use synthetic prompts and must not
record secrets, raw private prompts, provider credentials, or lease tokens.

## Completion gate

Auction Phase 14 is complete only when:

- a simple Auto prompt produces a useful response with one endpoint call;
- explicit Auction and Auto escalation both collect specialised valid bids and
  commit exactly one reproducible award;
- the awarded single Agent executes successfully with correct attribution;
- awarded sequential and parallel plans both execute correctly;
- partial bidder failure proceeds safely and all-invalid fallback is bounded;
- restart at every bid/award/execution boundary creates no duplicate work;
- actual and projected token evidence reconciles with Agent runs;
- losing bids stay out of prompts and chat while remaining inspectable evidence;
- countdown engine removal preserves stored countdown history;
- verified handoff and pre-auction session fixtures pass unchanged;
- the full Docker Compose `npm run check` passes on the auction branch.

## Manual comparison suggestions

After both the main and auction Phase 14 branches satisfy their own gates, run
the common comparison suite described in [`README.md`](README.md). Review the
recorded implementations manually. Useful questions include:

- Which branch completes more of its documented contract without exceptions?
- Which produces more accurate and useful answers under blinded review?
- Does auction selection improve specialist and ambiguous tasks enough to repay
  its token and latency overhead?
- Does the Auto path actually keep simple prompts near single-Agent cost?
- Which state machine is easier to understand, test, recover, and operate?
- Are fallback and failure behaviours honest and predictable in the UI?
- Which limitations are architectural, and which are implementation defects
  that can reasonably be corrected?

Do not encode an automatic winner or mandatory score threshold in the
documentation. Implementation completeness, behavioural accuracy, operational
risk, and product fit should be judged together once both branches have real
evidence.
