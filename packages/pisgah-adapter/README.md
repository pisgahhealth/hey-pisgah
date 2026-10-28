# pisgah-adapter

The hospital port over the host platform's agent door. It lets the agent read the patient in context and write one kind of record, under the clinician's own agent session.

The routes, header names and target ids are not in this repository. They live in a private door profile file, named by `HEY_PISGAH_DOOR_PROFILE`.

| Part | What it does |
| --- | --- |
| `PisgahPort` | Reads the admission, writes one observation entry, proves each write by a fresh read |
| Deny list | Paths the port never calls, checked before anything else |
| Allowlist | The only routes the port may call: the profile's reads and its one write |
| Refusals | Every refused call is counted and nothing is sent |
| `serve.run.ts` | Starts the strip-facing serve on port 4100 over this port |

Every call carries the agent bearer and four provenance headers: who the agent acts for, the origin (`voice`), the transcript line that asked for it, and when it was spoken. Writes also carry an idempotency key, which is the runtime's intent key.

A correction never edits the first entry. It adds a correcting entry whose remark cites the first one.

## The strip's contract (serve on port 4100)

| Call | Body | Answer |
| --- | --- | --- |
| `GET /tasks?owner=` | none | the owner's tasks, newest first |
| `POST /tasks/say` | `{owner, admissionId?, patientId?, text}` | `{task_id, line_id}` |
| `POST /tasks/say-audio` | multipart `audio` (WAV), `owner`, `admissionId?`, `patientId?` | `{task_id, line_id, transcript}` |
| `POST /tasks/<id>/say` | `{text}` | `{task_id, line_id}` |
| `POST /tasks/<id>/interrupt` | `{}` | `{cancelled, in_flight, state}` |

A task is `{task_id, goal, state, actions, questions, transcript}`. An action is `{action_id, kind, state, summary, proof?}`, and a proof is `{record_id, record_version, event_ids}`.

Action states: `proposed` (on hold, so a correction or Stop can reach it), `sent`, `acknowledged`, `completed` (proved), `refused`, `cancelled`, `failed`.

## Run

```
HEY_PISGAH_DOOR_PROFILE=<profile> HEY_PISGAH_MODE=live npx tsx packages/pisgah-adapter/src/serve.run.ts
```

The sandbox integration test runs only with `SANDBOX=1` and the same profile.
