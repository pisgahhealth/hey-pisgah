import { describe, expect, it } from "vitest";
import { ADM, OWNER } from "./emr-helpers.js";
import { boot, chunkWav, earOf, obs, say } from "./mic-helpers.js";

describe("the join rule, from the first real-mic session", () => {
  it("joins 'the temperature is about' with the next chunk and charts one temperature, never gating either half", async () => {
    const sent: number[] = [];
    const { rt, port, listen, seen, settle } = boot((said) => (said.includes("37.6") ? obs(said, { temp_c: "37.6" }) : [{ class: "unclear", question: "Which temperature?" }]),
      earOf({ 2200: "uh the temperature is about", 2100: "there is 7.6.", 4300: "uh the temperature is about thirty seven point six." }, sent));
    const first = await say(listen, 1, chunkWav(1500, 700));
    expect(first.outcome).toMatchObject({ final: false, why: "held_for_number", transcript: "uh the temperature is about" });
    const second = await say(listen, 2, chunkWav(1400, 700));
    // The joined line ends on a number, so it waits once more for anything that carries the number on.
    expect(second.outcome).toMatchObject({ final: false, why: "held_for_number", transcript: "uh the temperature is about 37.6." });
    expect(sent).toEqual([2200, 4300]);
    await settle();
    expect(rt.views(OWNER)[0]!.transcript[0]!.ambient).toMatchObject({ seqs: [1, 2], finished_by: "joined_across_cut" });
    expect(seen).toEqual(["uh the temperature is about 37.6."]);
    expect(port.writes.map((w) => w.args)).toEqual([{ admission_id: ADM, temp_c: "37.6" }]);
  });

  it("joins 'thirty-seven point' with 'six', and a number with a next line that carries it on", async () => {
    const { port, listen, settle } = boot((said) => (said.includes("37.6") ? obs(said, { temp_c: "37.6" }) : said.includes("128/76") || said.includes("128 over 76") ? obs(said, { bp: "128/76" }) : [{ class: "aside" }]),
      earOf({ 2000: "Temperature thirty-seven point", 1200: "six.", 3200: "Temperature thirty-seven point six.", 2300: "Blood pressure 128", 1300: "over 76.", 3600: "Blood pressure 128 over 76." }));
    await say(listen, 0, chunkWav(1300, 700));
    expect((await say(listen, 1, chunkWav(500, 700))).outcome).toMatchObject({ why: "held_for_number", transcript: "Temperature 37.6." });
    await say(listen, 2, chunkWav(1600, 700));
    // The blood pressure line arrives, so the joined temperature goes on alone, and "over 76" joins its own line.
    expect((await say(listen, 3, chunkWav(600, 700))).outcome).toMatchObject({ why: "held_for_number", transcript: "Blood pressure 128 over 76." });
    await settle();
    expect(port.writes.map((w) => w.args)).toEqual([{ admission_id: ADM, temp_c: "37.6" }, { admission_id: ADM, bp: "128/76" }]);
  });

  it("does not join a finished vitals line with talk that does not carry the number on", async () => {
    const { port, listen, seen, settle } = boot((said) => (said.startsWith("Chart pulse") ? obs(said, { pulse: 96 }) : [{ class: "aside" }]),
      earOf({ 1700: "Chart pulse 96.", 2200: "Emeka, hand me the gloves." }));
    await say(listen, 0, chunkWav(1000, 700));
    expect((await say(listen, 1, chunkWav(1500, 700))).outcome).toMatchObject({ why: "quiet_tail", utterance: { seqs: [1] } });
    await settle();
    expect(seen).toEqual(["Chart pulse 96.", "Emeka, hand me the gloves."]);
    expect(port.writes.map((w) => w.args)).toEqual([{ admission_id: ADM, pulse: 96 }]);
  });

});
