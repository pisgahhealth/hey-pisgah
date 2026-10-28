// Package voice: WAV encoding, silence chunking, transcript cleaning and Voice Transcribe REST, finished transcripts only.
export const PACKAGE = "voice" as const;
export { ACCEPTED_RATES, TARGET_RATE, concat, decodeWav, encodeWav, parseWav, resample, type WavInfo, type WavProblem } from "./wav.js";
export { MAX_KEYWORDS, MAX_KEYWORD_LENGTH, MAX_KEYWORD_WORDS, buildKeywords, type Vocabulary } from "./keywords.js";
export { ASR_MODEL, ASR_URL, USD_PER_AUDIO_HOUR, VoiceError, requestPart, transcribeWav, type FinalTranscript, type TranscribeOptions, type VoiceErrorCode } from "./transcribe.js";
export { SILENCE_RMS, frameRms, silenceRuns, sliceMs, stripChunks, trailingSilenceMs, type AudioChunk, type ChunkOptions, type SilenceRun } from "./chunk.js";
export { cleanTranscript, spokenDigits } from "./numbers.js";
