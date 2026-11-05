# Hey Pisgah: Review Guide

**Built with Muse Spark Open.** [Watch the demo](https://youtu.be/JmE1d3voYg4) · [Run the evaluation](#run-the-evaluation)

Source checkpoint: `4d27cb2`. Results below come from earlier experiments, not a fresh evaluation of every feature at this checkpoint.

## How to assess the project

| Criterion / award | What to look for | Evidence |
| --- | --- | --- |
| Impact | A clinician talks while the agent writes notes, records observations and sends work to the lab, pharmacy and ward. The goal is more attention for patients and less time spent typing or chasing tasks. | [EMR integration](../packages/pisgah-adapter/README.md). Hospital-wide time savings and patient outcomes have not been measured here. |
| Meta tooling | Voice Transcribe turns speech into text. Spark Open works out what the clinician wants and which actions to take. In the investigation loop, it suggests reasons for delays and chooses experiments to test them. | [Investigation design](../packages/intelligence/README.md), [discovery results](../evaluation/results/discovery.json). Findings and limits are below. |
| Technical depth | The agent remembers unfinished tasks, handles corrections and checks what the hospital saved before saying work is done. After an interrupted request, it checks whether the action already happened before trying again. | [Runtime](../packages/agent/README.md), [EMR adapter](../packages/pisgah-adapter/README.md), [recovery tests](../packages/agent/test/uncertain.test.ts). |
| Demo | See spoken instructions produce changes inside the hospital EMR. The separate public app lets reviewers inspect recorded actions, experiments and results. | [Demo video](https://youtu.be/JmE1d3voYg4), [claim statuses](../evaluation/claims.status.json). The public app shows an evaluation/replay; the clinician interface requires the private EMR. |
| Best Agentic Use-Case | The agent carries out work across departments instead of stopping at a reply. It sends clinician-directed requests, keeps track of pending work and resumes after interruptions. Staff keep clinical decisions and required approvals. | [Recorded journey](../evaluation/results/journey-v2.json), [coordination implementation](../packages/pisgah-adapter/README.md). The older journey passed 25 of 26 steps; it is not a full pass of the final demo. |
| Best Build on Meta Open Weight Models | Muse Spark Open runs through Modal to interpret requests, choose actions and investigate workflow changes. We use the open-weight model without training or fine-tuning it. | [Model configuration](../packages/model/src/routes.ts), [recorded ledger](../apps/demo/fixtures/replay/live-v1-2026-10-28/ledger.json): Modal, `meta-models/Muse-Spark-Open-816B-A42B` and response IDs. This is an earlier recorded replay. [Hosted fallback exists](../packages/agent/src/emr/intent.ts), so the final video's model use still needs its own run evidence and partner verification. |

The submission does not claim the Muse Image/Wonder creative-build award.

## What we learned

These are observed behaviors in our test environment, not capabilities proven unique to Meta.

- **Investigating can produce a useful proposal.** At commitment revision 12, 6/8 medium-effort runs yielded a proposal that passed development validation, compared with 4/8 low-effort runs. Read `discover_config_*` and `discover_low_*` in [discovery.json](../evaluation/results/discovery.json). These small samples do not establish superiority or general reliability; the file's old top-level placeholder is not this experiment's result.
- **An improvement can fail when records arrive late.** One case fell from 166 to 57 simulated waiting minutes. Across 15 development cases, four improved, one worsened and ten were unchanged; median improvement was zero. The adverse case depended on a round entry recorded after sign-off. [Results and revised trigger](../evaluation/results/improve.json). Adoption used a simulated manager, not an independent human approver.
- **The learning loop can reconsider a change, but does not always do so.** With outcomes reversed to show harm, two of three second-cycle runs proposed rollback; one repeated the change. [Second-cycle evidence](../evaluation/results/cycle2.json). This is an experimental capability, not a claim of reliable self-improvement.

## Problems we worked around

These are application safeguards, separate from model discoveries.

| Problem | Response and evidence |
| --- | --- |
| Speech readings disagree on numbers. | Cross-check readings and request clarification. [Five labelled runs](../evaluation/results/values.json): 41 values written, zero wrong writes, seven questions; only three runs used two readings. |
| Hospital names are misheard. | Add vocabulary hints. [206-line experiment](../evaluation/results/transcribe-hints.json): word error fell from 40.66% to 27.66%. Known names were supplied; accents remain a limitation. |
| A model can say work is done without a saved action. | Verify records independently. [Recorded example](../evaluation/results/completion.json), [verification implementation](../packages/pisgah-adapter/src/port.ts). |
| Audio or delivery gets interrupted. | Order completed turns, handle stalled audio and check uncertain writes before retrying. [Stream tests](../packages/agent/test/meta-stream.test.ts), [uncertain-write tests](../packages/agent/test/uncertain.test.ts). Tests are not evidence of uninterrupted all-day use. |
| Speaker labels do not establish authority. | Combine local matching with signed sessions and confirmations. [Attribution research and limitations](../packages/voice/research/README.md). Mixed speech and playback remain limitations. |

## Original work

The EMR predates the hackathon. The agent, speech integration, investigation and evaluation are event work; EMR-side interface and API additions are in the private repository. [Contribution map](CONTRIBUTIONS.md).

## Run the evaluation

Requires Node.js 20.9+ and npm.

```bash
git clone https://github.com/pisgahhealth/hey-pisgah.git
cd hey-pisgah
npm ci
HEY_PISGAH_DEMO_SOURCE=fixture npm run demo
```

Open [localhost:3000](http://localhost:3000). This shows a recorded run and its evaluation without API keys or paid model calls. The clinician's microphone interface lives inside the private Pisgah EMR; it is not included in this public app.

For type checks and tests: `npm run ci`.

See the [evaluation evidence](../evaluation/) for results and limitations.
