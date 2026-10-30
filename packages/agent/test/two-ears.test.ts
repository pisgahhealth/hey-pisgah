import { describe, expect, it } from "vitest";
import { ModelClient } from "@hey-pisgah/model";
import { answerChoice, compareReadings, quotedQuestion, sparkEar } from "../src/emr/ears.js";
import { ADM, OWNER, emrRoot } from "./emr-helpers.js";
import { boot, chunkWav, earOf, obs, say, secondOf } from "./mic-helpers.js";

describe("an unclear vitals line is asked back in quotes", () => {
  it("asks back what it heard when nothing follows the cut, and one spoken number settles it with no model call", async () => {
    const { rt, port, listen, seen, settle } = boot(() => [{ class: "unclear", question: "What temperature should I record?" }],
      earOf({ 2200: "uh the temperature is about", 1800: "thirty seven point six." }), { strongMs: 20 });
    await say(listen, 0, chunkWav(1500, 700));
    await new Promise((r) => setTimeout(r, 60));
    await rt.settled();
    let v = rt.views(OWNER)[0]!;
    expect(v.questions).toEqual([{ question_id: expect.any(String), text: 'I heard "uh the temperature is about". What is the temperature? Say the number.', answers: ["no"] }]);
    await say(listen, 1, chunkWav(1100, 700));
    await settle();
    v = rt.views(OWNER)[0]!;
    expect(seen).toEqual(["uh the temperature is about"]);
    expect(v.questions).toEqual([]);
    expect(v.transcript[1]!.classes).toEqual(["instruction"]);
    expect(port.writes.map((w) => w.args)).toEqual([{ admission_id: ADM, temp_c: "37.6" }]);
  });

  it("quotes an unclear line with two values and offers both as one-word answers", () => {
    const q = quotedQuestion("Chart the respiratory rate again. It's 18, or was it 22? I lost count.", "Did you mean 18 or 22?");
    expect(q.text).toBe('I heard "Chart the respiratory rate again. It\'s 18, or was it 22? I lost count.". Say 18 or 22.');
    expect(answerChoice("22.", q.choice!)).toEqual({ resp_rate: "22" });
    expect(answerChoice("It's 22, please.", q.choice!)).toEqual({ resp_rate: "22" });
    expect(answerChoice("I counted again. Respiratory rate 22, put that down.", q.choice!)).toBeNull();
    expect(answerChoice("no", q.choice!)).toBe("no");
    expect(answerChoice("yes", q.choice!)).toBeNull();
  });
});

describe("two readings must agree on a number before a write", () => {
  it("writes when the second ear hears the same numbers, and counts the agreement for the session", async () => {
    const heard: number[] = [];
    const { rt, port, listen, settle } = boot((said) => obs(said, { temp_c: "37.9", pulse: 96, resp_rate: 20 }),
      earOf({ 3700: "Temperature 37.9, pulse 96, respiratory rate 20." }), { second: secondOf({ 3700: "Temperature thirty seven point nine, pulse ninety six, respiratory rate twenty." }, heard) });
    await say(listen, 0, chunkWav(3000, 700));
    await settle();
    expect(heard).toEqual([3700]);
    expect(port.writes.map((w) => w.args)).toEqual([{ admission_id: ADM, temp_c: "37.9", pulse: 96, resp_rate: 20 }]);
    const v = rt.views(OWNER)[0]!;
    expect(v.ears).toEqual({ compared: 1, agreed: 1, rate: 1, sessions: [{ session_id: "s1", compared: 1, agreed: 1, rate: 1 }] });
    expect(v.usd).toBeGreaterThan(0.002);
  });

  it("stops the write when the readings differ, shows both, and one word picks the value", async () => {
    const { rt, port, listen, settle } = boot((said) => (said.startsWith("the pulse") ? obs(said, { pulse: 88 }) : [{ class: "aside" }]),
      earOf({ 2200: "the polls polls is 88.", 1200: "98." }), { second: secondOf({ 2200: "The pulse is 98.", 1200: "98" }) });
    await say(listen, 0, chunkWav(1500, 700));
    await settle();
    let v = rt.views(OWNER)[0]!;
    expect(port.writes).toEqual([]);
    expect(v.actions.map((a) => [a.state, a.reason])).toEqual([["cancelled", "readings_differ"]]);
    expect(v.questions).toEqual([{ question_id: expect.any(String), text: "Pulse: one reading heard 88, the other 98. Say 88 or 98.", answers: ["88", "98", "no"] }]);
    await say(listen, 1, chunkWav(500, 700));
    await settle();
    v = rt.views(OWNER)[0]!;
    expect(port.writes.map((w) => w.args)).toEqual([{ admission_id: ADM, pulse: 98 }]);
    expect(v.ears).toMatchObject({ compared: 2, agreed: 1, rate: 0.5 });
  });

  it("acts on a guessed measure word only when the second ear names it plainly", async () => {
    const heardLine = "respiratory rate reaches 18. Hmm.";
    const run = async (second: string) => {
      const b = boot((said) => (said === heardLine ? obs(said, { resp_rate: 18 }) : [{ class: "aside" }]), earOf({ 2200: "Harris Bridge reaches 18. Hmm." }), { second: secondOf({ 2200: second }) });
      await say(b.listen, 0, chunkWav(1500, 700));
      await b.settle();
      return { writes: b.port.writes.map((w) => w.args), seen: b.seen, q: b.rt.views(OWNER)[0]!.questions.map((x) => x.text) };
    };
    const plain = await run("Resp rate 18.");
    expect(plain.seen).toEqual([heardLine]);
    expect(plain.writes).toEqual([{ admission_id: ADM, resp_rate: 18 }]);
    const same = await run("Harris Bridge reaches 18.");
    expect(same.writes).toEqual([]);
    expect(same.q).toEqual(["Respiratory rate 18: the second reading did not hear it. Say yes to chart 18, or say the number."]);
    expect((await run("Pulse 18.")).writes).toEqual([]);
  });

  it("reads once more when the second ear answers with no number, and sends audio_url to Spark Open at effort low", async () => {
    const bodies: Record<string, unknown>[] = [];
    const replies = ["I am unable to access or listen to audio clips.", "Respiratory rate 22, put that down."];
    const client = new ModelClient({
      storeRoot: emrRoot(), mode: "mock",
      mock: ({ body, hash }) => (bodies.push(body), { id: `m-${hash.slice(0, 6)}`, object: "chat.completion", created: 0, model: String(body["model"]), choices: [{ index: 0, finish_reason: "stop", logprobs: null, message: { role: "assistant", content: replies[bodies.length - 1] ?? "", refusal: null } }], usage: { prompt_tokens: 200, completion_tokens: 100, total_tokens: 300 } })
    });
    const r = await sparkEar(client)(chunkWav(500, 0), { run_id: "run-abcd1234", task_id: "t-abcd1234", line_id: "u1" });
    expect(r).toMatchObject({ text: "Respiratory rate 22, put that down.", provider: "modal", calls: 2 });
    expect(bodies).toHaveLength(2);
    const user = (bodies[0]!["messages"] as { role: string; content: unknown }[])[1]!.content as { type: string; audio_url?: { url: string } }[];
    expect(user.map((x) => x.type)).toEqual(["text", "audio_url", "text"]);
    expect(user[1]!.audio_url!.url.startsWith("data:audio/wav;base64,UklGR")).toBe(true);
    expect(bodies[0]!["reasoning_effort"]).toBe("low");
    client.close();
  });

  it("compares numbers, not words, and a second reading that hears nothing is a disagreement", () => {
    // The ward form "one twenty eight" now reads as 128, so it agrees, and a different number said that way still disagrees.
    expect(compareReadings({ bp: "128/76" }, "Put her blood pressure in as one twenty eight over seventy six").agree).toBe(true);
    expect(compareReadings({ bp: "128/76" }, "Put her blood pressure in as one twenty six over seventy six").agree).toBe(false);
    expect(compareReadings({ bp: "128/76" }, "Put her BP in as 128 over 76.").agree).toBe(true);
    expect(compareReadings({ pulse: 104 }, "Sorry, that pulse was wrong. It's 104, not 96.").agree).toBe(true);
    expect(compareReadings({ temp_c: "37.6" }, "No audio was provided.")).toEqual({ agree: false, measures: [{ measure: "temp_c", first: "37.6", second: null, agree: false }] });
  });
});
