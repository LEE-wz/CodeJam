import { request } from "./api";
import type {
  CoordinationRun,
  CoordinationRunDetails,
  CreateSessionRunRequest,
  SessionMessageRouting,
} from "./coordination-types";

const base = "/api/coordination-runs";

export const coordinationApi = {
  list: () => request<{ runs: CoordinationRun[] }>(base),
  create: (body: CreateSessionRunRequest) =>
    request<{ run: CoordinationRun }>(base, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  detail: (id: string, signal?: AbortSignal, sinceSequence?: number) =>
    request<CoordinationRunDetails>(
      `${base}/${id}${sinceSequence === undefined ? "" : `?sinceSequence=${sinceSequence}`}`,
      { signal },
    ),
  sendMessage: (
    id: string,
    content: string,
    clientMessageId: string,
    routing?: SessionMessageRouting,
  ) =>
    request<{ run: CoordinationRun; accepted: true }>(`${base}/${id}/messages`, {
      method: "POST",
      body: JSON.stringify({
        content,
        clientMessageId,
        ...(routing && Object.keys(routing).length > 0 ? { routing } : {}),
      }),
    }),
  awardFeedback: (id: string, awardId: string, decision: "accepted" | "rejected") =>
    request<{ run: CoordinationRun; accepted: true }>(
      `${base}/${id}/awards/${awardId}/feedback`,
      { method: "POST", body: JSON.stringify({ decision }) },
    ),
  start: (id: string) =>
    request<{ run: CoordinationRun; accepted: true }>(`${base}/${id}/start`, {
      method: "POST",
    }),
  stop: (id: string) =>
    request<{ run: CoordinationRun; accepted: true }>(`${base}/${id}/stop`, {
      method: "POST",
    }),
  end: (id: string) =>
    request<{ run: CoordinationRun; accepted: true }>(`${base}/${id}/end`, {
      method: "POST",
    }),
};
