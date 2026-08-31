import { request } from "./api";
import type {
  CoordinationRun,
  CoordinationRunDetails,
  CreateSessionRunRequest,
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
  sendMessage: (id: string, content: string, clientMessageId: string) =>
    request<{ run: CoordinationRun; accepted: true }>(`${base}/${id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content, clientMessageId }),
    }),
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
