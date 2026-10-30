// Package voice: WAV encoding, silence chunking, transcript cleaning, Voice Transcribe REST and the realtime socket.
export const PACKAGE = "voice" as const;
export { ACCEPTED_RATES, TARGET_RATE, concat, decodeWav, encodeWav, parseWav, resample, type WavInfo, type WavProblem } from "./wav.js";
export { MAX_KEYWORDS, MAX_KEYWORD_LENGTH, MAX_KEYWORD_WORDS, buildKeywords, type Vocabulary } from "./keywords.js";
export { ASR_MODEL, ASR_URL, USD_PER_AUDIO_HOUR, VoiceError, languageBiasFrom, requestPart, transcribeWav, transcribeWithTurns, type FinalTranscript, type TranscribeOptions, type VoiceErrorCode } from "./transcribe.js";
export { SILENCE_RMS, frameRms, leadingSilenceMs, silenceRuns, sliceMs, stripChunks, trailingSilenceMs, type AudioChunk, type ChunkOptions, type SilenceRun } from "./chunk.js";
export { cleanTranscript, spokenDigits } from "./numbers.js";
export { MEASURES, RELEASE_RANGES, VITALS_KEYWORDS, continuesNumber, danglingEnd, wholeInRange, measuresIn, numbersIn, readVitals, vitalsTokens, vitalsVocabulary, type Measure, type Rewrite, type VitalsReading, type VocabularyResult } from "./vitals.js";
export { HANDSHAKE_DEADLINE_MS, META_SESSION_MAX_MS, REALTIME_URL, RealtimeSession, handshakeFrame, readServerFrame, type HandshakeOptions, type RealtimeEvent, type RealtimeMode, type RealtimeOptions, type RealtimeRate } from "./realtime.js";
export { decodeFrames, encodeFrame, nodeSocket, type RealtimeSocket, type SocketEvents, type SocketFactory } from "./ws.js";
export { readKept, recordingSocket, replaySocket, type KeptFrame } from "./realtime-record.js";
