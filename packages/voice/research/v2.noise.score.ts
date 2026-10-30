import { upper95 } from "./v2.score.js";

// Per front end: owner lines passing 0.41 by group, other people passing it with the bound, the joined radio lines, and the gap between them.
export type NoiseFile = { radio_snr_db: number; groups: Record<string, { group: string; owner: boolean; snr_db: number }>; results: Record<string, { ms_per_s: number; cos: Record<string, number | null> }> };
// Denoise only a clip whose own speech-to-floor ratio is under the limit, so quiet speech goes to the model untouched.
export const DENOISE_BELOW_DB = 20;
export function withGatedDenoise(f: NoiseFile): NoiseFile {
  const base = f.results["baseline"]!, den = f.results["denoise"]!;
  const cos = Object.fromEntries(Object.keys(base.cos).map((id) => { const first = id.split("+")[0]!; const g = f.groups[first]; return [id, g && g.snr_db < DENOISE_BELOW_DB ? den.cos[id]! : base.cos[id]!]; }));
  const noisy = Object.values(f.groups).filter((g) => g.snr_db < DENOISE_BELOW_DB).length / Object.keys(f.groups).length;
  // Both readings, the higher kept: two tries per line, so it is scored against the other voices with the same two tries.
  const best = Object.fromEntries(Object.keys(base.cos).map((id) => [id, Math.max(base.cos[id] ?? -1, den.cos[id] ?? -1)]));
  return { ...f, results: { ...f.results, [`denoise when under ${DENOISE_BELOW_DB} dB`]: { ms_per_s: Math.round((base.ms_per_s + noisy * (den.ms_per_s - base.ms_per_s)) * 10) / 10, cos }, "best of plain and denoised": { ms_per_s: Math.round((base.ms_per_s + den.ms_per_s) * 10) / 10, cos: best } } };
}
export function scoreNoise(f0: NoiseFile, ownerMin = 0.41) {
  const f = withGatedDenoise(f0);
  return Object.fromEntries(Object.entries(f.results).map(([name, r]) => {
    const pass = (ids: string[]) => ids.filter((id) => (r.cos[id] ?? -1) >= ownerMin).length;
    const groups = [...new Set(Object.values(f.groups).map((g) => g.group))].sort();
    const by = Object.fromEntries(groups.map((g) => { const ids = Object.keys(f.groups).filter((id) => f.groups[id]!.group === g); const k = pass(ids); return [g, f.groups[ids[0]!]!.owner ? { k, n: ids.length } : { k, n: ids.length, upper95: upper95(k, ids.length) }]; }));
    const joined = Object.keys(r.cos).filter((id) => id.includes("+"));
    const others = Object.keys(f.groups).filter((id) => !f.groups[id]!.owner).map((id) => r.cos[id] ?? -1);
    const radio = Object.keys(f.groups).filter((id) => f.groups[id]!.group === "owner radio").map((id) => r.cos[id] ?? -1).sort((a, b) => a - b);
    return [name, { ...by, "owner radio, two adjacent lines joined": { k: pass(joined), n: joined.length }, highest_other_voice: Math.max(...others), owner_radio_median: radio[radio.length >> 1], ms_per_audio_second: r.ms_per_s }];
  }));
}
