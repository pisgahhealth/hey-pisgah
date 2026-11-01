// Every store failure carries a stable code so callers branch on the code, never on the message.
export type StoreErrorCode = "store_locked" | "store_lost_lock" | "store_quarantined" | "store_corrupt" | "path_refused" | "not_writer" | "stream_closed" | "run_exists" | "store_key_missing" | "store_key_mismatch" | "store_key_invalid" | "store_unsealable";

export class StoreError extends Error {
  constructor(
    readonly code: StoreErrorCode,
    message: string,
    readonly detail: Record<string, unknown> = {}
  ) {
    super(`${code}: ${message}`);
    this.name = "StoreError";
  }
}
