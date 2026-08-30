/**
 * Shell module for the shared-session workflow (P5-06).
 *
 * Phase 5 freezes the contract and proves it compiles and can be registered in
 * the service dispatch. It deliberately implements no routing: round-robin
 * selection, countdown completion at 1, free-chat completion on unanimous
 * `done` or `maxTurns`, the turn ceiling, and the malformed-shared-state guards
 * are all P6-01, with their table tests in P6-03.
 *
 * The shell throws rather than returning a decision. A session run cannot reach
 * it in Phase 5 -- nothing schedules a session turn yet -- so the throw is a
 * tripwire, not a code path: if one ever does reach it, the failure names the
 * task that was skipped instead of silently mis-routing a run.
 */
import type { SharedSessionWorkflow, WorkflowDecision, WorkflowView } from "./contracts.js";

export type { SharedSessionWorkflow } from "./contracts.js";

export class SharedSessionWorkflowV1 implements SharedSessionWorkflow {
  decideNext(_view: WorkflowView): WorkflowDecision {
    throw new Error("shared session routing lands in P6-01");
  }
}
