# intelligence

The investigator: it reads recorded discharges, records hypotheses, runs matched experiments and submits workflow change proposals.

| Piece | What it does |
| --- | --- |
| Pool | The 12 discovery histories only. Any other id gets the same `unknown_id` answer. |
| Read tools | Case list, timeline pages, records, intervals, queue snapshots, staff activity, ward requirements, the workflow definition. Notes arrive as `untrusted_text`, at most 500 characters. |
| Hypotheses | Free-text statement and mechanism, 3 or more events from 2 or more cases, `if_true` and `if_false` predictions. Records never change; a revision is a new record. |
| Experiments | Control and changed version on the same frozen schedule with the world rules. A sub-log or hash mismatch aborts. 8 experiments, 6 cases each, 3 refused requests end access. |
| Prediction check | Computed by the app before and after each run, never shown to the model. Inconclusive is a normal outcome. |
| Status rules | Retained needs a matching `if_true` result. Rejected needs `if_false`, a contradiction, or cited events. A refusal counts as a say-do mismatch. |
| Proposals | Appended to `learning/proposals`; the evaluator writes `learning/validations`. 3 per run, 1 for the prior arm. |
| Stop rule | Budget spent, a dev-valid proposal, a declared negative, or lockout. |

## Arms

| Arm | Tools |
| --- | --- |
| adaptive | everything, including `run_experiment` |
| a3 | the same without the experiment tools; the prompt loses one sentence |
| a4 | a committed experiment list the model does not choose |
| prior | definition, requirements, one proposal; no records, no experiments |

## Commands

| Command | Use |
| --- | --- |
| `npm run discover -- --arm adaptive --budget-usd 8 --max-calls 120` | one run; mock unless `HEY_PISGAH_MODE=live` |
| `npm run check:discovery -- <run_id>` | hypotheses, experiments with their prediction checks, outcome, cost, deny-list scan |
| `npx tsx packages/intelligence/src/commit-run.ts --reason "<why>"` | append a commitment revision after any prompt or tool change |

A live run refuses unless the prompt and tool hashes equal the last revision in `evaluation/commitments/intelligence.json`.
