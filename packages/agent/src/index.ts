// Package agent: the personal agent runtime, the hospital port over the definition executor, and the execution tools.
export const PACKAGE = "agent" as const;
export { AgentRuntime, type Boundary, type RuntimeOptions } from "./runtime.js";
export { HospitalPort, PORT_STREAM, wrapUntrusted, type CommitResult, type PortWrite, type RecordView, type WaitingFor } from "./port.js";
export { CaseWorld, PortError, agentSteps, engineSchedule, type EngineCommit } from "./world.js";
export { FIXTURE_CASES_DIR, loadCases, parseCaseFile } from "./cases.js";
export { ARGS, TEMPLATES, WRITE_TOOLS, READ_TOOLS, CONTROL_TOOLS, type ToolName } from "./schemas.js";
export { SYSTEM_PROMPT, toolDefs, userMessage, deltaDigest } from "./prompt.js";
export { project, toAgentTask, guardCompletion, TaskWriter, TickConflict, type Projection } from "./task.js";
export { deriveConditions, deriveWakeLeaves, conditionStatus } from "./acceptance.js";
export { firstFiring, fireOf } from "./wakes.js";
export { callsWhileWaiting } from "./checks.js";
export { scriptedAgent, type ScriptOptions } from "./mock.js";
export { AGENT_RECORDINGS_DIR, LEARNING_STREAM, RECORDED_DIR, recordedWorld, serveCommand, startServe, type Serve, type ServeOptions } from "./serve.js";
export * from "./emr/index.js";
