import { appendFileSync, readFileSync } from "node:fs";
import { loadKeys } from "@hey-pisgah/model";
import { openStream } from "@hey-pisgah/store";
import { ASR_MODEL, USD_PER_AUDIO_HOUR, VITALS_KEYWORDS, buildKeywords, concat, decodeWav, resample } from "../src/index.js";
import { RealtimeSession, type RealtimeMode, type RealtimeRate } from "../src/realtime.js";
import { nodeSocket } from "../src/ws.js";

// Streams WAV files to the realtime endpoint at the pace they were spoken and keeps every server frame with its wall time, for docs/PROVIDERS.md.
const arg = (k: string, d = "") => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] ?? d : d; };
const files = arg("wav").split(",").filter(Boolean), mode = arg("mode", "ENDPOINTING") as RealtimeMode, out = arg("out"), label = arg("label", "probe");
const rate = Number(arg("rate", "24000")) as RealtimeRate, gapMs = Number(arg("gap", "2000")), frameMs = Number(arg("frame", "80"));
const pace = arg("pace", "live"), hints = arg("hints", "none"), bias = arg("bias", ""), raw = arg("raw", "");
const ledger = openStream(arg("store", ".hey-pisgah/g9/store"), `ledger/${arg("run", "run-g9wsprobe")}`, { writer: true });

const parts = files.flatMap((f, i) => { const w = decodeWav(new Uint8Array(readFileSync(f))); const x = w.sampleRate === rate ? w.samples : resample(w.samples, w.sampleRate, rate); return i ? [new Float32Array(Math.round((rate * gapMs) / 1000)), x] : [x]; });
const audio = concat([new Float32Array(Math.round(rate * 0.5)), ...parts, new Float32Array(Math.round(rate * 1.5))]);
const t0 = Date.now();
const log = (o: Record<string, unknown>) => appendFileSync(out, `${JSON.stringify({ label, wall_ms: Date.now() - t0, ...o })}\n`);
const keywords = hints === "vitals" ? buildKeywords({ vitals: VITALS_KEYWORDS, wards: [], documents: [], staff: [], beds: [] }) : [];
const key = loadKeys().MODEL_API_KEY ?? "";
let s: RealtimeSession;
try {
  if (raw) {
    // A deliberately wrong handshake, sent as given, to see how the endpoint refuses it.
    await new Promise<void>((resolve) => {
      const sock = nodeSocket(`wss://api.meta.ai/v1/asr/realtime?sessionId=g9-${label}`, {
        open: () => sock.sendText(raw.replace("KEY", key)), text: (t) => log({ frame: t.slice(0, 400) }), close: (code, reason) => { log({ close: code, reason }); resolve(); }, error: (e) => log({ error: e.message })
      });
      setTimeout(() => { sock.close(1000); resolve(); }, 12_000).unref();
    });
    process.exit(0);
  }
  s = await RealtimeSession.open({ key, rate, mode, keywords, languageBias: bias ? [bias] : [], sessionId: `g9-${label}-${Date.now().toString(36)}`, onEvent: (e) => log({ sent_ms: Math.round(s?.sentMs ?? 0), event: e }), onClose: (code, reason) => log({ close: code, reason }) });
} catch (e) {
  log({ open_failed: e instanceof Error ? e.message : String(e) });
  process.exit(1);
}
log({ ack: s.sessionId, mode, rate, keywords: keywords.length, bias });
const frame = Math.round((rate * frameMs) / 1000);
for (let i = 0; i < audio.length; i += frame) {
  s.send(audio.subarray(i, i + frame));
  if (pace === "live") { const due = t0 + ((i + frame) / rate) * 1000; const wait = due - Date.now(); if (wait > 0) await new Promise((r) => setTimeout(r, wait)); }
  if (s.closed) break;
}
log({ sent_all_ms: Math.round(s.sentMs) });
const c = await s.end();
log({ ended: c });
const cost = Math.round((Math.floor(s.sentMs / 1000) * 1000 / 3_600_000) * USD_PER_AUDIO_HOUR * 1e6) / 1e6;
ledger.append("reading.call", { provider: "meta", model: ASR_MODEL, purpose: "research_realtime_probe", latency_ms: Date.now() - t0, cost_usd: cost, task_id: null, line_id: label, error: c.code === 1000 ? null : `close ${c.code}` }, { recorded_at: 0, occurred_at: 0 });
ledger.close();
