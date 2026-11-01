# Contribution map

This page separates three things: what existed before the event, what was built during it, and what came from other projects.

The event window is 26 October to 4 November 2026. Commits in this repository start on 28 October 2026.

## What existed before the event

Pisgah Health runs a hospital EMR (patients, admissions, pharmacy, laboratory and accounts). Its code is private and is not in this repository. Nothing here needs it to build, run or test.

| Piece in the EMR before 26 Oct | What it did |
| --- | --- |
| Agent identities (16 Oct 2026) | An agent could act under its own name. |
| Safe repeat requests (16 Oct 2026) | The same request sent twice had the effect of one. |
| On-behalf-of audit trail (16 Oct 2026) | The record kept which staff member an agent acted for. |
| Background job runner | Ran work outside a user's request. |
| Proposals card, corrections table | Showed staff an agent's suggestion and kept their fixes. |

Before the event the EMR had no tool calling, no agent loop, no saved agent tasks, no voice input, no workflow versions, no simulator, no evaluator and no Meta model use.

Earlier product documents set the direction and are not code: a product brief (2 Aug 2026), a voice-first UI prototype (14 Oct 2026) and the pitch (26 to 27 Oct 2026).

## Built during the event, in this repository

Every file in this repository was written during the event. Dates are commit dates. The first commit is the first one that added the part's code; the latest is the newest on 1 Nov 2026.

| Part | What was built | Folders | First commit | Latest commit |
| --- | --- | --- | --- | --- |
| Contracts | Shared types, the hash-chained record format, the workflow schema | `packages/contracts/` | f29bb4c, 28 Oct | 29fa08a, 1 Nov |
| Agent runtime | Tasks with wakes and proofs, the decision gate, conversation state, hand-offs between agents | `packages/agent/src/` | ec95421, 28 Oct | 2ea1f93, 1 Nov |
| EMR connection | The agent's port over the EMR's agent API, the serve the clinician's strip talks to, the local ears | `packages/agent/src/emr/`, `packages/pisgah-adapter/` | c98e2a5, 28 Oct | f19a4b6, 1 Nov |
| Voice input | Meta Voice Transcribe over REST, then Meta's realtime ear | `packages/voice/` | ebece40, 28 Oct | 8d6768b, 31 Oct |
| Wake phrase and speaker | A local wake-phrase spotter, a local speaker model that says who probably spoke | `packages/agent/src/emr/` | 4c8426f, 29 Oct | 1a4b886, 1 Nov |
| Local ears | A local streaming ear and a local second ear, behind switches | `packages/agent/src/emr/` | e17d98d, 30 Oct | 1a4b886, 1 Nov |
| Model layer and ledger | Clients for Muse Spark Open, a record of every model call, spending limits, replay for tests | `packages/model/`, `packages/store/` | 1417c1c, 28 Oct | 583b7e4, 1 Nov |
| Synthetic hospital and simulator | A made-up hospital described as data and a simulator that runs its discharges | `packages/hospital/`, `packages/simulator/`, `packages/cases/` | 9f1d9d3, 28 Oct | a84ecc1, 30 Oct |
| Investigation tools | Evidence gathering, explanations, matched experiments, proposals | `packages/intelligence/` | 2079589, 28 Oct | 8acec42, 31 Oct |
| Workflow versions | Numbered versions, adoption by a person, a monitor, suspension | `packages/workflow/` | 09163f8, 28 Oct | df7f042, 28 Oct |
| Evaluator and claims | Scoring against simple baselines, the acceptance harness, the claims registry and its status file | `packages/evaluator/`, `evaluation/`, `apps/cli/` | d32b5be, 28 Oct | 1626f96, 1 Nov |
| Demo app | A view that shows and replays the agent's work and each claim's status | `apps/demo/` | d798a3c, 28 Oct | 21bbd95, 30 Oct |

## Built during the event, in the EMR

This work lives in the private EMR repository. Its owner commits in batches, so the dates below come from the build log kept during the event, not from that repository's commits. The engine commit is the first one in this repository that uses the work.

| Part | What was built | Built on | Engine commit |
| --- | --- | --- | --- |
| Clinician strip | A strip on the clinician's own EMR pages: listen and mute, the wake phrase, push-to-talk, the heard lines, each action with its proof | 28 Oct, extended to 31 Oct | c98e2a5, 28 Oct |
| Agent shown on the record | Rows an agent wrote show as that person's agent on vitals, charts, notes and history | 28 Oct | c98e2a5, 28 Oct |
| Door routes for the agent | New API routes the agent calls under its own session: voice orders and their countersign, verbal orders on a matched read-back, hand-offs between staff agents, voice match at the door, discharge and stay money read-backs | 29 to 31 Oct | 042e9e7, 30 Oct |
| Database migrations | Sixteen migrations adding tables and columns for order states, countersign batches, voice templates and their use, agent delegations, the nightly memo, voice authorisation, consent attestations, stay money rulings and voice match events; one moved a guard an earlier event migration added into code; applied to the sandbox databases only | 29 to 30 Oct | c40b921, 30 Oct |
| Fixes found by testing | Repeat-safe writes that commit, delegation scope, consent bases, the door's deny list, the strip resuming after a reload | 30 to 31 Oct | a74c77b, 31 Oct |

## Third-party code and models

The plan named six recipes from [meta-models/meta-model-cookbook](https://github.com/meta-models/meta-model-cookbook) (MIT) as design references: agent loop basics, managing context, alert fatigue copilot, append-only audit log, deterministic replay and goal tracking. A search of the tree on 31 Oct 2026 found no file that names the cookbook, so no file carries an attribution comment. Its MIT notice is kept in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

The models and runtimes the build uses, with their licences, are listed in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md). None of them is bundled in this repository; the local models are downloaded at setup.

No model was trained or fine-tuned for this project.
