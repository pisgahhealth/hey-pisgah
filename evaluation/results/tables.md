# Evaluation tables (dev, measured, 2026-10-28T03:21:27.939Z)

All times are simulated minutes. Rows run on the definition executor unless stated.

## Primary

| Arm | Status | Cases | Pass | Required steps % | Prohibited attempted | Prohibited executed | Planned checks | Unplanned | Unnecessary docs | Duplicates | Stale | Rework (events, min) | Wait median (sim min) | Wait p90 (sim min) | Bed release median (sim min) | Model cost USD | Decided by (model, runtime, person) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A0 | measured | 15 | 15 | 100 | 0 | 0 | 26 | 0 | 0 | 0 | 0 | 0, 0 | 134 | 238 | 78 | - | 0, 58, 183 |
| A1 | measured | 15 | 15 | 100 | 0 | 0 | 26 | 0 | 0 | 0 | 0 | 40, 40 | 84 | 238 | 78 | - | 0, 98, 183 |
| A2 | not_run | - | - | - | - | - | - | - | - | - | - | - | - | - | - | - | - |
| A2a | not_run | - | - | - | - | - | - | - | - | - | - | - | - | - | - | - | - |
| A3 | not_run | - | - | - | - | - | - | - | - | - | - | - | - | - | - | - | - |
| A4 | not_run | - | - | - | - | - | - | - | - | - | - | - | - | - | - | - | - |
| A-prior | not_run | - | - | - | - | - | - | - | - | - | - | - | - | - | - | - | - |

Sweep: 1108 candidates, 835 valid single operations, 835 validated, 708 pass the dev gate, 0 also cut a wait by 30 or more. no single operation reproduces it; the reference is 2 operations and the space holds single operations only

## Paired against A1

| Arm | Metric | n | Wins | Ties | Losses | Sign test p | Small n |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A0 | post_signoff_wait_min | 15 | 0 | 10 | 5 | 0.0625 | true |
| A0 | rework_min | 15 | 15 | 0 | 0 | 0.0001 | false |
| A0 | unnecessary_docs | 15 | 0 | 15 | 0 | 1 | true |

## FR-1 decision points

| Arm | Points | Reached | Appropriate | Unnecessary questions | Unnecessary refusals | Failures to act | Prohibited | Prohibited attempts |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A0 | 81 | 81 | 80 | 0 | 0 | 1 | 0 | 0 |
| A1 | 81 | 81 | 80 | 0 | 0 | 1 | 0 | 0 |

## FR-4 reruns (definition executor, five reruns)

| Cases | Consistent | Differences | Omissions | Duplicates | Incorrect | Inconsistent outcomes | Unsafe |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 6 | 6 | 0 | 0 | 0 | 0 | 0 | 0 |

## Prediction checks

| Source | Experiments | Distinguishing | Speaking | Landed if_true | Contradicted | Inconclusive |
| --- | --- | --- | --- | --- | --- | --- |
| adaptive | 0 | 0 | 0 | 0 | 0 | 0 |
| A4 committed order | 8 | 0 | 0 | 0 | 0 | 0 |
| 30 random experiments | 30 | 0 | 0 | 0 | 0 | 0 |
