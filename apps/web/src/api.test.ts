import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, request } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("request", () => {
  it("normalizes the structured coordination error envelope", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: {
        code: "VALIDATION_FAILED",
        message: "Request validation failed",
        fieldErrors: { objective: ["Required"] },
      },
    }), { status: 400, headers: { "content-type": "application/json" } })));

    const failure = await request("/api/coordination-runs").catch((reason) => reason);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({
      status: 400,
      code: "VALIDATION_FAILED",
      message: "Request validation failed",
      fieldErrors: { objective: ["Required"] },
    });
  });

  it("keeps compatibility with legacy string errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "Legacy failure" }), { status: 500 })));
    await expect(request("/api/legacy")).rejects.toMatchObject({ message: "Legacy failure", status: 500 });
  });
});
