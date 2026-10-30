// Package pisgah-adapter: the hospital port over the platform's agent door, driven by a private door profile.
export const PACKAGE = "pisgah-adapter" as const;
export { DEFAULT_PROFILE_PATH, DoorProfile, OwnerSpec, fillPath, fillTemplate, loadProfile, pathPattern, pick, profilePath, staffHintsOf } from "./profile.js";
export { PisgahPort, render, type DoorLog, type PisgahPortOptions, type Refusal } from "./port.js";
export { doorMemoTransport, type DoorDeliveryAnswer, type DoorDeliveryLog, type MemoDeliveryLike } from "./memo.js";
export { SandboxBlock, mintAgentBearer, mintArgs, mintPersonBearer, sandboxQuery } from "./sandbox.js";
export { keyedGate, ledgerOf, recordedGate, runJourney, scriptKey, talkSteps, type JourneyRunOptions, type PersonCall } from "./journey.js";
export { FAKE, JourneyFakeHospital } from "./journey-fake.js";
