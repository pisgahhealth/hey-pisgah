// Package model: provider routes, one ledger row per call, budgets, the waiting gate, zod repair and record or replay.
export const PACKAGE = "model" as const;
export { ModelError, type ModelErrorCode } from "./errors.js";
export { KEYS_PATH, loadKeys, parseEnvText, secretValues } from "./env.js";
export { ROUTES, SPARK_OPEN_STRENGTH, parseUsage, routeFor, type EffortLevel, type ProviderId, type Route, type Usage } from "./routes.js";
export { DEFAULT_RECORDINGS_DIR, HEADER_WHITELIST, readRecording, requestHash, writeRecording, type Recording } from "./recordings.js";
export { budgetFromEnv, ledgerRowsIn, weekSpendUsd, type Budget } from "./budget.js";
export { ModelClient, createModelClient, fixedMock, type CallArgs, type CallResult, type ChatCompletion, type ChatMessage, type ChatTool, type ClientOptions, type MockResponder, type Mode } from "./client.js";
export { callStructured, extractCandidate, formatIssues, type StructuredResult } from "./structured.js";
