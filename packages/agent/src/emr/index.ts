// The EMR side of the agent: the port seam, the one-call intent, the task runtime and the strip-facing serve.
export { EMR_WRITE_KINDS, EmrId, EmrPortError, OBSERVATION_KIND, ObservationArgs, type EmrCommit, type EmrContext, type EmrPort, type EmrProof, type EmrTarget, type EmrWriteKind, type Provenance } from "./port.js";
export { DECIDE_TOOL, DEFAULT_INTENT_ROUTE, Decide, EMR_SYSTEM_PROMPT, FALLBACK_INTENT_ROUTE, decideIntent, decideTool, intentMessage, tempText, type IntentInput, type IntentResult, type IntentRoute } from "./intent.js";
export { EmrRuntime, applyEmr, emrIntentKey, projectEmr, summarise, viewOf, type EmrAction, type EmrActionState, type EmrRuntimeOptions, type EmrTask, type EmrTaskView, type SayInput } from "./runtime.js";
export { EMR_SERVE_PORT, startEmrServe, voiceTranscriber, type EmrServe, type EmrServeOptions, type Transcriber } from "./serve.js";
