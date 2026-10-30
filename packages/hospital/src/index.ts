// Package hospital: the discharge world as data; staff profiles and the historical executor live behind the ./historical entry only.
export const PACKAGE = "hospital" as const;
export { loadV1, stampHashes } from "./definition.js";
export { REQUIREMENT_VERSIONS, loadWardRequirements, wardRequires, wardRequiresList, evalCondition, WardRequirement, WardRequirementSet, RequiredDocument, type Facts } from "./requirements.js";
export { loadWorldParameters, worldRules, summaryCheckMin, WorldParameters } from "./world.js";
export { loadHandCase, loadGoldenSchedule, loadGoldenHashes, HandCase, GoldenHashes } from "./fixtures.js";
export { REWORK_BUDGET_MIN_PER_CASE, hospitalAim, type HospitalAim } from "./aim.js";
