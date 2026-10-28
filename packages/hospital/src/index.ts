// Package hospital: the discharge world as data; staff profiles and the historical executor live behind the ./historical entry only.
export const PACKAGE = "hospital" as const;
export { loadV1, stampHashes, RULES_HASH_PENDING } from "./definition.js";
export { loadWardRequirements, wardRequires, evalCondition, WardRequirement, WardRequirementSet, RequiredDocument, type Facts } from "./requirements.js";
export { loadWorldParameters, loadWorldBindings, readPath, Schedule, WorldParameters, WorldBindings, StepBinding, StepTiming } from "./world.js";
export { stubEngine, deriveDataIntegrity, HORIZON, type DischargeEngine, type EngineRun, type EngineRunOptions, type Practice, type World, type AgentAction, type DispatchState, type DispatchResult } from "./engine-seam.js";
