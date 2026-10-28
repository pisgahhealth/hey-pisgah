# Baseline

This page says what existed before the event. [CONTRIBUTIONS.md](CONTRIBUTIONS.md) says what was built during it.

## This repository

Every file here was written during the event, 27 Oct to 4 Nov 2026.

The hospital platform's own code is not in this repository. You do not need it to build, run or test anything here.

## The platform

Pisgah Health runs a hospital platform. It covers patients, admissions, pharmacy and accounts.

Discharge on the platform works in three steps.

| Step | Who | What happens |
| --- | --- | --- |
| 1 | Doctor | Discharges the patient. This closes the stay and issues the bill. |
| 2 | Accounts | Takes payment. |
| 3 | Accounts | Gives financial clearance. This frees the bed and prints a gate pass. |

Pharmacy reviews and dispenses the take-home medicines.

## Agent groundwork from 16 Oct 2026

A build on 16 Oct 2026 added the pieces below.

| Piece | What it does |
| --- | --- |
| Agent identities | An agent acts under its own name. |
| Safe repeat requests | Sending the same request twice has the effect of one. |
| On-behalf-of audit trail | Records which staff member an agent acted for. |
| Background job runner | Runs work outside a user's request. |
| Proposals card | Shows staff what an agent suggests. |
| Corrections table | Keeps the fixes staff make to agent output. |

## What did not exist

The platform had no tool calling and no agent loop. It did not save agent tasks.

It had no workflow definitions or versions. It had no simulator, no evaluator and no store of lessons learned.

It did not use any Meta model.

## Earlier product documents

| Document | Date |
| --- | --- |
| Hey Pisgah product brief | 2 Aug 2026 |
| Voice-first UI prototype | 14 Oct 2026 |
| Hackathon pitch | 26 to 27 Oct 2026 |

These set the direction. None of them is code in this repository.
