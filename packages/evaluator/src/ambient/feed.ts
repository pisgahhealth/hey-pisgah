import { createHash } from "node:crypto";
import { concat, decodeWav, encodeWav, leadingSilenceMs, sliceMs, stripChunks, trailingSilenceMs, type AudioChunk } from "@hey-pisgah/voice";
import type { AmbientRun, RunChunk } from "./score.js";
import type { Timeline } from "./talk.js";

export type TalkChunk = AudioChunk & { wav: Uint8Array; key_ids: string[] };

// Cuts the rendered talk the way the strip does and tags each chunk with the utterances whose speech it holds.
export function talkChunks(wav: Uint8Array, timeline: Timeline): TalkChunk[] {
  const { samples, sampleRate } = decodeWav(wav);
  return stripChunks(samples, sampleRate).map((c) => ({
    ...c, wav: encodeWav(sliceMs(samples, sampleRate, c.start_ms, c.end_ms), sampleRate),
    key_ids: timeline.utterances.filter((u) => Math.min(u.end_ms, c.end_ms) - Math.max(u.start_ms, c.start_ms) > 0).map((u) => u.id)
  }));
}

// The audio serve will transcribe for each finished utterance: capped chunks joined with the next, as the listen endpoint does; used to build mock transcripts.
export function joinedAudio(chunks: readonly TalkChunk[], capMs = 6000, finalSilenceMs = 500): { sha256: string; key_ids: string[]; seqs: number[] }[] {
  const out: { sha256: string; key_ids: string[]; seqs: number[] }[] = [];
  let held: { samples: Float32Array[]; keys: string[]; seqs: number[]; trailing: number } | null = null;
  let rate = 16_000;
  const emit = (h: { samples: Float32Array[]; keys: string[]; seqs: number[] }) => {
    const bytes = encodeWav(concat(h.samples), rate);
    out.push({ sha256: createHash("sha256").update(bytes).digest("hex"), key_ids: [...new Set(h.keys)], seqs: h.seqs });
  };
  for (const c of chunks) {
    const { samples, sampleRate } = decodeWav(c.wav);
    rate = sampleRate;
    const ms = Math.round((samples.length / sampleRate) * 1000);
    const tail = trailingSilenceMs(samples, sampleRate);
    if (held && held.trailing + leadingSilenceMs(samples, sampleRate) >= finalSilenceMs) { emit(held); held = null; }
    const h: { samples: Float32Array[]; keys: string[]; seqs: number[]; trailing: number } = held ?? { samples: [], keys: [], seqs: [], trailing: 0 };
    h.samples.push(samples); h.keys.push(...c.key_ids); h.seqs.push(c.seq); h.trailing = tail;
    if (ms >= capMs - 50 && tail < finalSilenceMs) { held = h; continue; }
    held = null;
    emit(h);
  }
  return out;
}

type View = {
  task_id: string; admission_id: string; state: string; calls: number; usd: number;
  ears?: { sessions: { session_id: string; compared: number; agreed: number }[] };
  transcript: { id: string; text: string; decided: boolean; classes: string[]; ambient?: { session_id: string; seqs: number[]; ended_at: string; finished_by?: string } }[];
  actions: { action_id: string; line_id: string; kind: string; args: Record<string, unknown>; state: string; corrects_action_id: string | null; written_at: string | null }[];
  asked: { line_id: string; text: string }[]; refusals: { line_id: string; kind: string | null; asked_for: string }[];
};
type Outcome = { final: boolean; why: string; cost_usd: number; utterance?: { line_id: string; text: string } | null };
type Reply = { outcome?: Outcome; utterances?: { line_id: string; text: string }[]; error?: string };
export type FeedOptions = {
  serveUrl: string; owner: string; admissionId: string; sessionId: string; chunks: readonly TalkChunk[];
  pace: "real" | "fast"; mode: AmbientRun["mode"]; talkId: string; gateHash: string | null; settleMs?: number; log?: (s: string) => void;
};

// Plays the chunks into POST /tasks/listen, in real time or back to back, waits until every line is decided and every write has landed, and reads the run back from the task view.
export async function feedTalk(o: FeedOptions): Promise<AmbientRun> {
  const started = new Date();
  const t0 = Date.now();
  const sent: Promise<Outcome>[] = [];
  // Serve stores no words of a line nothing rests on, so the heard text comes from the listen answers.
  const heardText = new Map<string, string>();
  for (const c of o.chunks) {
    if (o.pace === "real") { const wait = t0 + c.end_ms - Date.now(); if (wait > 0) await new Promise((r) => setTimeout(r, wait)); }
    const f = new FormData();
    f.append("audio", new Blob([new Uint8Array(c.wav)], { type: "audio/wav" }), `c${c.seq}.wav`);
    f.append("owner", o.owner); f.append("admissionId", o.admissionId); f.append("session_id", o.sessionId); f.append("seq", String(c.seq));
    const p = fetch(`${o.serveUrl}/tasks/listen?wait=1`, { method: "POST", body: f }).then(async (r) => {
      const j = (await r.json()) as Reply;
      if (r.status >= 300 || !j.outcome) throw new Error(`listen seq ${c.seq} answered ${r.status} ${j.error ?? ""}`);
      for (const u of [...(j.utterances ?? []), ...(j.outcome.utterance ? [j.outcome.utterance] : [])]) heardText.set(u.line_id, u.text);
      o.log?.(`seq ${c.seq} ${c.cut} ${j.outcome.why}`);
      return j.outcome;
    });
    sent.push(p);
    if (o.pace === "fast") await p;
  }
  const outcomes = await Promise.all(sent);
  const end = Date.now() + (o.settleMs ?? 60_000);
  let mine: View[] = [];
  for (;;) {
    const views = (await (await fetch(`${o.serveUrl}/tasks?owner=${encodeURIComponent(o.owner)}`)).json()) as View[];
    mine = views.filter((v) => v.admission_id === o.admissionId && v.transcript.some((t) => t.ambient?.session_id === o.sessionId));
    const lines = mine.flatMap((v) => v.transcript.filter((t) => t.ambient?.session_id === o.sessionId));
    const open = mine.flatMap((v) => v.actions).some((a) => a.state === "proposed" || a.state === "sent" || a.state === "acknowledged");
    if ((lines.every((l) => l.decided) && !open) || Date.now() > end) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const keysBySeq = new Map(o.chunks.map((c) => [c.seq, c.key_ids]));
  const lines = mine.flatMap((v) => v.transcript.filter((t) => t.ambient?.session_id === o.sessionId)).map((t) => ({
    line_id: t.id, key_id: keysBySeq.get(t.ambient!.seqs.at(-1)!)?.[0] ?? null, text: t.text || heardText.get(t.id) || "", classes: t.classes, seqs: t.ambient!.seqs, ended_at: t.ambient!.ended_at, finished_by: t.ambient!.finished_by ?? null
  }));
  const ids = new Set(lines.map((l) => l.line_id));
  const chunks: RunChunk[] = o.chunks.map((c, i) => ({ seq: c.seq, key_ids: c.key_ids, final: outcomes[i]!.final, why: outcomes[i]!.why }));
  return {
    mode: o.mode, talk_id: o.talkId, gate_hash: o.gateHash, started_at: started.toISOString(), finished_at: new Date().toISOString(),
    lines, actions: mine.flatMap((v) => v.actions).filter((a) => ids.has(a.line_id)).map((a) => ({ action_id: a.action_id, line_id: a.line_id, kind: a.kind, args: a.args, state: a.state, corrects_action_id: a.corrects_action_id, written_at: a.written_at })),
    questions: mine.flatMap((v) => v.asked).filter((q) => ids.has(q.line_id)).map((q) => ({ line_id: q.line_id, text: q.text })),
    refusals: mine.flatMap((v) => v.refusals).filter((r) => ids.has(r.line_id)),
    ears: mine.flatMap((v) => v.ears?.sessions ?? []).filter((x) => x.session_id === o.sessionId).reduce((m, x) => ({ compared: m.compared + x.compared, agreed: m.agreed + x.agreed }), { compared: 0, agreed: 0 }),
    chunks, calls: mine.reduce((s, v) => s + v.calls, 0), cost_usd: mine.reduce((s, v) => s + v.usd, 0), asr_cost_usd: outcomes.reduce((s, x) => s + x.cost_usd, 0)
  };
}
