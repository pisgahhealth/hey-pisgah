# pisgah-adapter

The hospital port over the host platform's agent door. It lets each clinician's agent read the patient in context and do the work kinds its owner holds, under that owner's own agent session.

The routes, header names and target ids are not in this repository. They live in a private door profile file, named by `HEY_PISGAH_DOOR_PROFILE`.

| Part | What it does |
| --- | --- |
| `PisgahPort` | Reads the admission or the arriving patient, does each work kind the profile lists, proves each write by a fresh read |
| Owners | One agent bearer per owner; each owner holds its own kinds, watches and offers |
| Deny list | Paths the port never calls, checked before anything else; `deny_exact` refuses one path but not its longer siblings |
| Allowlist | The only routes the port may call: the profile's reads, its writes and their proofs |
| Refusals | Every refused call is counted and nothing is sent |
| `serve.run.ts` | Starts the strip-facing serve over this port, on `HEY_PISGAH_EMR_PORT` (default 4100) |
| `talk.run.ts` | Plays the labelled talk into serve in real time (`--live`), or replays a kept run (`--replay`), and scores it |

Every call carries the agent bearer and four provenance headers: who the agent acts for, the origin (`voice`), the transcript line that asked for it, and when it was spoken. Writes also carry an idempotency key, which is the runtime's intent key.

A correction never edits the first entry. It adds a correcting entry whose remark cites the first one.

## Several owners

| Part | What it does |
| --- | --- |
| Work kinds | Observations, a consultation draft, an admission request, triage, care-plan items, notes, a handover draft, pages, a follow-up booking, the bill view and the pay link |
| Hand-offs | An agent that needs another role's work pages that person through the paging door and watches the record; it never messages the other agent directly |
| Watches | Each open task reads what its owner watches, such as a discharge stage, with no model call; a change becomes a note in the strip |
| Offers | When a watched value reaches what the owner's work waits on, the agent asks its owner once; it acts only on the owner's words |
| Pages | Each agent reads its own inbox; a page is shown, never acted on |
| Pause | "Stop, I'll come back to this" pauses with the held actions listed and unwritten; "where were we" resumes with a digest of what changed, and no model is called in between |

## The strip's contract (serve on port 4100)

| Call | Body | Answer |
| --- | --- | --- |
| `GET /tasks?owner=` | none | the owner's tasks, newest first |
| `POST /tasks/say` | `{owner, admissionId?, patientId?, text, via?}` | `{task_id, line_id}`; `via: "gate"` sends a typed line through the speech gate, as owners with more than observations always do |
| `POST /tasks/say-audio` | multipart `audio` (WAV), `owner`, `admissionId?`, `patientId?` | `{task_id, line_id, transcript}` |
| `POST /tasks/<id>/say` | `{text}` | `{task_id, line_id}` |
| `POST /tasks/<id>/interrupt` | `{}` | `{cancelled, in_flight, state}` |
| `POST /tasks/<id>/resume` | `{}` | `{resumed, state}` |
| `POST /tasks/watch` | `{owner, admissionId?, patientId?}` | `{task_id}`; the owner's task starts watching with no words |
| `POST /tasks/listen` | multipart `audio` (WAV chunk), `owner`, `admissionId?`, `patientId?`, `session_id`, `seq` | at once: `{session_id, seq, accepted, utterances: [{id, text, class}], partial}` |

Listening: a chunk that ends in 500 ms of quiet finishes an utterance. A chunk cut at the 6 s cap with no quiet tail is held as audio and joined with the next one before it is transcribed, so partial words never reach the gate. Each finished utterance gets one gate call; the line's `class` appears on the task's transcript line when the gate has decided. Add `?wait=1` to wait for the chunk's own outcome.

A task is `{task_id, goal, state, actions, questions, transcript, watching, changes, pages, pause, digests}`. An action is `{action_id, kind, state, summary, proof?}`, and a proof is `{record_id, record_version, event_ids}`.

Action states: `proposed` (on hold, so a correction or Stop can reach it), `sent`, `acknowledged`, `completed` (proved), `refused`, `cancelled`, `failed`. An action marked `unverified` is acknowledged by the hospital but no read can show it, so it is never shown as done.

## Run

```
HEY_PISGAH_DOOR_PROFILE=<profile> HEY_PISGAH_MODE=live npx tsx packages/pisgah-adapter/src/serve.run.ts
```

The sandbox integration test runs only with `SANDBOX=1` and the same profile.

With `HEY_PISGAH_RECORDINGS=<dir>`, serve keeps model replies, transcripts and the patient context there, so `talk.run.ts --replay` can play the same run again without the network.

## The journey

One synthetic patient from arrival to discharge administration, with three owners' agents: the doctor's, the nurse's and the accounts clerk's. The script is in the evaluator package; people do every approval and sign-off.

| File | What |
| --- | --- |
| `journey.ts` | Plays the script into serve: talk lines to each owner's task, person steps to the person's own login |
| `journey.sandbox.ts` | The sandbox run: one agent per owner, read-only record checks afterwards |
| `journey-fake.ts` | An in-memory hospital for CI, and the replay of a recorded run |
| `journey.commit.ts` | Commits the decision points and their classes before a run |
| `journey.run.ts` | `--mode mock` plays the script's keyed answers; `--mode live` calls the model; both replay the recording after |
| `journey.publish.ts` | Writes a kept run's results with no ids, and its recorded gate answers |

```
HEY_PISGAH_DOOR_PROFILE=<profile> HEY_PISGAH_EMR_PORT=4102 HEY_PISGAH_BUDGET_USD=5 npx tsx packages/pisgah-adapter/src/journey.run.ts --mode live --out <private dir>
```

The sandbox test runs with `SANDBOX=1`. CI replays the recorded run over the in-memory hospital and checks it matches the published result.
