# Contribution map

This page separates prior work, event work and borrowed code. Prior work is described in [BASELINE.md](BASELINE.md).

Every file in this repository was written during the event, 27 Oct to 4 Nov 2026.

Commits and demo timestamps are added at submission. The files column names the folder for each part.

## What was built

| Demonstrated contribution | What existed at event start | What was built during the event | Files and commits | Demo timestamp |
| --- | --- | --- | --- | --- |
| Agent runtime and tools | Agent identities and an audit trail. No tool calling or agent loop. | An agent loop that calls tools, keeps its goal and saves its progress so it can resume. | `packages/agent/`, `packages/contracts/`; commits filled at submission | filled at submission |
| Synthetic hospital and simulator | A real discharge process. No simulator. | A made-up hospital, described as data, and a simulator that runs its discharges. | `packages/hospital/`, `packages/simulator/`; commits filled at submission | filled at submission |
| Case generator and pools | None. | Generated patient cases, split into separate sets for building, discovery, new situations and the demo. | `packages/cases/`; commits filled at submission | filled at submission |
| Investigation and experiment tools | None. | Tools the agent uses to gather evidence, test an explanation and draft a proposal. | `packages/intelligence/`; commits filled at submission | filled at submission |
| Workflow versions, adoption and monitor | A proposals card. No workflow versions. | Numbered workflow versions, a way to adopt a change and a check that the change still helps. | `packages/workflow/`; commits filled at submission | filled at submission |
| Evaluator, baselines and claims registry | A corrections table. No evaluator. | Tests that score the agent against simple baselines, a held-back test run, and a list tying each claim to its evidence. | `packages/evaluator/`, `evaluation/`; commits filled at submission | filled at submission |
| Demo app | A voice-first UI prototype, used as a design reference. | A demo app that shows and replays the agent's work. | `apps/demo/`, `fixtures/golden/`; commits filled at submission | filled at submission |
| Voice input | None. | Speech-to-text for spoken requests, with a browser recorder. | `packages/voice/`; commits filled at submission | filled at submission |
| Model layer and ledger | No Meta model use. A background job runner. | Clients for Meta models, a record of every model call, spending limits and replay for tests. | `packages/model/`, `packages/store/`; commits filled at submission | filled at submission |

## Adapted third-party code

These recipes come from [meta-models/meta-model-cookbook](https://github.com/meta-models/meta-model-cookbook). Its licence is MIT. We checked the licence and recipe names on 28 Oct 2026.

Each recipe was adapted, not copied. The adapted file carries a one-line attribution comment.

| Recipe | Treatment | File with the attribution comment |
| --- | --- | --- |
| Agent loop basics | Adapted, not copied | to be filled when the code lands |
| Managing context | Adapted, not copied | to be filled when the code lands |
| Alert fatigue copilot | Adapted, not copied | to be filled when the code lands |
| Append-only audit log | Adapted, not copied | to be filled when the code lands |
| Deterministic replay | Adapted, not copied | to be filled when the code lands |
| Goal tracking | Adapted, not copied | to be filled when the code lands |

The full notice is in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
