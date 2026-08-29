import { describe, expect, it } from "vitest";
import { CoordinationService } from "./service.js";
import { DeterministicIdGenerator, FixedClock } from "./testing/controls.js";
import {
  FakeAgentDirectory,
  FakeArtifactProtocol,
  FakeContextBuilder,
  FakeCoordinationRepository,
  FakeWorkflow,
  ScriptedCoordinationRuntime,
} from "./testing/fakes.js";

describe("Phase 0 coordination contracts", () => {
  it("constructs CoordinationService from shared deterministic fakes", () => {
    const service = new CoordinationService({
      agentDirectory: new FakeAgentDirectory(),
      repository: new FakeCoordinationRepository(),
      workflow: new FakeWorkflow(),
      contextBuilder: new FakeContextBuilder(),
      artifactProtocol: new FakeArtifactProtocol(),
      runtime: new ScriptedCoordinationRuntime(),
      clock: new FixedClock(),
      ids: new DeterministicIdGenerator(),
    });

    expect(service).toBeInstanceOf(CoordinationService);
  });
});
