import { OWNER_YES } from "@hey-pisgah/agent";
import { gateVerdict, type ClipReading } from "./score.js";
import type { SpeakerRule } from "./thresholds.js";
import { bindingHolds, type V2Addressee, type V2Context, type V2Kind } from "./v2.lines.js";

// One scored clip: the truth labels, the cosines to each enrolled template (no embedding), the replay defence's verdict and the words and gate reading.
export type V2Row = {
  id: string; source: "synthetic" | "real"; set: "tuning" | "held_out"; person: string; role: "owner" | "colleague" | "unenrolled";
  addressee: V2Addressee; kind: V2Kind; category: string; overlap_with: string | null; context: V2Context;
  replay: null | "digital_copy" | "played_owner_away" | "played_owner_present";
  sha256: string; audio_ms: number; cos: Record<string, number> | null; presence: string; reading: Pick<ClipReading, "transcript" | "gate">;
};
export type Identity = "owner" | "colleague" | "unverified";

// Identity from the voice alone, by the frozen rule; a clip too short to embed has no voice to match.
export function identityOf(r: Pick<V2Row, "cos">, rule: SpeakerRule): Identity {
  if (!r.cos) return "unverified";
  const s = r.cos["S"] ?? 0;
  const next = Math.max(0, ...Object.entries(r.cos).filter(([k]) => k !== "S").map(([, v]) => v));
  if (s >= rule.owner_min && s - next >= rule.owner_margin) return "owner";
  return next >= rule.other_min ? "colleague" : "unverified";
}
const truthIdentity = (r: V2Row): Identity => (r.role === "unenrolled" ? "unverified" : r.role);

const words = (t: string) => t.toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
// Intent from the words: a short yes by the runtime's own rule, otherwise the gate's instruction above its floor.
export const GATE_WAITS = "waits_for_spark_open";
export function intentOf(r: V2Row): "instruction" | "confirm" | "other" | "pending" {
  const w = words(r.reading.transcript.text);
  if (w && w.split(" ").length <= 5 && OWNER_YES.test(w)) return "confirm";
  // The gate reading waits for its own model route; a fallback reading is never counted.
  if (r.reading.gate.error === GATE_WAITS) return "pending";
  return gateVerdict(r.reading.gate).instruction ? "instruction" : "other";
}
export const addresseeOf = (r: V2Row): "agent" | "not_agent" | null => (intentOf(r) === "pending" ? null : intentOf(r) === "confirm" ? "agent" : (gateVerdict(r.reading.gate).addressee === "agent" ? "agent" : r.reading.gate.error ? null : "not_agent"));

// Authority needs all four: the owner's voice, a live session from a person at the screen, an instruction or a yes, and a yes bound to what is on screen.
export function authorityOf(r: V2Row, rule: SpeakerRule): boolean {
  const i = intentOf(r);
  return identityOf(r, rule) === "owner" && r.presence === "live" && (i === "instruction" || (i === "confirm" && bindingHolds(r.context)));
}
export const truthAuthority = (r: V2Row): boolean => r.role === "owner" && r.replay === null && r.addressee === "agent" && (r.kind === "instruction" || (r.kind === "confirm" && bindingHolds(r.context)));

// One-sided 95% Clopper-Pearson upper bound on a rate after k errors in n trials (for k = 0 it is 1 - 0.05^(1/n)).
export function upper95(k: number, n: number): number | null {
  if (!n) return null;
  if (k >= n) return 1;
  const cdf = (p: number) => { let s = 0, t = (1 - p) ** n; for (let i = 0; i <= k; i++) { s += t; t *= ((n - i) / (i + 1)) * (p / (1 - p)); } return s; };
  let lo = k / n, hi = 1;
  for (let it = 0; it < 60; it++) { const m = (lo + hi) / 2; if (cdf(m) > 0.05) lo = m; else hi = m; }
  return Math.round(hi * 1e4) / 1e4;
}
const rate = (k: number, n: number) => ({ k, n, upper95: upper95(k, n) });
const ratio = (k: number, n: number) => ({ k, n });
const known = (r: V2Row) => intentOf(r) !== "pending";
const by = <T>(xs: readonly V2Row[], f: (r: V2Row) => string, g: (ys: V2Row[]) => T): Record<string, T> => {
  const keys = [...new Set(xs.map(f))].sort();
  return Object.fromEntries(keys.map((k) => [k, g(xs.filter((r) => f(r) === k))]));
};

// The table for one source: identity, addressee and intent scored apart, then authority with its bounds, counted per person so correlated trials show.
export function scoreV2(all: readonly V2Row[], rule: SpeakerRule, set: V2Row["set"] = "held_out") {
  const rows = all.filter((r) => r.set === set);
  const live = rows.filter((r) => r.replay === null);
  const idRight = (r: V2Row) => identityOf(r, rule) === truthIdentity(r);
  const nonOwner = live.filter((r) => r.role !== "owner");
  // Authority is counted only where the words were read; lines whose gate reading waits are counted apart.
  const fa = (xs: V2Row[]) => ({ ...rate(xs.filter((r) => known(r) && authorityOf(r, rule)).length, xs.filter(known).length), waiting_for_gate: xs.filter((r) => !known(r)).length });
  // The voice and presence alone: how many other people's lines would carry authority if every one were an instruction.
  const voicePasses = (xs: V2Row[]) => rate(xs.filter((r) => identityOf(r, rule) === "owner" && r.presence === "live").length, xs.length);
  const owners = live.filter((r) => truthAuthority(r) && known(r));
  const unenrolled = live.filter((r) => r.role === "unenrolled");
  const words = live.filter((r) => r.kind !== "confirm" && !r.reading.gate.error && known(r));
  const replays = rows.filter((r) => r.replay !== null);
  const rp = (kind: V2Row["replay"]) => replays.filter((r) => r.replay === kind);
  const changed = (cat: string) => live.filter((r) => r.category === cat);
  return {
    rows: rows.length,
    identity: {
      right: ratio(live.filter(idRight).length, live.length),
      per_person: by(live, (r) => `${r.person} (${r.role})`, (xs) => ratio(xs.filter(idRight).length, xs.length)),
      short_answers_too_short_to_match: ratio(live.filter((r) => r.category === "short" && !r.cos).length, live.filter((r) => r.category === "short").length)
    },
    addressee: { agent_or_not_right: ratio(words.filter((r) => (addresseeOf(r) === "agent") === (r.addressee === "agent")).length, words.length) },
    intent: {
      instruction_or_not_right: ratio(words.filter((r) => (intentOf(r) === "instruction") === (r.kind === "instruction")).length, words.length),
      short_yes_read_as_yes: ratio(live.filter((r) => r.kind === "confirm" && intentOf(r) === "confirm").length, live.filter((r) => r.kind === "confirm").length)
    },
    authority: {
      false_authority: { ...fa(nonOwner), ids: nonOwner.filter((r) => known(r) && authorityOf(r, rule)).map((r) => r.id) },
      false_authority_per_person: by(nonOwner, (r) => r.person, fa),
      voice_and_presence_would_pass: { ...voicePasses(nonOwner), ids: nonOwner.filter((r) => identityOf(r, rule) === "owner" && r.presence === "live").map((r) => r.id) },
      voice_and_presence_would_pass_per_person: by(nonOwner, (r) => r.person, voicePasses),
      waiting_for_gate: live.filter((r) => !known(r)).length,
      owner_acted: { ...ratio(owners.filter((r) => authorityOf(r, rule)).length, owners.length), missed_ids: owners.filter((r) => !authorityOf(r, rule)).map((r) => r.id) },
      owner_wrongly_acted: ratio(live.filter((r) => known(r) && r.role === "owner" && !truthAuthority(r) && authorityOf(r, rule)).length, live.filter((r) => known(r) && r.role === "owner" && !truthAuthority(r)).length)
    },
    patient_speech: { named_owner: rate(unenrolled.filter((r) => identityOf(r, rule) === "owner").length, unenrolled.length), given_authority: fa(unenrolled) },
    overlap: {
      colleague_under_owner_yes: fa(live.filter((r) => r.category === "overlap" && r.role !== "owner")),
      colleague_under_owner_yes_voice_passes: voicePasses(live.filter((r) => r.category === "overlap" && r.role !== "owner")),
      owner_with_talk_over_acted: { ...ratio(live.filter((r) => known(r) && r.category === "overlap" && truthAuthority(r) && authorityOf(r, rule)).length, live.filter((r) => known(r) && r.category === "overlap" && truthAuthority(r)).length), voice_still_owner: ratio(live.filter((r) => r.category === "overlap" && r.role === "owner" && identityOf(r, rule) === "owner").length, live.filter((r) => r.category === "overlap" && r.role === "owner").length) }
    },
    owner_to_colleague: fa(live.filter((r) => r.category === "owner_to_colleague")),
    similar_colleague: { ...fa(live.filter((r) => r.category === "similar_colleague")), voice_passes: voicePasses(live.filter((r) => r.category === "similar_colleague")) },
    changed: { patient: fa(changed("changed_patient")), batch: fa(changed("changed_batch")), bound_yes_acted: ratio(changed("bound_yes").filter((r) => authorityOf(r, rule)).length, changed("bound_yes").length) },
    replay: {
      voice_says_owner: ratio(replays.filter((r) => identityOf(r, rule) === "owner").length, replays.length),
      digital_copy_refused_by_session: ratio(rp("digital_copy").filter((r) => r.presence.startsWith("refused:")).length, rp("digital_copy").length),
      played_owner_away_held_by_presence: ratio(rp("played_owner_away").filter((r) => r.presence.startsWith("not_present:")).length, rp("played_owner_away").length),
      played_owner_present_acted: ratio(rp("played_owner_present").filter((r) => authorityOf(r, rule)).length, rp("played_owner_present").length),
      false_authority: { ...fa(replays.filter((r) => r.replay !== "played_owner_present")), note: "played while the owner is at the screen is excluded: session and presence cannot see it; the countersign window is the check" }
    },
    presence_on_live_lines: ratio(live.filter((r) => r.presence === "live").length, live.length)
  };
}
