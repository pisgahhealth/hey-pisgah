// Every model-layer refusal carries a stable code so callers and tests branch on the code.
export type ModelErrorCode =
  | "no_key"
  | "unknown_provider"
  | "unknown_model"
  | "effort_required"
  | "effort_override_refused"
  | "unsupported_param"
  | "refused_while_waiting"
  | "budget_exhausted"
  | "replay_miss"
  | "provider_error"
  | "structured_invalid"
  | "secret_in_recording";

export class ModelError extends Error {
  constructor(
    readonly code: ModelErrorCode,
    message: string,
    readonly detail: Record<string, unknown> = {}
  ) {
    super(`${code}: ${message}`);
    this.name = "ModelError";
  }
}
