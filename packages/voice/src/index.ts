// Package voice: WAV encoding and Voice Transcribe REST, finished transcripts only.
export const PACKAGE = "voice" as const;
export { ACCEPTED_RATES, TARGET_RATE, concat, encodeWav, parseWav, resample, type WavInfo, type WavProblem } from "./wav.js";
export { MAX_KEYWORDS, MAX_KEYWORD_LENGTH, MAX_KEYWORD_WORDS, buildKeywords, type Vocabulary } from "./keywords.js";
export { ASR_MODEL, ASR_URL, USD_PER_AUDIO_HOUR, VoiceError, requestPart, transcribeWav, type FinalTranscript, type TranscribeOptions, type VoiceErrorCode } from "./transcribe.js";
