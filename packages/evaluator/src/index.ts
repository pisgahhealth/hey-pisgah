// Package evaluator: acceptance checks, the validation pipeline and reserved isolation; agent and intelligence may never import it.
export const PACKAGE = "evaluator" as const;
export { AC_IDS, runAcceptance, type AcId, type AcInput, type AcReport, type AcResult, type VersionContext } from "./acceptance/checks.js";
export { ContentRules, loadContentRules, rulesFor, type ContentRule } from "./acceptance/rules.js";
export { acceptanceHash, committedAcceptanceHash } from "./acceptance/hash.js";
export { Trace, type OkRun } from "./acceptance/trace.js";
export { loadManifests, MANIFEST_POOLS, type ManifestPool } from "./data.js";
export {
  PROPOSALS_STREAM, VALIDATIONS_STREAM, devGate, expectedRulesHash, loadValidationCases, proposalDefinition, runCase, runValidationStream, validateProposal, validationSummary,
  type CaseRow, type Gate, type PipelineOptions, type RepairHook, type ValidationCase, type ValidationReport
} from "./pipeline.js";
export {
  RUNTIME_TYPES, claimedState, completionMatrix, recordStateFromRun, requiredStages, verifyCompletion,
  type CompletionRow, type CompletionSummary, type RecordState, type RecordStateReader, type RuntimeEvent, type StageRecord, type TaskStreamReader, type Unmet, type Verdict
} from "./completion.js";
export {
  ReservedRunRefused, UNKNOWN_ID, reservedRunFile, reservedRunRefusal, reservedRunsRoot, reservedTokens, runsRoot, sealedReservedCases, serveAllowlist, storeRoot, visibleLookup, writeReservedArtifact,
  type Lookup
} from "./reserved.js";
export { TranscriptLeak, assertNoReservedLeak, scanFile, scanTranscripts, scanValue, type Channel, type Hit, type Tokens } from "./scan.js";
export { checkG, runGChecks, type GLine, type GStatus } from "./gchecks.js";
export { PredicateError, claimStatus, evaluate, fieldAt, identifiers, parseClaimPredicate, parsePredicate, type ClaimPredicate, type ClaimStatus, type Expr } from "./predicate.js";
export { A1_RULE, earliestPermitted, type A1Result } from "./arms/a1.js";
export { SPACE_RULE, candidateOperations, opKey, singleOperationSpace, type SpaceEntry } from "./arms/space.js";
export { A4_EXPERIMENTS, A4_SEED, a4Order, fuzz, oracleNote, randomExperiments, randomValidSequences, runMatched, type DrawnExperiment, type FuzzReport, type MatchedCase, type OracleNote } from "./arms/experiments.js";
export { PROPOSAL_ARMS, ProposalInput, armVersion, loadProposalInput, type ArmVersion, type ProposalArm } from "./arms/proposals.js";
export { poolCases, runArm, type ArmCase, type ArmResult, type ArmRow } from "./arms/run.js";
export { proposalFor, singleOperationSweep, type SweepEntry, type SweepResult } from "./arms/sweep.js";
export { CommitmentFile, commit, commitmentsDir, committedHash, readCommitment } from "./commitments.js";
export { artifactBodies, staleCommitments } from "./commit-artifacts.js";
export { disjoint, interval, predictionAfter, predictionBefore, summariseChecks, type CaseResult, type CheckHypothesis, type CheckedExperiment, type PredictionSummary } from "./prediction.js";
export type { BaseRuns } from "./pipeline.js";
