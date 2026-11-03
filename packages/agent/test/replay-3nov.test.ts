import { readFileSync, readdirSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { ModelClient, type ChatCompletion, type MockResponder } from "@hey-pisgah/model";
import { readStream } from "@hey-pisgah/store";
import { GATE_TOOL, MAX_CLAUSES, ORDER_REFERENCE_KINDS } from "../src/emr/gate.js";
import { EMERGENCY_KIND, IDENTITY_KIND, emergencyReason, unidentifiedRef } from "../src/emr/entry.js";
import type { EmrCommit, EmrContext, EmrTarget, Orderables, Provenance, WorkArgs } from "../src/emr/port.js";
import type { SpeakerVerdict, Voiceprint } from "../src/emr/speaker.js";
import type { SecondEar } from "../src/emr/ears.js";
import { EmrRuntime, type SayInput } from "../src/emr/runtime.js";
import { ClerkFake, DOC } from "./clerking-helpers.js";
import { emrRoot } from "./emr-helpers.js";

// Samuel's real lines from three live runs on 3 Nov, replayed offline through the engine with the gate's recorded answers and no key.
type Clause = Record<string, unknown> & { words: string | null; class: string; describes?: string };
type Line = {
  line: string; spoken_at: string; heard_at: string; source: "audio" | "text"; entry?: "emergency"; via?: "gate"; answers?: string;
  text: string | null; raw_text?: string | null; words: number; audio_ms?: number;
  ambient?: { session: string; seqs: number[]; turn_seqs?: number[]; ended_at: string; final_at: string; trailing_silence_ms: number; finished_by: string; released?: boolean };
  speaker?: { speaker: "owner" | "unverified" | "other_clinician"; reason?: string; label?: string };
  ears?: { unused?: true; agree?: boolean; measures?: { measure: string; first: string; second: string; agree: boolean }[] };
  gate?: { clauses: Clause[]; outside_line?: Clause[]; assumed?: string };
  live?: string[];
};
type Run = { run: string; lines: Line[]; earlier_arrival?: { note: string; lines: Line[] } };
const DIR = new URL("./fixtures/replay-3nov/", import.meta.url);
const load = (name: string): Run => JSON.parse(readFileSync(new URL(name, DIR), "utf8")) as Run;

const ARRIVALS = ["aaaaaaaa-0000-4000-8000-000000000001", "aaaaaaaa-0000-4000-8000-000000000002"];
const VISITS = ["bbbbbbbb-0000-4000-8000-000000000001", "bbbbbbbb-0000-4000-8000-000000000002"];
const TOKEN = (n: number) => `v1.${String(1_761_700_000_000 + n)}.${"A".repeat(43)}`;
// Each recorded verdict travels as a voiceprint the fake hospital matches back to it.
const VOICE: Record<string, number> = { owner: 5, other_clinician: 4, no_match: 1, mixed_speakers: 2 };
const print = (n: number): Voiceprint => ({ vector: [n], ms: 20, model: "nemo_en_titanet_small" });

// The A&E doctor's hospital: arrivals in the order opened, the tests and drugs the live run named, and the voice verdicts recorded.
class ReplayFake extends ClerkFake {
  private n = 0;
  private opened = 0;
  override kindsFor(): readonly string[] { return [...ORDER_REFERENCE_KINDS, EMERGENCY_KIND, IDENTITY_KIND, "record_triage_vitals", "request_admission", "record_diagnosis"]; }
  orderables(): Orderables {
    return { tests: { fbc: ["full blood count", "FBC"], malaria: ["malaria parasite", "malaria"], urinalysis: ["urinalysis"] }, drugs: { paracetamol_iv: { words: ["IV paracetamol", "paracetamol"], controlled: false }, paracetamol_oral: { words: ["paracetamol"], controlled: false } } };
  }
  readonly speaker = async (_o: string, v: readonly number[], _p: Provenance): Promise<SpeakerVerdict> => {
    this.n += 1;
    if (v[0] === 5) return { speaker: "owner", token: TOKEN(this.n) };
    if (v[0] === 4) return { speaker: "other_clinician", label: "Dr B", role: "doctor" } as SpeakerVerdict;
    return { speaker: "unverified", reason: v[0] === 2 ? "mixed_speakers" : "no_match" };
  };
  override async resolve(target: EmrTarget): Promise<EmrContext> {
    const i = ARRIVALS.indexOf(String(target.patient_id));
    if (i >= 0) return { admission_id: "", patient_id: ARRIVALS[i]!, visit_id: VISITS[i]!, label: `Unknown arrival ${i}`, facts: { ward: null, bed: null, sex: "female" }, keywords: [] };
    return super.resolve(target);
  }
  override async commit(kind: string, args: WorkArgs, key: string, prov: Provenance): Promise<EmrCommit> {
    if (kind !== EMERGENCY_KIND) return super.commit(kind, args, key, prov);
    const hit = this.writes.find((w) => w.key === key);
    const id = hit?.id ?? ARRIVALS[this.opened++]!;
    if (!hit) this.writes.push({ kind, args, key, prov, id });
    const i = ARRIVALS.indexOf(id);
    return { ok: true, record_id: id, record_version: 1, event_ids: [`patient:${id}`, `visit:${VISITS[i]}`], replayed: !!hit };
  }
}

const toks = (t: string) => t.toLowerCase().replace(/[^a-z0-9.]+/g, " ").split(" ").filter(Boolean);
// The share of a clause's words found in the part said, each word counted once.
function share(words: string, said: string): number {
  const have = toks(said);
  const w = toks(words);
  let hit = 0;
  for (const t of w) { const i = have.indexOf(t); if (i >= 0) { hit += 1; have.splice(i, 1); } }
  return w.length ? hit / w.length : 0;
}
const position = (c: Clause, said: string) => (c.words ? said.indexOf(c.words) : -1);
// The gate's recorded answer for the words said: the clauses it gave for this line, plus those it gave for these words on a later call when the engine accepts that many.
function recordedAnswer(lines: readonly Line[], said: string): Clause[] | null {
  const all = lines.flatMap((l) => [...(l.gate?.clauses ?? []).map((c) => ({ ...c, describes: l.line })), ...(l.gate?.outside_line ?? []).filter((c) => c.describes)]).filter((c) => c.words);
  const whole = lines.find((l) => l.text === said && l.gate);
  if (whole) {
    const own = whole.gate!.clauses.filter((c) => c.words);
    const later = all.filter((c) => c.describes === whole.line && !own.includes(c) && !whole.gate!.clauses.some((x) => x.words === c.words && x.class === c.class));
    const both = [...own, ...later];
    const pick = both.length <= MAX_CLAUSES ? both : own;
    return pick.length ? [...pick].sort((a, b) => position(a, said) - position(b, said)) : [{ words: said, class: "aside" }];
  }
  // A part of a recorded line, as an engine that splits a long line sends, gets the recorded clauses whose words lie in it.
  const parent = lines.find((l) => l.text && l.text.includes(said));
  if (!parent) return null;
  const inside = all.filter((c) => c.describes === parent.line && share(String(c.words), said) >= 0.5).slice(0, MAX_CLAUSES);
  return inside.length ? inside : [{ words: said, class: "aside" }];
}

// Answers every gate call from the fixture; any other tool, or words the fixture never heard, fails the call so nothing is invented.
function replayModel(lines: readonly Line[], seen: string[]): MockResponder {
  return ({ body, hash }) => {
    const name = (body["tools"] as { function: { name: string } }[] | undefined)?.[0]?.function.name;
    const user = String((body["messages"] as { role: string; content: string }[]).find((m) => m.role === "user")?.content ?? "");
    const said = JSON.parse(/clinician_said: (".*")$/m.exec(user)?.[1] ?? '""') as string;
    seen.push(`${name}:${said}`);
    if (name !== GATE_TOOL) throw new Error(`the replay holds no recorded answer for the ${String(name)} tool`);
    const clauses = recordedAnswer(lines, said);
    if (!clauses) throw new Error(`the replay holds no recorded gate answer for: ${said.slice(0, 80)}`);
    const args = { clauses: clauses.map(({ describes: _d, ...c }) => c) };
    const c: ChatCompletion = {
      id: `replay-${hash.slice(0, 12)}`, object: "chat.completion", created: 0, model: String(body["model"]),
      choices: [{ index: 0, finish_reason: "tool_calls", logprobs: null, message: { role: "assistant", content: null, refusal: null, tool_calls: [{ id: "call_1", type: "function", function: { name: GATE_TOOL, arguments: JSON.stringify(args) } }] } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    };
    return c;
  };
}

// The second ear reads back the recorded second reading: the line with each measure's second value in place of the first.
function secondEar(lines: readonly Line[]): SecondEar {
  return async (wav) => {
    const l = lines.find((x) => x.line === new TextDecoder().decode(wav));
    let text = l?.text ?? "";
    for (const m of l?.ears?.measures ?? []) if (!m.agree) text = text.replace(m.first.replace("/", " over "), m.second).replace(m.first, m.second);
    return { text, provider: "local", model: "local:replay", response_id: null, cost_usd: 0, fallback_reason: null };
  };
}

type Replay = { rt: EmrRuntime; port: ReplayFake; root: string; task: string; earlier: string | null; seen: string[]; ids: Map<string, string> };
async function replay(run: Run): Promise<Replay> {
  const root = emrRoot();
  const port = new ReplayFake();
  const clock = { now: Date.parse(run.lines[0]!.heard_at) };
  const seen: string[] = [];
  const every = [...(run.earlier_arrival?.lines ?? []), ...run.lines];
  let rt: EmrRuntime | null = null;
  const client = new ModelClient({ storeRoot: root, mode: "mock", mock: replayModel(every, seen), taskStateOf: (id) => rt?.stateOf(id) ?? null });
  rt = new EmrRuntime({ storeRoot: root, client, port, holdMs: 0, proofRetryMs: 1, obligationTickMs: 20, secondEar: secondEar(every), wallNow: () => new Date(clock.now) });
  rt.start();
  const ids = new Map<string, string>();
  const drive = async (lines: readonly Line[]): Promise<string> => {
    let task = "";
    for (const l of lines) {
      clock.now = Date.parse(l.heard_at);
      if (l.entry) {
        const e = await rt!.emergency(DOC, { text: l.text!, spoken_at: l.spoken_at, source: "audio", args: { unidentified_ref: unidentifiedRef(new Date(l.spoken_at)), reason: emergencyReason(l.text!) } });
        task = e.task_id; ids.set(l.line, e.line_id);
        await rt!.settled();
        continue;
      }
      // A line the live run dropped as an aside kept no words, so it cannot be said again.
      if (l.text === null) continue;
      const v = rt!.view(task)!;
      const q = l.answers ? v.asked.filter((x) => x.line_id === ids.get(l.answers!)).at(-1)?.question_id : undefined;
      const s: SayInput = {
        owner: DOC, target: { patient_id: v.patient_id! }, text: l.text, source: l.source, spoken_at: l.spoken_at,
        ...(l.via ? { via: l.via } : {}), ...(q ? { question_id: q } : {}),
        ...(l.ambient ? { ambient: { session_id: l.ambient.session, seqs: l.ambient.seqs, raw_text: l.raw_text ?? l.text, ended_at: l.ambient.ended_at, final_at: l.ambient.final_at, trailing_silence_ms: l.ambient.trailing_silence_ms, finished_by: l.ambient.finished_by, captured: true, ...(l.ambient.turn_seqs ? { turn_seqs: l.ambient.turn_seqs } : {}), ...(l.ambient.released ? { released: true } : {}) } } : {}),
        ...(l.audio_ms && l.ambient ? { audio: { audio_ms: l.audio_ms, cost_usd: 0, session_id: l.ambient.session } } : {}),
        ...(l.speaker ? { voiceprint: print(VOICE[l.speaker.speaker === "unverified" ? l.speaker.reason ?? "no_match" : l.speaker.speaker]!) } : { unverified_reason: "not_matched_in_the_live_run" }),
        ...(l.ears && l.ambient ? { clip: new TextEncoder().encode(l.line) } : {})
      };
      const r = await rt!.say(s, task);
      ids.set(l.line, r.line_id);
      await rt!.settled();
    }
    return task;
  };
  const earlier = run.earlier_arrival ? await drive(run.earlier_arrival.lines) : null;
  const task = await drive(run.lines);
  await rt.settled();
  return { rt, port, root, task, earlier, seen, ids };
}

const writes = (r: Replay, kind: string, visit = VISITS[r.earlier ? 1 : 0]) => r.port.writes.filter((w) => w.kind === kind && (kind === EMERGENCY_KIND || w.args["visit_id"] === visit || w.args["patient_id"] === ARRIVALS[VISITS.indexOf(visit!)]));
const note = (r: Replay): Record<string, string> => (writes(r, "record_clerking").at(-1)?.args["note"] as Record<string, string> | undefined) ?? {};
const stream = (r: Replay) => readStream(r.root, `emr/${r.task}`);

describe("the 14:36 run (Amaka Okafor), replayed", () => {
  const run = load("arrival-1436.json");
  let r: Replay;
  beforeAll(async () => {
    r = await replay(run);
    if (process.env["DBG"]) console.log(JSON.stringify({ writes: r.port.writes.map((w) => ({ kind: w.kind, args: w.args })), asked: r.rt.view(r.task)!.asked.map((q) => q.text), notes: r.rt.view(r.task)!.notes.map((n) => n.text), seen: r.seen }, null, 1));
  }, 60_000);

  // What works today, held so it cannot regress.
  it("opens one arrival from the first line and names the line on its record", () => {
    const opened = writes(r, EMERGENCY_KIND);
    expect(opened).toHaveLength(2);
    expect(opened[1]!.args["reason"]).toBe("Emergency arrival: Um so I've got a new arrival, arrival");
    expect(opened[1]!.prov.evidence).toBe(`transcript:${r.ids.get("L1")}`);
  });

  it("opens the consultation and records the presenting complaint from the 13:36:51 line", () => {
    expect(writes(r, "open_consult")).toHaveLength(1);
    const pc = writes(r, "record_clerking").find((w) => w.args["section"] === "presenting_complaint");
    expect(String(pc?.args["text"])).toMatch(/high fever and a bit of confusion/);
  });

  it("writes nothing from 3 Nov onto the finished 2 Nov arrival", () => {
    const old = r.port.writes.filter((w) => w.kind !== EMERGENCY_KIND && (w.args["visit_id"] === VISITS[0] || w.args["patient_id"] === ARRIVALS[0]));
    expect(old.every((w) => w.kind === IDENTITY_KIND || w.kind === "open_consult")).toBe(true);
    expect(old.filter((w) => w.kind === IDENTITY_KIND).map((w) => w.args["name"])).toEqual(["Amaka Okafor"]);
  });

  it("calls no model but the gate, and only for words the fixture holds", () => {
    expect(r.seen.length).toBeGreaterThan(0);
    expect(r.seen.every((s) => s.startsWith(`${GATE_TOOL}:`))).toBe(true);
    expect(stream(r).filter((e) => e.record_type === "intent.failed")).toEqual([]);
  });

  // What Samuel wants at the end of this run; each it.fails is red on the engine today and turns green when the lane that owns it lands.
  it("writes the name Amaka Okafor on the new arrival with no for-whom question", () => {
    expect(writes(r, IDENTITY_KIND).map((w) => w.args["name"])).toEqual(["Amaka Okafor"]);
    expect(r.rt.view(r.task)!.asked.filter((q) => /^For /.test(q.text))).toEqual([]);
  });

  it("puts pulse 110 and blood pressure 90/60 on the triage row, with the other vitals said", () => {
    const tri = writes(r, "record_triage_vitals");
    expect(tri.length).toBeGreaterThan(0);
    const got = Object.assign({}, ...tri.map((w) => w.args));
    expect(got).toMatchObject({ pulse: 110, bp: "90/60", spo2: 94, resp_rate: 24 });
    expect(Number(got["temp_c"])).toBe(38.5);
  });

  it.fails("records the penicillin allergy", () => {
    expect(writes(r, "record_allergy").map((w) => String(w.args["substance"]).toLowerCase())).toEqual(["penicillin"]);
  });

  it.fails("records the examination in clinician wording", () => {
    const exam = note(r)["examination"] ?? "";
    for (const f of [/pale/i, /febrile/i, /drowsy/i, /neck (is )?(also )?not stiff|no neck stiffness/i]) expect(exam).toMatch(f);
    expect(exam).not.toMatch(/open your eyes|for me please|\bum\b/i);
  });

  it("records severe malaria as the working diagnosis and nothing else in the assessment", () => {
    const a = note(r)["assessment"] ?? "";
    expect(a).toMatch(/severe malaria/i);
    expect(a).not.toMatch(/penicillin|paracetamol|fever for three days|lab|nurse/i);
  });

  it.fails("sends FBC, malaria parasite and urinalysis", () => {
    expect(writes(r, "order_test").map((w) => w.args["test"]).sort()).toEqual(["fbc", "malaria", "urinalysis"]);
  });

  it.fails("prescribes paracetamol IV 1 g once", () => {
    const rx = writes(r, "prescribe");
    expect(rx).toHaveLength(1);
    expect(rx[0]!.args).toMatchObject({ drug: "paracetamol_iv", dose: "1 g" });
  });

  it.fails("keeps orders, drugs and chatter out of every note section (D46)", () => {
    const n = note(r);
    expect(n["presenting_complaint"] && n["examination"] && n["assessment"]).toBeTruthy();
    const all = Object.values(n).join(" | ");
    expect(all).not.toMatch(/paracetamol|full blood count|urinalysis|don't worry|open your eyes|nurse please/i);
  });

  it("never stalls: no line is held for whom and every line after the arrival is decided", () => {
    const recs = stream(r);
    expect(recs.filter((e) => e.record_type === "line.handled" && (e.payload as { as: string }).as === "held_for_whom")).toEqual([]);
    const decided = new Set(recs.filter((e) => e.record_type === "gate.decided" || e.record_type === "line.ruled").map((e) => (e.payload as { line_id: string }).line_id));
    const said = run.lines.filter((l) => l.text !== null && !l.entry).map((l) => r.ids.get(l.line)!);
    expect(said.filter((id) => !decided.has(id))).toEqual([]);
  });
});

describe("the 07:37 run, replayed", () => {
  const run = load("arrival-0737.json");
  let r: Replay;
  beforeAll(async () => { r = await replay(run); }, 60_000);

  it("records the history and presenting complaint and puts pulse 110 on the triage row when both ears agree", () => {
    expect(writes(r, "record_clerking").map((w) => w.args["section"])).toEqual(expect.arrayContaining(["history", "presenting_complaint", "examination"]));
    expect(writes(r, "record_triage_vitals").some((w) => w.args["pulse"] === 110)).toBe(true);
  });

  it("asks which respiratory rate when the second ear heard 204 for 24", () => {
    expect(r.rt.view(r.task)!.asked.some((q) => /Respiratory rate: one reading heard 24, the other 204/.test(q.text))).toBe(true);
  });

  it("sends FBC, malaria parasite and urinalysis from the owner's examination line", () => {
    expect(writes(r, "order_test").map((w) => w.args["test"]).sort()).toEqual(["fbc", "malaria", "urinalysis"]);
  });

  it("holds the admission said in an unmatched voice for the owner's own yes", () => {
    expect(writes(r, "admit_patient")).toEqual([]);
    expect(writes(r, "request_admission")).toEqual([]);
    expect(r.rt.view(r.task)!.asked.some((q) => /I could not match the voice to you/.test(q.text))).toBe(true);
  });
});

describe("the 11:58 run, replayed", () => {
  const run = load("arrival-1158.json");
  let r: Replay;
  beforeAll(async () => { r = await replay(run); }, 60_000);

  it("writes each history and complaint line in the order said, with nothing held", () => {
    const sections = writes(r, "record_clerking").map((w) => w.args["section"]);
    expect(sections).toEqual(["history", "history", "presenting_complaint", "history", "history"]);
    expect(r.rt.view(r.task)!.asked).toEqual([]);
  });
});

describe("the replay fixtures", () => {
  it("hold no hospital id, owner id, voiceprint or key", () => {
    for (const f of readdirSync(DIR).filter((n) => n.endsWith(".json"))) {
      const text = readFileSync(new URL(f, DIR), "utf8");
      expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
      expect(text).not.toMatch(/"(vector|voiceprint|owner|patient_id|visit_id|clinic_id|token)":/);
      expect(text).not.toMatch(/authorization|bearer /i);
    }
  });

  it("answer a whole recorded line with its live clauses and a part of a line with the clauses inside it", () => {
    const lines = load("arrival-1436.json").lines;
    const long = lines.find((l) => l.line === "L8")!;
    expect(recordedAnswer(lines, long.text!)!.map((c) => c.class)).toEqual(long.gate!.clauses.map((c) => c.class));
    expect(recordedAnswer(lines, "the lab needs to do a full blood count test the malaria parasite test and urinalysis")!.map((c) => c["test"])).toEqual(["fbc", "malaria", "urinalysis"]);
    expect(recordedAnswer(lines, "never said")).toBeNull();
  });
});
