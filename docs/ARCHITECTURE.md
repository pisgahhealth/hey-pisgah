# Architecture

One sentence per package. Details live in each package's README as it lands.

| Package | Owns | Must never |
|---|---|---|
| contracts | the shared types and zod schemas, the hash chain, the two-clock rule | import any other package |
| store | append-only JSONL streams with a single writer and crash recovery | be opened by two writers |
| workflow | workflow versions, fences, soft edges, applicability, adoption | let an operation touch a fence |
| simulator | the deterministic engine and the definition executor | contain a hospital step or document name |
| hospital | the discharge world as data: steps, documents, staff, rules | branch on a version or proposal id |
| cases | the case generator and the dev, discovery, variation and demo pools | hold reserved cases on disk |
| model | provider clients, the per-call ledger, budgets, mock replay | call a provider without an explicit effort |
| agent | the personal agent runtime: tasks, wakes, proofs, tools | expose a tool for a clinical or money action |
| intelligence | evidence tools, hypotheses, experiments, proposals | import the evaluator |
| evaluator | acceptance checks, baselines, the one reserved run, claims status | be imported by agent or intelligence |
| voice | Muse Voice Transcribe client and browser recorder | pass a partial transcript to the agent |

## Data flow

A clinician's goal, by voice or text, opens a durable task. The agent works through hospital tools, waits on external events with no model calls, and proves each action by re-reading the record. The intelligence layer reads histories, pre-registers hypotheses, runs matched experiments in the simulator and submits a proposal. The evaluator validates it on dev cases. A person adopts it. The agent uses the adopted version on the next case. The evaluator runs every arm once on the reserved cases and writes the claims status that the demo displays.

## Storage

Every durable record is a line in an append-only JSONL stream with a hash chain. In a hospital deployment the same envelope maps to an append-only Postgres table with the same fields and the same chain.
