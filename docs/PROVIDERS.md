# Providers

What each model route accepts and returns, measured by `npm run probe` on 28 Oct 2026.
Every call wrote one ledger row to `.hey-pisgah/store/ledger/probe.jsonl`.
The probe made 56 calls in total and cost $0.174.

Run `npm run probe` for every step, `npm run probe -- --only cache,asr` for some, or `npm run probe -- --summary` to read the ledger without calling anything.
The probe stops at 60 ledger rows or at `HEY_PISGAH_BUDGET_USD` (default $2), counted over the whole ledger file.

## Modal (core route, Muse Spark Open)

| Field | Value |
| --- | --- |
| Slug | `modal` |
| Model id | `meta-models/Muse-Spark-Open-816B-A42B` (the only id `GET /models` lists) |
| Base URL | the value of `MODAL_ENDPOINT_URL`, ending in `/v1` |
| Auth | `Authorization: Bearer <token id>.<token secret>` |
| Effort values accepted | `low`, `medium`, `high`, `xhigh` return 200; `none` and `max` return 400 with no body |
| Tool-call shape | `finish_reason: "tool_calls"`; `message.tool_calls[] = {id, index, type, function: {name, arguments}}`; `message.reasoning_content` is a string |
| Usage shape | `{prompt_tokens, completion_tokens, total_tokens, prompt_tokens_details: null, reasoning_tokens}` |
| Reasoning tokens | top-level, and already counted inside `completion_tokens` |
| Cache field | not reported on Chat Completions; reported on `/v1/responses` as `usage.input_tokens_details.cached_tokens` |
| `parallel_tool_calls: false` | accepted |
| Latency p50 | 988 ms over 49 chat calls (suite alone: 899 ms, max 2.4 s) |
| Cost of the probe | $0.172 over 52 calls |

Effort on one easy prompt (reasoning tokens, one sample each): low 100, medium 338, high 713, xhigh 316.
One sample is noisy, so the easy prompt does not rank high against xhigh.

The system line `Reasoning strength: 8.` is honoured: **yes**.

| Hard prompt | Reasoning tokens |
| --- | --- |
| low | 1571 |
| xhigh | 7552, 4733 |
| xhigh with the line | 1315, 1729 |

With the line, xhigh drops to the low level, so the prompt deny list must reject such lines.

Cache: two identical 3,662-token prompts sent back to back with `Modal-Routing-Affinity-Key: probe-1`.
Both returned `prompt_tokens_details: null`, so cached tokens are "not reported" on Chat Completions.
Latency fell from 632 ms to 474 ms, which hints at a hit but proves nothing.
The ledger records `cached_tokens: null` for Modal Chat Completions, and cost assumes no cache.

`reasoning_content` sent back on an earlier assistant turn is rendered.
Turn one chose a secret number in its reasoning and replied "ready".
With the reasoning sent back, the second turn read 523 prompt tokens and refused to reveal the number.
Without it, the same turn read 200 prompt tokens and replied "UNKNOWN".

`POST /v1/responses` with `tools: [{"type": "tool_search"}]` returned **200, not 4xx**.
The tool is echoed in the response's `tools` list and ignored; the output is a reasoning item and a plain message.
The response also defaults to `store: true`.
Treat a 200 here as "accepted and ignored", never as "tool search works".

## Meta Model API (hosted, fallback only)

| Field | Value |
| --- | --- |
| Slug | `meta` |
| Model id | `muse-spark-1.3`, Standard mode (`-contributor` ids are Contributor mode) |
| Base URL | `https://api.meta.ai/v1` |
| Auth | `Authorization: Bearer $MODEL_API_KEY` |
| Models listed | muse-wonder-1.0, muse-spark-1.3, muse-spark-1.3-contributor, muse-spark-1.2, muse-spark-1.2-contributor, muse-spark-1.1, muse-voice-transcribe-1.0, muse-image-1.0, sam-3.1 |
| Effort values accepted | `low` tested only |
| Tool-call shape | `finish_reason: "tool_calls"`; `message = {role, content, refusal: null, tool_calls[]: {id, type, function: {name, arguments}}}`; no reasoning field on the message |
| Usage shape | `{prompt_tokens, completion_tokens, total_tokens, completion_tokens_details: {reasoning_tokens}, prompt_tokens_details: {cached_tokens}}` |
| Cache field | `prompt_tokens_details.cached_tokens` (497 of 683 on the second turn of the round trip) |
| Latency p50 | 1678 ms over 2 chat calls |
| Cost of the probe | $0.0021 over 4 calls, including Voice Transcribe |

Muse Spark Open is not served here.

## Voice Transcribe (Meta)

| Field | Value |
| --- | --- |
| Endpoint | `POST https://api.meta.ai/v1/asr/transcribe?sessionId=probe` |
| Body | `multipart/form-data`: part `request` (JSON) and part `audio` (WAV) |
| Request JSON | `{"model": "muse-voice-transcribe-1.0", "audioEncoding": "WAV", "mode": "PUSH_TO_TALK", "keywords": ["Ward A", "bed 4"]}` |
| Status on 3 s of 16 kHz mono silence | 200 in 3.4 s |
| Response shape | `{sessionId: string, transcript: string, audioDurationMs: number, turns: []}` |
| Silence result | `transcript: ""`, `audioDurationMs: 3040`, `turns: []` |
| Price | $0.18 per hour of audio |

Source: https://dev.meta.ai/docs/api-reference/voice/transcribe.md and the voice schemas page, checked 28 Oct 2026.

## Tool-call suite (the D2 gate)

`npm run probe -- --tool-suite 30` sends 30 one-tool prompts to Modal at effort `low`.
Three tools are declared: `get_case_state`, `get_ward_requirements` and `compute_intervals`.
The JSON schema of each tool is generated from the zod schema that validates the reply.
Arguments are strict objects, and the times must be ISO 8601 with an offset.

| Result | Count |
| --- | --- |
| Calls | 30 |
| Invalid (no call, unknown tool, bad JSON or schema failure) | **0 (0.0%)** |
| Valid call to the wrong tool | 0 |
| More than one call | 0 |
| Cost | $0.071 |

## Not tested

Baseten: not tested, no key yet. Fireworks: not tested, no key yet.
The probe prints "no key" for both and carries on.

## Prices used for cost

$1.25 input, $0.15 cached input, $4.25 output per million tokens, the same on hosted Standard and every Spark Open route.
Source: https://dev.meta.ai/docs/pricing-rate-limits.md, checked 28 Oct 2026.
Effort strengths (low 8, medium 32, high 256, xhigh 512) come from Meta's Spark Open prompting guide.
