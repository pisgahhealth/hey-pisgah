import { canonical, sha256 } from "@hey-pisgah/contracts";
import { payloadHash, type Memo, type MemoItem } from "./memo.js";
import { sourcesHash, type NightSources } from "./sources.js";
import { checkMemo, verifyMemo, type CheckFailure, type Verdict } from "./verify.js";

// The delivery routes: the memo to the bell and inbox, and each urgent item, or a withheld memo's open work, as a task alert on its own route; every preview names nobody.
export type MemoDelivery = { recipient_id: string; kind: "memo" | "task" | "urgent"; preview: string; payload_hash: string; body: unknown };
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
  // The sources read again right before publishing: whether they changed while the memo was written, and what was published against.
  refreshed: { changed: boolean; from: string; to: string; recomposed: boolean } | null;
};
export type Publisher = { publish(m: Memo): Promise<PublishResult> };

// A task alert's exact payload: the memo it came from and its items; the route recomputes this hash.
export const taskAlert = (m: Memo, items: readonly MemoItem[]) => ({ memo_id: m.memo_id, recipient_id: m.recipient_id, day: m.day, sources_hash: m.sources_hash, items: [...items] });
export const alertHash = (body: unknown): string => sha256(canonical(body));
const alertPreview = (n: number, u: number) => `Unfinished work: ${n} item${n === 1 ? "" : "s"} for you${u ? `, ${u} urgent` : ""}.`;
export const urgentPreview = (i: MemoItem): string => `Urgent: ${i.kind === "question" ? "a question" : i.kind === "obligation" ? "a held task" : "an action"} for you ${i.state === "failed" ? "was not done" : "is overdue"}.`;

// The one path from the memo generator to the bell: check the exact payload against the records, repair once, read the records again right before sending, then deliver, withhold or refuse.
export function memoPublisher(o: { sources: NightSources; transport: MemoTransport; repair?: MemoRepair; maxRepairs?: number; check?: typeof checkMemo; now?: () => Date; refresh?: () => Promise<NightSources> | NightSources; recompose?: (fresh: NightSources, m: Memo) => Memo }): Publisher {
  const check = o.check ?? checkMemo;
  const max = o.maxRepairs ?? 1;
  return {
    async publish(memo: Memo): Promise<PublishResult> {
      const t0 = Date.now();
      let m = memo;
      let src = o.sources;
      let verdict = verifyMemo(m, src, check, o.now);
      let repairs = 0;
      while (verdict.status === "unsupported_or_incomplete" && o.repair && repairs < max) {
        repairs += 1;
        m = await o.repair(m, verdict.failures);
        verdict = verifyMemo(m, src, check, o.now);
      }
      // Task wording can change and work can finish while the model writes, so the records are read again here and a verdict on older records is not used.
      let refreshed: PublishResult["refreshed"] = null;
      if (o.refresh && verdict.status === "verified") {
        let fresh: NightSources | null = null;
        try { fresh = await o.refresh(); } catch (e) { verdict = { status: "verifier_error", payload_hash: null, sources_hash: null, failures: [], error: `the records could not be read again: ${e instanceof Error ? e.message.slice(0, 200) : "refresh failed"}`, checked_at: (o.now ?? (() => new Date()))().toISOString() }; }
        if (fresh) {
          const to = sourcesHash(fresh);
          refreshed = { changed: to !== verdict.sources_hash, from: verdict.sources_hash ?? "", to, recomposed: false };
          if (refreshed.changed) {
            src = fresh;
            if (o.recompose) { m = o.recompose(fresh, m); refreshed.recomposed = true; }
            verdict = verifyMemo(m, src, check, o.now);
          }
        }
      }
      const notSent: PublishResult["not_sent"] = [];
      const send = async (d: MemoDelivery) => {
        const r = await o.transport.deliver(d);
        if (!r.ok) notSent.push({ kind: d.kind, refused: r.refused === true, reason: r.reason ?? "not delivered" });
        return r;
      };
      const done = (status: PublishResult["status"], delivered: PublishResult["delivered"], review: PublishResult["review"]): PublishResult => ({ recipient_id: memo.recipient_id, status, verdict, repairs, delivered, not_sent: notSent, review, ms: Date.now() - t0, refreshed });
      if (verdict.status === "verified") {
        // The verdict covers this payload only; a payload changed after the check is refused, never sent on an old verdict.
        if (payloadHash(m) !== verdict.payload_hash) return done("refused", [], null);
        // Each urgent item goes first as its own task alert on its own route, so it rings at once rather than inside the memo.
        const sent: PublishResult["delivered"] = [];
        for (const item of m.urgent) {
          const body = taskAlert(m, [item]);
          const preview = urgentPreview(item);
          const u = await send({ recipient_id: m.recipient_id, kind: "urgent", preview, payload_hash: alertHash(body), body });
          if (u.ok) sent.push({ kind: "urgent", ref: u.ref, preview });
        }
        const r = await send({ recipient_id: m.recipient_id, kind: "memo", preview: m.preview, payload_hash: verdict.payload_hash, body: m });
        return done(r.ok ? "delivered" : r.refused ? "refused" : "transport_failed", r.ok ? [...sent, { kind: "memo", ref: r.ref, preview: m.preview }] : sent, null);
      }
      // The memo is withheld; open work the records back still reaches the recipient as a structured alert, checked on its own.
      const unverified = verdict.status === "unsupported_or_incomplete" ? verdict.failures : [];
      const alert: Memo = { ...m, facts: [], suspected_causes: [], proposed_changes: [], nothing_warrants_change: false, preview: alertPreview(m.unfinished.length, m.urgent.length) };
      const itemsOk = verdict.status !== "verifier_error" && m.unfinished.length > 0 && verifyMemo(alert, src, check, o.now).status === "verified";
      if (!itemsOk) return done("withheld", [], { memo_id: m.memo_id, unverified });
      const body = taskAlert(m, m.unfinished);
      const r = await send({ recipient_id: m.recipient_id, kind: "task", preview: alert.preview, payload_hash: alertHash(body), body });
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
