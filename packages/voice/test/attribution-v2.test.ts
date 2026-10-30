import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hashJson } from "@hey-pisgah/contracts";
import { PRESENCE_RULE, denyHits } from "@hey-pisgah/agent";
import { SEED, readThresholds, thresholdsAt } from "../research/thresholds.js";
import { V2_LINES, V2_ROLE, v2Counts } from "../research/v2.lines.js";
import { authorityOf, identityOf, scoreV2, upper95, type V2Row } from "../research/v2.score.js";
import { scoreNoise } from "../research/v2.noise.score.js";

const root = join(import.meta.dirname, "..", "..", "..");
const fx = JSON.parse(readFileSync(join(import.meta.dirname, "..", "research", "fixtures", "v2.readings.json"), "utf8")) as { built_at: string; rows: V2Row[] };
const published = JSON.parse(readFileSync(join(root, "evaluation", "results", "attribution-v2.json"), "utf8"));
const rule = thresholdsAt(fx.built_at)!.body.speaker;

describe("the v2 recording script", () => {
  it("asks for at least 300 non-owner lines, 30 overlaps, a replayed sequence, short answers by everyone, and a changed patient and batch", () => {
    const c = v2Counts();
    expect(V2_LINES.filter((l) => V2_ROLE[l.who] !== "owner").length).toBeGreaterThanOrEqual(300);
    expect(c.overlap).toBeGreaterThanOrEqual(30);
    expect(V2_LINES.filter((l) => l.replay_of).every((l) => l.set === "held_out" && V2_LINES.find((o) => o.id === l.replay_of)?.set === "tuning")).toBe(true);
    expect(new Set(V2_LINES.filter((l) => l.block === "Y").map((l) => l.who))).toEqual(new Set(["S", "N", "C", "U"]));
    expect(V2_LINES.some((l) => l.context.read_back && l.context.read_back.patient !== l.context.patient)).toBe(true);
    expect(V2_LINES.some((l) => l.context.read_back && l.context.batch_now !== l.context.read_back.batch)).toBe(true);
    expect(new Set(V2_LINES.map((l) => l.id)).size).toBe(V2_LINES.length);
  });

  it("is written as ward talk (R-27) and passes the deny-list scan", () => {
    for (const l of V2_LINES) {
      expect(l.words).not.toMatch(/^(hey )?pisgah\b/i);
      expect(denyHits(`${l.words} ${l.overlap?.words ?? ""}`)).toEqual([]);
    }
  });
});

describe("the owner's v2 recordings", () => {
  const set = JSON.parse(readFileSync(join(import.meta.dirname, "..", "research", "v2-real-set.json"), "utf8")) as { cuts: { id: string; part: string; set: string; status: string; sha256: string }[] };
  it("has one cut, or a missing mark, for every part the script gives the owner", () => {
    const want = V2_LINES.flatMap((l) => [...(l.who === "S" ? [`${l.id}:${l.replay_of ? "replay" : "line"}`] : []), ...(l.overlap?.who === "S" ? [`${l.id}:overlap_part`] : [])]).sort();
    expect(set.cuts.map((c) => `${c.id}:${c.part}`).sort()).toEqual(want);
    expect(set.cuts.filter((c) => c.status === "missing").map((c) => c.id)).toEqual(["O045", "O084"]);
  });
  it("keeps every cut's hash in the fixture, so a re-cut cannot slip in unseen", () => {
    const rows = new Set(fx.rows.filter((r) => r.source === "owner_v2").map((r) => r.sha256));
    for (const c of set.cuts.filter((x) => x.status !== "missing" && x.id !== "O083")) expect(rows.has(c.sha256)).toBe(true);
  });
});

describe("the owner's re-recordings", () => {
  const redo = JSON.parse(readFileSync(join(import.meta.dirname, "..", "research", "v2-redo-set.json"), "utf8")) as { cuts: { id: string; status: string; sha256: string }[] };
  it("cuts every re-recorded line and every full-volume replay, and keeps each hash in the fixture", () => {
    const want = ["O045", "O083", "O084", ...Array.from({ length: 20 }, (_, i) => `R${String(i + 11).padStart(3, "0")}`)];
    expect(redo.cuts.map((c) => c.id)).toEqual(want);
    expect(redo.cuts.filter((c) => c.status === "missing")).toEqual([]);
    const hashes = new Set(fx.rows.map((r) => r.sha256));
    for (const c of redo.cuts) expect(hashes.has(c.sha256)).toBe(true);
  });
  // O045 and O084 were missing and O083 was kept out in Part 4, so only the 40 replay rows are superseded.
  it("keeps the rows they replace, marked superseded and out of every count", () => {
    const old = fx.rows.filter((r) => r.source === "owner_v2" && /^v2-R0(1[1-9]|2\d|30)-(away|here)$/.test(r.id));
    expect(old).toHaveLength(40);
    for (const r of old) expect([r.usable, r.note?.startsWith("superseded")]).toEqual([false, true]);
    expect(published.owner_v2.held_out.unusable.filter((u: string) => u.includes("superseded"))).toHaveLength(40);
  });
});

describe("frozen thresholds", () => {
  it("keeps every revision with its source, date, reason and body hash, and never rewrites one", () => {
    const f = readThresholds();
    expect(f.revisions.map(({ hash: _h, ...r }) => r)).toEqual(SEED);
    for (const r of f.revisions) {
      expect(r.hash).toBe(hashJson(r.body));
      expect(r.source.length && r.reason.length && r.frozen_at.length).toBeTruthy();
    }
  });

  it("freezes the replay defence's limits beside the voice rule, so a code change without a new revision goes red", () => {
    expect(readThresholds().revisions.at(-1)!.body.presence).toEqual({ ...PRESENCE_RULE });
  });

  it("scores the v2 set with the revision frozen before the set was built", () => {
    expect(published.thresholds.revision).toBe(thresholdsAt(fx.built_at)!.revision);
    expect(published.thresholds.frozen_at < fx.built_at).toBe(true);
  });
});

describe("the v2 harness on the data held now", () => {
  it("reproduces the published table from the kept readings", () => {
    expect(scoreV2(fx.rows.filter((r) => r.source === "synthetic"), rule)).toEqual(published.synthetic);
    expect(scoreV2(fx.rows.filter((r) => r.source === "real"), rule)).toEqual(published.real);
    expect(scoreV2(fx.rows.filter((r) => r.source === "owner_v2"), rule)).toEqual(published.owner_v2.held_out);
  });

  it("gives the binomial upper bound for zero and small error counts", () => {
    expect(upper95(0, 30)).toBeCloseTo(1 - 0.05 ** (1 / 30), 3);
    expect(upper95(0, 4)).toBeCloseTo(0.5271, 3);
    expect(upper95(1, 20)).toBeCloseTo(0.2161, 2);
    expect(upper95(0, 0)).toBeNull();
  });

  it("goes red when the voice calls everyone the owner (negative control)", () => {
    const fooled = fx.rows.map((r) => ({ ...r, cos: { S: 0.99 } }));
    expect(fooled.filter((r) => r.role !== "owner" && r.replay === null && authorityOf(r, rule)).length).toBeGreaterThan(0);
  });

  it("goes red when presence is ignored: replays played with the owner away act (negative control)", () => {
    const away = fx.rows.filter((r) => r.replay === "played_owner_away");
    expect(away.length).toBeGreaterThan(0);
    expect(away.filter((r) => authorityOf(r, rule)).length).toBe(0);
    expect(away.filter((r) => authorityOf({ ...r, presence: "live" }, rule)).length).toBeGreaterThan(0);
    expect(away.filter((r) => identityOf(r, rule) === "owner").length).toBeGreaterThan(0);
  });

  it("goes red when a yes is not bound to its patient and batch (negative control)", () => {
    const changed = fx.rows.filter((r) => r.category === "changed_patient" || r.category === "changed_batch");
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.filter((r) => authorityOf(r, rule)).length).toBe(0);
    const unbound = changed.map((r) => ({ ...r, context: { ...r.context, patient: r.context.read_back!.patient, batch_now: r.context.read_back!.batch } }));
    expect(unbound.filter((r) => authorityOf(r, rule)).length).toBeGreaterThan(0);
  });

  it("keeps no voice embedding and no audio, only cosines", () => {
    const text = JSON.stringify(fx);
    expect(text).not.toMatch(/data:audio|UklGR/);
    for (const r of fx.rows) if (r.cos) for (const v of Object.values(r.cos)) expect(typeof v).toBe("number");
    expect(fx.rows.every((r) => !r.cos || Object.keys(r.cos).length <= 4)).toBe(true);
  });
});

describe("noise robustness of the speaker match", () => {
  const noise = JSON.parse(readFileSync(join(import.meta.dirname, "..", "research", "fixtures", "v2.noise.json"), "utf8"));
  const table = JSON.parse(readFileSync(join(root, "evaluation", "results", "attribution-noise.json"), "utf8")).table;
  it("measures the same held-out clips the v2 table scored, by hash", () => {
    const byId = new Map(fx.rows.map((r) => [r.id, r.sha256]));
    for (const [id, g] of Object.entries(noise.groups) as [string, { sha256: string }][]) if (!id.startsWith("syn-")) expect(byId.get(id)).toBe(g.sha256);
  });
  it("reproduces the published table from the kept cosines, with the 0.41 rule unmoved", () => {
    expect(scoreNoise(noise, rule.owner_min)).toEqual(table);
    expect(rule.owner_min).toBe(0.41);
  });
  it("keeps cosines only", () => {
    for (const r of Object.values(noise.results) as { cos: Record<string, number | null> }[]) for (const v of Object.values(r.cos)) expect(v === null || typeof v === "number").toBe(true);
  });
});
