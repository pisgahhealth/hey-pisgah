// Package intelligence: investigation tools, hypothesis records, matched experiments, the prediction check and proposal submission.
export const PACKAGE = "intelligence" as const;
export { DENY_LIST, denyScan, type DenyHit } from "./deny.js";
export { UNKNOWN_ID } from "./unknown.js";
export { DiscoveryPool, loadObserved, type OutcomeCase, type PoolCase } from "./pool.js";
export { checkAfter, checkBefore, disjoint, holds, interval, scopedCases } from "./prediction.js";
export { runMatched, type Matched, type Runner } from "./experiments.js";
export { Session, STREAMS, sessionStreamId, toleranceCap, type Arm, type ListedExperiment, type SessionOptions, type StoredExperiment } from "./session.js";
export { DESCRIPTIONS, armTools, dispatch, toolDefs, type ToolName } from "./tools.js";
export { ARMS, NUDGE, appTexts, armHashes, kickoff, systemPrompt } from "./prompts.js";
export { SETTINGS, compact, dropOldTurns, runLoop, type Digests, type LoopOptions, type LoopOutcome } from "./loop.js";
export { definitionDigest, resultDigest } from "./digest.js";
export { MOCK_CASES, scriptedInvestigator } from "./mock.js";
export { appendCommitment, appendOnlyProblems, commitmentFor, commitmentsPath, currentContent, readCommitments, type CommitmentsFile } from "./commitments.js";
export { checkDiscovery, type DiscoveryCheck } from "./check.js";
export { INTELLIGENCE_RECORDINGS_DIR, checkDiscoveryCommand, discoverCommand, type DiscoverDeps } from "./cli.js";
