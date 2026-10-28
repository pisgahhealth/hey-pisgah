# agent

The personal agent runtime. It works one discharge case through the hospital port and proves each write from the record.

| Part | File | What it does |
| --- | --- | --- |
| Task stream | `src/task.ts` | One stream per task under `tasks/`. Every state change is an appended record. |
| States | `src/task.ts` | running, waiting, needs_input, paused, cancelled, done, failed. |
| Hospital port | `src/port.ts` | Reads the case as recorded by now. Re-checks permission and prerequisites on every write. |
| World | `src/world.ts` | Runs the definition executor. Agent steps start only when the port accepts a write. |
| Tools | `src/schemas.ts`, `src/prompt.ts` | Execution tools from one set of zod schemas. No tool exists for work that belongs to people. |
| Conditions | `src/acceptance.ts` | Derived from the adopted version and the ward requirements. The model never writes them. |
| Wakes | `src/acceptance.ts`, `src/wakes.ts` | Derived from the version, plus one wake for a requirements change. `wait_until` needs a deadline. |
| Runtime | `src/runtime.ts` | Tool loop, journaled intents, proofs, the resumer and the clock. |
| Serve | `src/serve.ts` | The one process that owns the task and learning streams. |
| Versions | `src/versions.ts` | The version log under `learning/versions`. Adopt, suspend and revert are a person's decision. |
| Monitor | `src/monitor.ts`, `src/data/requirement-checks.json` | The runtime's own reading of ward requirement prose. Checks each write and each proved stage. |
| Case worlds | `src/cases.ts`, `fixtures/cases/` | A generated case as the agent's world. The two demo worlds are committed. |

## Rules the runtime keeps

| Rule | How |
| --- | --- |
| No model call while waiting | The model client refuses it; `callsWhileWaiting` checks the ledger and the task stream. |
| Journaled intent | `action.intent {key, args}` is written before the port sees the write. |
| Reconcile before retry | After a restart the action looks for its own effect at the port first. It retries once at most. |
| Proof | An action is completed only with a proof from a fresh read of its record. |
| Done | Only when every condition has a current proof. Otherwise needs_input, with the unmet list. |
| One resume per wake | A second `task.resumed` for the same wake is refused. |
| Serial ticks | One queue per task. A tick writes only while the stream head is where it started. |
| Clock | Simulated time moves only when every task on the case is waiting or settled. |
| Guarded tools | A conflict cites the requirement version in force, one element of the version and recorded events. A question names a role, reads as a question, three per case at most. Refusals are counted. |
| Commit check | A write is refused when the requirements in force name another source for one of its sections. The task records `version.check_failed`. |
| Outcome check | A proved stage is re-read when the record changes. A stale hand-over or a failed requirement records `version.check_failed`. |
| Blocking | A failed check blocks that stage and the work after it. Other work goes on. With nothing left, the task goes to needs_input. |
| Proposals | Each failed check raises `version.suspension_proposed`, and `version.revision_proposed` when a rebinding would meet it. Only a person acts on them. |
| Case exceptions | A case-only rebinding takes effect once the named role confirms it. It may not touch a document already started. |

## World assumption

A case exception that names a source is confirmed by the named role a fixed number of minutes after it is recorded (`exception_confirm_after_min`, 10 in the demo worlds). The simulated staff confirm what they are asked. A wrong rebinding is not caught here; the evaluator's content rule catches it.

## Run it

| Command | What |
| --- | --- |
| `npm run serve` | Long-lived process on 127.0.0.1:4317 (`HEY_PISGAH_SERVE_PORT` to change). |
| `npm run serve -- --once --case c-agent001` | One task to a settled state, then a JSON summary. |
| `HEY_PISGAH_MODE=replay npm run serve -- --once --recorded live-v1-2026-10-28` | Replays the recorded live case, in the world it ran in, with no network. |
| `npx tsx apps/cli/src/index.ts version adopt --proposal-file f` | Validates the proposal on dev, then asks serve to adopt it for a person. See `version suspend` and `version revert`. |

HTTP routes: `GET /health`, `GET /tasks`, `POST /tasks {case_id, goal, owner}`, `GET /tasks/<id>`, `POST /tasks/<id>/cancel {by}`, `POST /tasks/<id>/input {text, by}`, `GET /cases`, `GET|POST /cases/<id>/clock` (POST in `--clock manual` only), `POST /learning {record_type, payload}`, `GET /versions`, `POST /versions/adopt {proposal_id, approver}`, `POST /versions/<n>/suspend {by, reason, proposal?}`, `POST /versions/<n>/revert {by, reason}`, `POST /cases/<id>/exceptions/<record_id>/confirm {by}`.

Status reads never call the model.
