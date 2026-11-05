# Contribution map

This page separates three things: what existed before the event, what was built during it, and what came from other projects.

## What existed before the event

Pisgah Health runs a hospital EMR (patients, admissions, pharmacy, laboratory and accounts). Its code is private and is not in this repository. Nothing here needs it to build, run or test.

| Piece in the EMR before the event | What it did |
| --- | --- |
| Agent identities | An agent could act under its own name. |
| Safe repeat requests | The same request sent twice had the effect of one. |
| On-behalf-of audit trail | The record kept which staff member an agent acted for. |
| Background job runner | Ran work outside a user's request. |
| Proposals card, corrections table | Showed staff an agent's suggestion and kept their fixes. |

Before the event the EMR had no tool calling, no agent loop, no saved agent tasks, no voice input, no workflow versions, no simulator, no evaluator and no Meta model use.

Earlier product documents set the direction and are not code: a product brief, a voice-first UI prototype and the pitch.

## Built during the event, in this repository

The implementation was built during the event; documentation may be clarified afterwards. The component table is a historical snapshot, not the final code checkpoint. Commit references preserve the implementation history.

| Part | What was built | Folders | First commit | Latest commit |
| --- | --- | --- | --- | --- |
| Contracts | Shared types, the hash-chained record format, the workflow schema | `packages/contracts/` | f29bb4c | 29fa08a |
| Agent runtime | Tasks with wakes and proofs, the decision gate, conversation state, hand-offs between agents | `packages/agent/src/` | ec95421 | 2ea1f93 |
| EMR connection | The agent's port over the EMR's agent API, the serve the clinician's strip talks to, the local ears | `packages/agent/src/emr/`, `packages/pisgah-adapter/` | c98e2a5 | f19a4b6 |
| Voice input | Meta Voice Transcribe over REST, then Meta's realtime ear | `packages/voice/` | ebece40 | 8d6768b |
| Wake phrase and speaker | A local wake-phrase spotter, a local speaker model that says who probably spoke | `packages/agent/src/emr/` | 4c8426f | 1a4b886 |
| Local ears | A local streaming ear and a local second ear, behind switches | `packages/agent/src/emr/` | e17d98d | 1a4b886 |
| Model layer and ledger | Clients for Muse Spark Open, a record of every model call, spending limits, replay for tests | `packages/model/`, `packages/store/` | 1417c1c | 583b7e4 |
| Synthetic hospital and simulator | A made-up hospital described as data and a simulator that runs its discharges | `packages/hospital/`, `packages/simulator/`, `packages/cases/` | 9f1d9d3 | a84ecc1 |
| Investigation tools | Evidence gathering, explanations, matched experiments, proposals | `packages/intelligence/` | 2079589 | 8acec42 |
| Workflow versions | Numbered versions, adoption by a person, a monitor, suspension | `packages/workflow/` | 09163f8 | df7f042 |
| Evaluator and claims | Scoring against simple baselines, the acceptance harness, the claims registry and its status file | `packages/evaluator/`, `evaluation/`, `apps/cli/` | d32b5be | 1626f96 |
| Demo app | A view that shows and replays the agent's work and each claim's status | `apps/demo/` | d798a3c | 21bbd95 |

## Later implementation checkpoints

The source checkpoint for the submission documentation is [`4d27cb2`](https://github.com/pisgahhealth/hey-pisgah/commit/4d27cb2). The earlier table is supplemented by these changes:

- [`8041c20`](https://github.com/pisgahhealth/hey-pisgah/commit/8041c20): preserves source meaning and interrupted instructions.
- [`abde488`](https://github.com/pisgahhealth/hey-pisgah/commit/abde488): handles multiple clinician-directed orders and admission in one line, with diagnosis read-back.
- [`afb2df0`](https://github.com/pisgahhealth/hey-pisgah/commit/afb2df0): arrival, name handling, audio pacing and encounter-completion fixes from rehearsal.
- [`4d27cb2`](https://github.com/pisgahhealth/hey-pisgah/commit/4d27cb2): records short non-action speech without prompting unnecessarily.

These commits show implementation provenance, not proof that every acceptance test passed. The [review guide](REVIEW.md) links measured evidence and remaining gaps.

## Built during the event, in the EMR

This work lives in the private EMR repository. Its owner commits in batches; this map uses the event build log to identify the work. The engine commit is the first one in this repository that uses the work.

| Part | What was built | Engine commit |
| --- | --- | --- |
| Clinician strip | A strip on the clinician's own EMR pages: listen and mute, the wake phrase, push-to-talk, the heard lines, each action with its proof | c98e2a5 |
| Agent shown on the record | Rows an agent wrote show as that person's agent on vitals, charts, notes and history | c98e2a5 |
| Door routes for the agent | New API routes the agent calls under its own session: voice orders and their countersign, verbal orders on a matched read-back, hand-offs between staff agents, voice match at the door, discharge and stay money read-backs | 042e9e7 |
| Database migrations | Sixteen migrations adding tables and columns for order states, countersign batches, voice templates and their use, agent delegations, the nightly memo, voice authorisation, consent attestations, stay money rulings and voice match events; one moved a guard an earlier event migration added into code; applied to the sandbox databases only | c40b921 |
| Fixes found by testing | Repeat-safe writes that commit, delegation scope, consent bases, the door's deny list, the strip resuming after a reload | a74c77b |

## Third-party code and models

The plan named six recipes from [meta-models/meta-model-cookbook](https://github.com/meta-models/meta-model-cookbook) (MIT) as design references: agent loop basics, managing context, alert fatigue copilot, append-only audit log, deterministic replay and goal tracking. A search of the tree found no file that names the cookbook, so no file carries an attribution comment. Its MIT notice is kept in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

The models and runtimes the build uses, with their licences, are listed in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md). None of them is bundled in this repository; the local models are downloaded at setup.

No model was trained or fine-tuned for this project.
