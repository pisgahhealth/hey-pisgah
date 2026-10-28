// The uniform answer for any id outside the discovery pool or this session; it matches the evaluator's UNKNOWN_ID shape exactly.
export const UNKNOWN_ID = Object.freeze({ ok: false as const, error: "unknown_id" as const, message: "No record has that id." });
export type UnknownId = typeof UNKNOWN_ID;
