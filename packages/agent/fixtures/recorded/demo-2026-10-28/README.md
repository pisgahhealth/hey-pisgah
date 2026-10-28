# Demo cases, recorded live on 28 Oct 2026

Two cases run live on Muse Spark Open (Modal, effort low on every call) under adopted version 2. Version 2 is the A-prior change (claim cover no longer waits for the summary final), adopted through serve by the synthetic ward manager.

| Step | Case | Task | Result | Calls | Cost |
| --- | --- | --- | --- | --- | --- |
| 5 | c-110f6ad7 (Ward A, r1) | t-e9687333 | done, every condition proved | 38 | $0.331 |
| 6 | c-2a14921a (Ward B, r2 from minute 600) | t-84aa48a0 | done, every condition proved | 50 | $0.472 |

`recordings/` holds the 88 model responses. Each request is cut down to a stub, since replay looks a recording up by its hash; the full requests are kept outside the repo.

Replay: `packages/agent/test/demo-replay.test.ts` opens both tasks in order on a fresh store and checks each effect_set_hash.
