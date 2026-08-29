import { HttpError } from "../errors.js";
import type { CoordinationErrorCode } from "./types.js";

export class CoordinationError extends HttpError {
  constructor(
    statusCode: number,
    public readonly code: CoordinationErrorCode,
    message: string,
    public readonly fieldErrors?: Record<string, string[]> | undefined,
  ) {
    super(statusCode, message);
    this.name = "CoordinationError";
  }
}
