import { sherpaEmbedder, voiceprintAt, withDoorAudio, type Embedder, type SpeakerInput, type Voiceprint } from "@hey-pisgah/agent";
import { loadProfile } from "../src/profile.js";
import type { DoorLog } from "../src/port.js";
import { personCaller } from "../src/journey.sandbox.js";
import { SandboxBlock, sandboxQuery } from "../src/sandbox.js";

// A fresh synthetic arrival, registered and paid by the desk person, so no other run's patient is touched.
export async function freshArrival(profile = loadProfile(), label = "E2 Child"): Promise<{ patient: string; visit: string; sb: SandboxBlock; person: ReturnType<typeof personCaller>; log: DoorLog[] }> {
  const sb = SandboxBlock.parse(profile.sandbox);
  const log: DoorLog[] = [];
  const call = personCaller(profile, sb, new Map(), log);
  // A keep-alive socket the app already closed resets once; the person step is tried again on a fresh one.
  const person: typeof call = async (op, vars) => { try { return await call(op, vars); } catch { return call(op, vars); } };
  const tag = Date.now().toString(36);
  const reg = await person("register", { name: `${sb.scrub[0] ?? ""}${label} ${tag}`, phone: `0803${String(Date.now()).slice(-7)}` });
  if (!reg.ok) throw new Error(`register failed: ${reg.status} ${reg.note ?? ""}`);
  const patient = String((reg.json as { id: string }).id);
  const visit = String(sandboxQuery(sb, "visit_for_patient", { patient })[0]?.["id"] ?? "");
  if (!visit) throw new Error("the arrival has no visit");
  const paid = await person("mark_paid", { visit_id: visit });
  if (!paid.ok) throw new Error(`mark paid failed: ${paid.status} ${paid.note ?? ""}`);
  return { patient, visit, sb, person, log };
}


// The local speaker model for a sandbox run; with HEY_PISGAH_VOICEPRINT=door every print also carries the line's audio for the hospital.
export function sandboxEmbedder(): Embedder | null {
  const local = sherpaEmbedder({ modelPath: process.env["HEY_PISGAH_SPEAKER_MODEL"] ?? "", sherpaDir: process.env["HEY_PISGAH_SHERPA_DIR"] });
  return local && voiceprintAt(process.env["HEY_PISGAH_VOICEPRINT"]) === "door" ? withDoorAudio(local) : local;
}

// What the hospital's match is sent for one print: its audio when the print carries it, else the vector.
export const voiceOf = (p: Voiceprint): SpeakerInput => (p.segments?.every((w) => w.audio) ? { pcm16k: p.segments.map((w) => w.audio!) } : p.audio ? { pcm16k: [p.audio] } : p.vector);

// With the voiceprint at the hospital, one owner's audio may not outrun the clock, so a scripted run waits until each print could have been spoken live.
const paced = { start: 0, spoken: 0 };
export async function paceAudio(p: Voiceprint): Promise<void> {
  const windows = p.segments?.every((w) => w.audio) ? p.segments.map((w) => w.audio!) : p.audio ? [p.audio] : [];
  if (!windows.length) return;
  if (!paced.start) paced.start = Date.now();
  paced.spoken += windows.reduce((n, w) => n + w.byteLength, 0) / 32;
  const wait = paced.spoken - (Date.now() - paced.start);
  if (wait > 0) await new Promise((res) => setTimeout(res, wait));
}
