import { readFileSync, writeFileSync } from "node:fs";
import { thresholdsAt } from "./thresholds.js";
import { v2Counts } from "./v2.lines.js";
import { scoreV2, type V2Row } from "./v2.score.js";

// Scores the kept v2 readings against the threshold revision frozen before they were built, per source, and writes the public result.
const fx = JSON.parse(readFileSync("packages/voice/research/fixtures/v2.readings.json", "utf8")) as { built_at: string; rows: V2Row[] };
const rev = thresholdsAt(fx.built_at);
if (!rev) throw new Error("no threshold revision was frozen before this set was built");
const of = (s: V2Row["source"]) => fx.rows.filter((r) => r.source === s);
const cost = fx.rows.reduce((n, r) => n + (r.reading.transcript.cost_usd ?? 0) + (r.reading.gate.cost_usd ?? 0), 0);
writeFileSync("evaluation/results/attribution-v2.json", `${JSON.stringify({
  thresholds: { revision: rev.revision, hash: rev.hash, frozen_at: rev.frozen_at }, built_at: fx.built_at,
  script: v2Counts(),
  synthetic: scoreV2(of("synthetic"), rev.body.speaker), real: scoreV2(of("real"), rev.body.speaker),
  reading_cost_usd_kept_rows: Math.round(cost * 1e4) / 1e4
}, null, 1)}\n`);
console.log("written");
