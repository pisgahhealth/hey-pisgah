# Hey Pisgah

A personal agent for hospital discharge administration that discovers and adapts under approval: it finds a better workflow from evidence, tests it in a simulator it cannot tune, and applies the change a person approved on a new case. Built on Meta Muse models for the Meta Global AI Developer Hackathon 2026, startup track.

**Prior work disclosure.** Pisgah Health's hospital platform existed before this hackathon. Everything in this repository was built during the event (27 October to 4 November 2026) and runs standalone on synthetic records; no patient data and no production system is involved. `docs/CONTRIBUTIONS.md` maps prior work, event-built work and adapted third-party code to commits.

**Status.** Scaffold. Each lane lands its package; `docs/ARCHITECTURE.md` describes the contracts. Boundary lint, the claims registry and CI checks arrive with the first lanes.

```bash
npm install
npm run ci
```
