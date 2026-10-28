import { describe, expect, it } from "vitest";
import { canonical, hashJson, NotCanonicalisable } from "./canonical.js";
import { checkTwoClock, determinismView, sealEnvelope, verifyChain, type Envelope, type UnsealedEnvelope } from "./envelope.js";

const base = (seq: number, prev: string): UnsealedEnvelope => ({
  seq, stream_id: "tasks/t-abcdefgh", recorded_at: 100, occurred_at: 90, wall_at: "2026-10-28T01:00:00.000Z",
  record_type: "task.opened", schema_version: 0, payload: { a: 1 }, prev_hash: prev
});

describe("canonical", () => {
  it("sorts keys and ignores insertion order", () => {
    expect(canonical({ b: 1, a: [true, null] })).toBe('{"a":[true,null],"b":1}');
    expect(hashJson({ b: 1, a: 2 })).toBe(hashJson({ a: 2, b: 1 }));
  });
  it("refuses undefined, NaN and non-plain objects instead of hashing them silently", () => {
    expect(() => canonical({ a: undefined })).toThrow(NotCanonicalisable);
    expect(() => canonical({ a: Number.NaN })).toThrow(NotCanonicalisable);
    expect(() => canonical({ a: new Date(0) })).toThrow(NotCanonicalisable);
  });
  it("survives a JSON round trip", () => {
    const e = sealEnvelope(base(1, ""));
    const back = JSON.parse(JSON.stringify(e)) as Envelope;
    expect(verifyChain([back])).toEqual({ ok: true });
  });
});

describe("envelope chain", () => {
  const e1 = sealEnvelope(base(1, ""));
  const e2 = sealEnvelope(base(2, e1.hash));
  it("verifies an intact chain", () => {
    expect(verifyChain([e1, e2])).toEqual({ ok: true });
  });
  it("detects an edited clock", () => {
    expect(verifyChain([{ ...e1, recorded_at: 500 }, e2])).toMatchObject({ ok: false, reason: "hash_mismatch" });
  });
  it("detects a missing record", () => {
    expect(verifyChain([e2])).toMatchObject({ ok: false, reason: "seq_gap" });
  });
  it("determinism view drops wall time and chain fields", () => {
    const v = determinismView(e1);
    expect(Object.keys(v)).not.toContain("wall_at");
    expect(Object.keys(v)).not.toContain("hash");
    expect(hashJson(determinismView(sealEnvelope({ ...base(1, ""), wall_at: "2027-01-01T00:00:00.000Z" })))).toBe(hashJson(v));
  });
});

describe("two clocks", () => {
  it("server-clock events must carry equal clocks", () => {
    expect(checkTwoClock({ clock: "server", occurred_at: 100, recorded_at: 100 })).toEqual({ ok: true });
    expect(checkTwoClock({ clock: "server", occurred_at: 100, recorded_at: 101 })).toMatchObject({ reason: "server_clocks_differ" });
  });
  it("accepts an entry inside the 15 minute grace with or without a reason", () => {
    expect(checkTwoClock({ clock: "two_clock", occurred_at: 100, recorded_at: 110 })).toEqual({ ok: true });
    expect(checkTwoClock({ clock: "two_clock", occurred_at: 100, recorded_at: 110, late_entry_reason: "busy" })).toEqual({ ok: true });
  });
  it("needs a reason past the grace", () => {
    expect(checkTwoClock({ clock: "two_clock", occurred_at: 100, recorded_at: 130 })).toMatchObject({ reason: "late_without_reason" });
    expect(checkTwoClock({ clock: "two_clock", occurred_at: 100, recorded_at: 130, late_entry_reason: "emergency on the ward" })).toEqual({ ok: true });
  });
  it("rejects more than 24 hours back and more than 5 minutes of future skew", () => {
    expect(checkTwoClock({ clock: "two_clock", occurred_at: 0, recorded_at: 1441, late_entry_reason: "x" })).toMatchObject({ reason: "too_far_back" });
    expect(checkTwoClock({ clock: "two_clock", occurred_at: 100, recorded_at: 94 })).toMatchObject({ reason: "future_skew" });
  });
});
