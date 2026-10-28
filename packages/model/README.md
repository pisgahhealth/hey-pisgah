# model

Every model call goes through `ModelClient.call`. Each call writes one ledger row.

| Rule | How |
| --- | --- |
| Routes | `modal`, `baseten`, `fireworks`, `meta`, each with its own model ids |
| Keys | read from `~/.hey-pisgah.env` only; a route with no key refuses with `no_key` |
| Effort | required on every call (`low`, `medium`, `high`, `xhigh`); there is no default |
| Effort override | a system line matching `Reasoning strength:` is refused |
| Waiting gate | a call for a task in `waiting` is refused with `refused_while_waiting`, unless `thread` is `side` |
| Budgets | per run (`HEY_PISGAH_BUDGET_USD`, `HEY_PISGAH_MAX_CALLS`) and per week (`HEY_PISGAH_WEEK_USD`, stop at 80%); checked before the call |
| Ledger | `ledger/<run_id>` stream; one `model.call` row per call, `model.refused` for each refusal |
| Structured replies | `callStructured` validates with zod, sends at most 2 repair turns, then fails with `structured_invalid` |
| Modes | `HEY_PISGAH_MODE` is `mock` (default), `replay` or `live` |

## Record and replay

Live mode saves each request and response to `fixtures/recordings/<hash>.json`.
The hash is over the provider and the request body.
Only a few response headers are kept; a recording that contains a key value is never written.
Replay serves the saved response and fails with `replay_miss` when none matches.

## Usage fields

| Route | Reasoning tokens | Cached tokens |
| --- | --- | --- |
| Modal | top-level `usage.reasoning_tokens`, already inside `completion_tokens` | not reported on chat, kept as null |
| Meta | `completion_tokens_details.reasoning_tokens` | `prompt_tokens_details.cached_tokens` |
| Baseten, Fireworks | either shape; not yet seen live | either shape |

Cost uses `estimateCostUsd` from contracts.
