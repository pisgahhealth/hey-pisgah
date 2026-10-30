import { payloadHash, type Memo, type MemoItem } from "./memo.js";
import type { NightSources } from "./sources.js";
import { checkMemo, verifyMemo, type CheckFailure, type Verdict } from "./verify.js";

// The delivery route, E4's bell and inbox; a memo payload or a task alert, each with a preview that names nobody.
export type MemoDelivery = { recipient_id: string; kind: "memo" | "task"; preview: string; payload_hash: string; body: unknown };
// A refused delivery is the door's answer and is recorded, never retried; a failed one could not reach the door.
export type DeliveryAnswer = { ok: boolean; ref: string | null; reason: string | null; refused?: boolean };
export type MemoTransport = { deliver(d: MemoDelivery): Promise<DeliveryAnswer> };
// One bounded repair of the statements that failed, given the precise reasons; it may drop or restate them, never add a fact.
export type MemoRepair = (m: Memo, failures: readonly CheckFailure[]) => Promise<Memo>;
export type PublishResult = {
  recipient_id: string; status: "delivered" | "withheld" | "refused" | "transport_failed"; verdict: Verdict; repairs: number;
  delivered: { kind: MemoDelivery["kind"]; ref: string | null; preview: string }[];
  // Each delivery the transport did not make, with its reason; a refusal is the door's own answer.
  not_sent: { kind: MemoDelivery["kind"]; refused: boolean; reason: string }[];
  // Statements the checks did not clear, kept for an authorised review view and marked unverified; they are never published.
  review: { memo_id: string; unverified: CheckFailure[] } | null; ms: number;
};
export type Publisher = { publish(m: Memo): Promise<PublishResult> };

const taskAlert = (m: Memo, items: readonly MemoItem[]) => ({ recipient_id: m.recipient_id, day: m.day, sources_hash: m.sources_hash, unfinished: items, urgent: items.filter((i) => i.state === "overdue" || i.state === "failed") });
const alertPreview = (n: number, u: number) => `Unfinished work: ${n} item${n === 1 ? "" : "s"} for you${u ? `, ${u} urgent` : ""}.`;

// The one path from the memo generator to the bell: check the exact payload against the records, repair once, then deliver, withhold or refuse.
export function memoPublisher(o: { sources: NightSources; transport: MemoTransport; repair?: MemoRepair; maxRepairs?: number; check?: typeof checkMemo; now?: () => Date }): Publisher {
  const check = o.check ?? checkMemo;
  const max = o.maxRepairs ?? 1;
  return {
    async publish(memo: Memo): Promise<PublishResult> {
      const t0 = Date.now();
      let m = memo;
      let verdict = verifyMemo(m, o.sources, check, o.now);
      let repairs = 0;
      while (verdict.status === "unsupported_or_incomplete" && o.repair && repairs < max) {
        repairs += 1;
        m = await o.repair(m, verdict.failures);
        verdict = verifyMemo(m, o.sources, check, o.now);
      }
      const notSent: PublishResult["not_sent"] = [];
      const send = async (d: MemoDelivery) => {
        const r = await o.transport.deliver(d);
        if (!r.ok) notSent.push({ kind: d.kind, refused: r.refused === true, reason: r.reason ?? "not delivered" });
        return r;
      };
      const done = (status: PublishResult["status"], delivered: PublishResult["delivered"], review: PublishResult["review"]): PublishResult => ({ recipient_id: memo.recipient_id, status, verdict, repairs, delivered, not_sent: notSent, review, ms: Date.now() - t0 });
      if (verdict.status === "verified") {
        // The verdict covers this payload only; a payload changed after the check is refused, never sent on an old verdict.
        if (payloadHash(m) !== verdict.payload_hash) return done("refused", [], null);
        // Urgent items go first as their own task alert, so they reach the bell at once rather than inside the memo.
        const sent: PublishResult["delivered"] = [];
        if (m.urgent.length) {
          const preview = `Urgent: ${m.urgent.length} item${m.urgent.length === 1 ? "" : "s"} for you.`;
          const u = await send({ recipient_id: m.recipient_id, kind: "task", preview, payload_hash: verdict.payload_hash, body: taskAlert(m, m.urgent) });
          if (u.ok) sent.push({ kind: "task", ref: u.ref, preview });
        }
        const r = await send({ recipient_id: m.recipient_id, kind: "memo", preview: m.preview, payload_hash: verdict.payload_hash, body: m });
        return done(r.ok ? "delivered" : r.refused ? "refused" : "transport_failed", r.ok ? [...sent, { kind: "memo", ref: r.ref, preview: m.preview }] : sent, null);
      }
      // The memo is withheld; open work the records back still reaches the recipient as a structured alert, checked on its own.
      const unverified = verdict.status === "unsupported_or_incomplete" ? verdict.failures : [];
      const alert: Memo = { ...m, facts: [], suspected_causes: [], proposed_changes: [], nothing_warrants_change: false, preview: alertPreview(m.unfinished.length, m.urgent.length) };
      const itemsOk = verdict.status !== "verifier_error" && m.unfinished.length > 0 && verifyMemo(alert, o.sources, check, o.now).status === "verified";
      if (!itemsOk) return done("withheld", [], { memo_id: m.memo_id, unverified });
      const body = taskAlert(m, m.unfinished);
      const r = await send({ recipient_id: m.recipient_id, kind: "task", preview: alert.preview, payload_hash: payloadHash(alert), body });
      return done("withheld", r.ok ? [{ kind: "task", ref: r.ref, preview: alert.preview }] : [], { memo_id: m.memo_id, unverified });
    }
  };
}

// Sends a memo on a verdict made earlier; it refuses unless the payload still hashes to what the verdict covered.
export async function sendOnVerdict(m: Memo, verdict: Verdict, transport: MemoTransport): Promise<{ ok: boolean; reason: string }> {
  if (verdict.status !== "verified") return { ok: false, reason: verdict.status };
  if (payloadHash(m) !== verdict.payload_hash) return { ok: false, reason: "payload_changed_after_verification" };
  const r = await transport.deliver({ recipient_id: m.recipient_id, kind: "memo", preview: m.preview, payload_hash: verdict.payload_hash, body: m });
  return { ok: r.ok, reason: r.reason ?? "delivered" };
}

// A transport that keeps deliveries in memory, for tests and for a run made before the delivery route exists.
export function heldTransport(): MemoTransport & { sent: MemoDelivery[] } {
  const sent: MemoDelivery[] = [];
  return { sent, async deliver(d) { sent.push(d); return { ok: true, ref: `held-${sent.length}`, reason: null }; } };
}
