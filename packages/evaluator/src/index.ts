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
