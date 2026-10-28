// Package hospital: the discharge world as data; staff profiles and the historical executor live behind the ./historical entry only.
export const PACKAGE = "hospital" as const;
export { loadV1, stampHashes, RULES_HASH_PENDING } from "./definition.js";
export { loadWardRequirements, wardRequires, evalCondition, WardRequirement, WardRequirementSet, RequiredDocument, type Facts } from "./requirements.js";
