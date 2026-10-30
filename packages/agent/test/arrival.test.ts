import { describe, expect, it } from "vitest";
import { ModelClient, type ChatCompletion, type MockResponder } from "@hey-pisgah/model";
import { encodeWav } from "@hey-pisgah/voice";
import { startEmrServe } from "../src/emr/serve.js";
import { EMERGENCY_KIND } from "../src/emr/entry.js";
import { ARRIVAL_PROMPT, arrivalTool, denyHits } from "../src/emr/gate.js";
import type { EmrCommit, EmrContext, EmrPort, EmrProof, EmrTarget, Provenance, WorkArgs } from "../src/emr/port.js";
import { OWNER, emrRoot, until } from "./emr-helpers.js";

const ARRIVAL = "aaaaaaaa-1111-4222-8333-444444444444";
const VISIT = "bbbbbbbb-1111-4222-8333-444444444444";

// A hospital that opens one unnamed arrival, slowly when asked to, as the busy door does.
class ArrivalEmr implements EmrPort {
  readonly writeKinds = [EMERGENCY_KIND] as const;
  readonly writes: { args: WorkArgs; key: string; prov: Provenance }[] = [];
  gate: Promise<void> | null = null;
  kindsFor(): readonly string[] { return [EMERGENCY_KIND, "record_triage_vitals"]; }
  refusedCount() { return 0; }
  async resolve(_t: EmrTarget): Promise<EmrContext> { return { admission_id: "", patient_id: ARRIVAL, visit_id: VISIT, label: "Unknown arrival 10:00", facts: {}, keywords: [] }; }
  async commit(_k: string, args: WorkArgs, key: string, prov: Provenance): Promise<EmrCommit> {
    if (this.gate) await this.gate;
    if (!this.writes.some((w) => w.key === key)) this.writes.push({ args, key, prov });
    return { ok: true, record_id: ARRIVAL, record_version: 1, event_ids: [`patient:${ARRIVAL}`, `visit:${VISIT}`], replayed: false };
  }
  async prove(_k: string, _a: WorkArgs, w: { record_id: string; record_version: number; event_ids: string[] }): Promise<EmrProof> {
    return { ...w, record_hash: "0".repeat(64), verified_at: new Date().toISOString(), read: "board row" };
  }
}

// The arrival gate answered from a script keyed by the words; any other gate call hears an aside.
function mock(arrives: (said: string, recent: string[]) => boolean, seen: string[]): MockResponder {
  return ({ body, hash }) => {
    const tools = body["tools"] as { function: { name: string } }[];
    const user = String((body["messages"] as { role: string; content: string }[]).find((m) => m.role === "user")?.content ?? "");
    const said = JSON.parse(/clinician_said: (".*")$/m.exec(user)?.[1] ?? '""') as string;
    const recent = [...user.matchAll(/^- (".*")$/gm)].map((m) => JSON.parse(m[1]!) as string);
    const name = tools[0]!.function.name;
    if (name === "arrival") seen.push(said);
    const args = name === "arrival" ? { clauses: [{ words: said, class: arrives(said, recent) ? "arrival" : "aside", confidence: 0.9 }] } : { clauses: [{ words: said, class: "aside" }] };
    const c: ChatCompletion = { id: `mock-${hash.slice(0, 12)}`, object: "chat.completion", created: 0, model: String(body["model"]), choices: [{ index: 0, finish_reason: "tool_calls", logprobs: null, message: { role: "assistant", content: null, refusal: null, tool_calls: [{ id: "c1", type: "function", function: { name, arguments: JSON.stringify(args) } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
    return c;
  };
}

const chunk = () => encodeWav(new Float32Array(16000).map((_, i) => Math.sin(i / 3) * 0.3), 16000);
async function boot(heard: string[], arrives: (said: string, recent: string[]) => boolean) {
  const root = emrRoot();
  const port = new ArrivalEmr();
  const seen: string[] = [];
  const client = new ModelClient({ storeRoot: root, mode: "mock", mock: mock(arrives, seen) });
  const s = await startEmrServe({ storeRoot: root, port, client, listenPort: 0, runtime: { holdMs: 0, proofRetryMs: 1 }, ears: "off", emergencyClinicId: "dddddddd-1111-4222-8333-444444444444", log: (l) => { if (process.env["DBG"]) console.log(l); },
    transcribe: async (_w, _k, id) => ({ final: true, text: heard.shift() ?? "", audio_ms: 1000, session_id: id, cost_usd: 0 }) });
  const say = async (seq: number) => {
    const f = new FormData();
    f.append("audio", new Blob([chunk()], { type: "audio/wav" }), "c.wav");
    f.append("owner", OWNER); f.append("session_id", "s-a"); f.append("seq", String(seq)); f.append("captured_at", String(Date.now()));
    return (await (await fetch(`${s.url}/tasks/listen`, { method: "POST", body: f })).json()) as any;
  };
  return { s, port, seen, say };
}

// The words of a Nigerian A&E as a doctor receives a patient, with the hesitations people use.
const TALK = [
  "Okay, okay, what have we got?",
  "Young woman, em, she collapsed for the market, one bystander brought her in.",
  "Let's get her on the bed. Can we get a line in, abeg?",
  "Her name is Grace, Grace Okafor, the number is oh-eight-oh-three, one two three, four five six seven.",
  "She's about thirty, no history we know of."
];
const describesArrival = (said: string, recent: string[]) => /collapsed|brought her in|brought him in/i.test(said) || (/what have we got/i.test(recent.join(" ")) && /young|woman|man|boy|girl/i.test(said));

describe("a new arrival heard from how clinicians talk, with nothing open", () => {
  it("opens the arrival from the description, holds the lines after it, and binds them with the name said naturally", async () => {
    const { s, port, seen, say } = await boot([...TALK], describesArrival);
    let open!: () => void;
    port.gate = new Promise((r) => { open = r; });
    const greet = await say(0);
    expect(greet.no_patient).toBe(true);
    const arrival = await say(1);
    expect(arrival.entry).toBe("arrival");
    const taskId = arrival.utterances[0].task_id as string;
    // The door is slow, so the next lines wait for the arrival and are then bound to it.
    expect((await say(2)).pending).toBe(true);
    expect((await say(3)).pending).toBe(true);
    open();
    await until(() => s.runtime.view(taskId)!.identities.length === 1, 5000);
    await say(4);
    await s.runtime.settled();
    const v = s.runtime.view(taskId)!;
    expect(port.writes).toHaveLength(1);
    expect(port.writes[0]!.args["reason"]).toMatch(/collapsed for the market/);
    expect(port.writes[0]!.prov.evidence).toBe(`transcript:${arrival.utterances[0].line_id}`);
    expect(v.identities[0]).toMatchObject({ name: "Grace Okafor", phone: "08031234567", encounter: { patient_id: ARRIVAL } });
    // The three lines after the description are on the arrival's task; ambient words are kept only when something rests on them, as the name does.
    expect(v.transcript.filter((x) => x.ambient).flatMap((x) => x.ambient!.seqs)).toEqual([2, 3, 4]);
    expect(v.transcript.find((x) => x.kept && x.text === TALK[3])).toBeTruthy();
    // The greeting was read with the description and was the only line before it.
    expect(seen.slice(0, 2)).toEqual([TALK[0], TALK[1]]);
    await s.close();
  });

  it("opens nothing for ward chatter that describes no new patient", async () => {
    const chatter = [
      "Abeg who get the keys for the drug cupboard?",
      "Bed four is still spiking, the one from yesterday, we'll review her at two.",
      "Night shift said the generator went off again, eh.",
      "Okay, let's do the handover after this."
    ];
    const { s, port, say } = await boot([...chatter], describesArrival);
    for (let i = 0; i < chatter.length; i++) expect((await say(i)).no_patient).toBe(true);
    await s.runtime.settled();
    expect(port.writes).toHaveLength(0);
    expect(s.runtime.taskIds()).toHaveLength(0);
    await s.close();
  });

  it("keeps the arrival prompt free of denied terms and committed", () => {
    expect(denyHits(`${ARRIVAL_PROMPT}\n${JSON.stringify(arrivalTool())}`)).toEqual([]);
  });
});
