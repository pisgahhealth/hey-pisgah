// The EMR side of the agent: the port seam, the one-call intent, the task runtime and the strip-facing serve.
export { EMR_WRITE_KINDS, EmrId, EmrPortError, OBSERVATION_KIND, ObservationArgs, type EmrCommit, type EmrContext, type EmrPort, type EmrProof, type EmrTarget, type EmrWriteKind, type Provenance } from "./port.js";
export { DECIDE_TOOL, DEFAULT_INTENT_ROUTE, Decide, EMR_SYSTEM_PROMPT, FALLBACK_INTENT_ROUTE, decideIntent, decideTool, intentMessage, tempText, type IntentInput, type IntentResult, type IntentRoute } from "./intent.js";
export { EmrRuntime, applyEmr, emrIntentKey, projectEmr, summarise, viewOf, type EmrAction, type AmbientMeta, type EmrActionState, type EmrRefusal, type EmrRuntimeOptions, type EmrTask, type EmrTaskView, type SayInput } from "./runtime.js";
export { EMR_SERVE_PORT, startEmrServe, voiceTranscriber, type EmrServe, type EmrServeOptions } from "./serve.js";
export { CONFIDENCE_FLOOR, GATE_DENY, GATE_FACTS, GATE_SETTINGS, GATE_TOOL, GateClause, GateOutput, MAX_CLAUSES, SPEECH_CLASSES, denyHits, gateCommitmentBody, gateMessage, gatePrompt, gateTool, gateUtterance, type GateAction, type GateInput, type GateResult, type GateSettings, type SpeechClass } from "./gate.js";
export { CHUNK_CAP_MS, FINAL_SILENCE_MS, ListenError, ListenSessions, MAX_HELD_MS, recordingTranscriber, replayTranscriber, type ListenChunk, type ListenOptions, type ListenOutcome, type ListenReply, type ListenUtterance, type Transcriber } from "./listen.js";
export { primaryClass } from "./classes.js";
