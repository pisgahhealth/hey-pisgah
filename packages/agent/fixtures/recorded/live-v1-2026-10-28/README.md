# Recorded live case, 28 Oct 2026

One v1 case run live on Muse Spark Open (Modal, effort low), then frozen here so it replays with no network.

| File | What |
| --- | --- |
| `v1.json` | The v1 definition the run used (definition hash `1134ce48…`), before the hospital moved pharmacy and payment to staff steps. |
| `cases/c-agent001.json` | The case world the run used. |
| `../../recordings/` | The 38 recorded model responses. |

The run used no world rules, so the replay passes none.
Replay: `HEY_PISGAH_MODE=replay npm run serve -- --once --recorded live-v1-2026-10-28`.
