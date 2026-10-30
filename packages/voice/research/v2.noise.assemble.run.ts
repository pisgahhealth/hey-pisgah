import { readFileSync, writeFileSync } from "node:fs";
import { scoreNoise, type NoiseFile } from "./v2.noise.score.js";

// Writes the noise-robustness table from the kept cosines; no audio and no model call.
const f = JSON.parse(readFileSync("packages/voice/research/fixtures/v2.noise.json", "utf8")) as NoiseFile & { built_at: string; denoiser: string };
writeFileSync("evaluation/results/attribution-noise.json", `${JSON.stringify({ built_at: f.built_at, owner_min: 0.41, radio_snr_db: f.radio_snr_db, denoiser: f.denoiser, table: scoreNoise(f) }, null, 1)}\n`);
console.log("written");
