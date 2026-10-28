// The ambient-intent evaluation: the labelled talk, the feed into the listen endpoint, and C-17 scoring.
export { CLASSES, MOCK_GATE_FILE, TALK_DENY, TALK_FILE, Talk, Timeline, loadTalk, talkDenyHits, type ExpectedAction, type TalkUtterance } from "./talk.js";
export { runSignature, sameRun, scoreAmbient, type AmbientRun, type AmbientScore, type RunAction, type RunChunk, type RunLine } from "./score.js";
export { feedTalk, joinedAudio, talkChunks, type FeedOptions, type TalkChunk } from "./feed.js";
