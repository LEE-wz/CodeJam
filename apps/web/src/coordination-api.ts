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
  detail: (id: string, signal?: AbortSignal) =>
    request<CoordinationRunDetails>(`${base}/${id}`, { signal }),
  start: (id: string) =>
    request<{ run: CoordinationRun; accepted: true }>(`${base}/${id}/start`, {
      method: "POST",
    }),
  stop: (id: string) =>
    request<{ run: CoordinationRun; accepted: true }>(`${base}/${id}/stop`, {
      method: "POST",
    }),
};
