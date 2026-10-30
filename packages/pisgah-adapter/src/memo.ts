import type { PisgahPort } from "./port.js";

// The publisher's delivery shape, kept structural so this package needs no import from the memo generator.
export type MemoDeliveryLike = { recipient_id: string; kind: "memo" | "task" | "urgent"; preview: string; payload_hash: string; body: unknown };
export type DoorDeliveryAnswer = { ok: boolean; ref: string | null; reason: string | null; refused?: boolean };
export type DoorDeliveryLog = { recipient_id: string; kind: MemoDeliveryLike["kind"]; status: number | null; outcome: "delivered" | "refused" | "failed" | "not_sent"; reason: string | null; ms: number };

// Posts each checked memo to the door under the profile's sender, recording a refusal as the door's answer and never retrying it.
export function doorMemoTransport(port: PisgahPort, o: { run_id: string; now?: () => Date }): { deliver(d: MemoDeliveryLike): Promise<DoorDeliveryAnswer>; log: DoorDeliveryLog[] } {
  const spec = port.profile.memos;
  if (!spec) throw new Error("the door profile names no memo route");
  const log: DoorDeliveryLog[] = [];
  const now = o.now ?? (() => new Date());
  return {
    log,
    async deliver(d) {
      const t0 = Date.now();
      const note = (status: number | null, outcome: DoorDeliveryLog["outcome"], reason: string | null) => log.push({ recipient_id: d.recipient_id, kind: d.kind, status, outcome, reason, ms: Date.now() - t0 });
      // A task alert needs the profile's alert route; without one it is not sent and its items reach the bell inside the memo.
      if (d.kind !== "memo" && !spec.alerts_path) { note(null, "not_sent", "the profile names no alert route; the items travel inside the memo"); return { ok: false, ref: null, reason: "no door route for a task alert", refused: false }; }
      const memoId = String((d.body as { memo_id?: unknown } | null)?.memo_id ?? "memo").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
      const prov = { owner: spec.sender, evidence: `nightly:${o.run_id}/${memoId}`.slice(0, 200), spoken_at: now().toISOString() };
      const r = d.kind === "memo"
        ? await port.request("POST", spec.path, prov, { idempotencyKey: `memo-${memoId}-${d.payload_hash.slice(0, 16)}`, body: { recipientId: d.recipient_id, kind: "memo", preview: d.preview, payloadHash: d.payload_hash, memo: d.body } })
        : await port.request("POST", spec.alerts_path!, prov, { idempotencyKey: `${d.kind}-${memoId}-${d.payload_hash.slice(0, 16)}`, body: { recipientId: d.recipient_id, kind: d.kind, preview: d.preview, payloadHash: d.payload_hash, alert: d.body } });
      if (r.kind === "refused") { note(null, "failed", `port_${r.reason}`); return { ok: false, ref: null, reason: `port_${r.reason}`, refused: false }; }
      if (r.kind === "network_error") { note(null, "failed", r.reason); return { ok: false, ref: null, reason: r.reason, refused: false }; }
      const j = (r.json ?? {}) as { id?: unknown; status?: unknown; error?: { code?: unknown; message?: unknown } };
      if (r.status >= 200 && r.status < 300) { const ref = typeof j.id === "string" ? j.id : memoId; note(r.status, "delivered", typeof j.status === "string" ? j.status : null); return { ok: true, ref, reason: null }; }
      const reason = `${r.status} ${String(j.error?.code ?? "error")}: ${String(j.error?.message ?? "no message").slice(0, 200)}`;
      // A 4xx is the hospital's decision about this memo, so it is recorded as a refusal; only a 5xx counts as a failed delivery.
      if (r.status < 500) { note(r.status, "refused", reason); return { ok: false, ref: null, reason, refused: true }; }
      note(r.status, "failed", reason);
      return { ok: false, ref: null, reason, refused: false };
    }
  };
}
