import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Provenance } from "@hey-pisgah/agent";
import { loadProfile } from "../src/profile.js";
import { PisgahPort, type DoorLog } from "../src/port.js";
import { SandboxBlock, mintAgentBearer, sandboxQuery } from "../src/sandbox.js";
import { freshArrival } from "./sandbox-helpers.js";

// Runs only with SANDBOX=1 and VER_LIVE=1 against two serves already running: the person's version desk (VER_LEARN) and the EMR serve reading its log (VER_SERVE).
const RUN = process.env["SANDBOX"] === "1" && process.env["VER_LIVE"] === "1" && !!process.env["VER_SERVE"] && !!process.env["VER_LEARN"] && !!process.env["VER_OUT"] && !!process.env["VER_VLOG"];
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Row = Record<string, unknown>;
type View = { task_id: string; questions: { text: string }[]; notes: { text: string; at: string }[]; actions: { action_id: string; kind: string; state: string; args: Row; proof?: { record_id: string } }[]; version: Row | null; calls: number; usd: number; watching: Row | null };

describe.skipIf(!RUN)("VER: adopt, use, suspend and stop, live in the EMR", () => {
  it("adopts version 2 through the desk, offers and saves on a fresh ward A stay, then after the suspension withdraws a pending offer and offers nothing on the next fresh stay", async () => {
    const profile = loadProfile();
    const sb = SandboxBlock.parse(profile.sandbox);
    const out = process.env["VER_OUT"]!, serve = process.env["VER_SERVE"]!, learn = process.env["VER_LEARN"]!, vlog = process.env["VER_VLOG"]!;
    mkdirSync(out, { recursive: true });
    const doc = mintAgentBearer(sb);
    const nurse = mintAgentBearer(sb, sb.owners.find((o) => o.login === "nurse.ada")!);
    const requests: DoorLog[] = [];
    const port = new PisgahPort(profile, { bearers: { [doc.owner]: doc.bearer }, onRequest: (l) => requests.push(l) });
    const now = () => new Date().toISOString();
    const prov = (line: string): Provenance => ({ owner: doc.owner, evidence: `transcript:${line}`, spoken_at: now() });
    const logHash = () => createHash("sha256").update(readFileSync(vlog)).digest("hex");
    const until = async <T>(what: string, read: () => Promise<T | null | undefined | false>, ms = 180_000): Promise<T> => {
      const end = Date.now() + ms;
      for (;;) { const v = await read(); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await wait(500); }
    };
    const post = async (url: string, body: unknown): Promise<[number, Row]> => { const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return [r.status, (await r.json()) as Row]; };
    const view = async (taskId: string): Promise<View> => (await (await fetch(`${serve}/tasks/${taskId}`)).json()) as View;
    const manager = { kind: "person", staff_id: "wm_a_synthetic_ver", role: "ward_manager", display_name: "Synthetic Ward A manager (disclosed; a person's role played by the VER build lane)" };
    // A fresh arrival admitted by the doctor's agent to the children's ward (workflow ward A) and bedded where a bed is free.
    const stay = async (label: string, tag: string) => {
      const { patient, visit } = await freshArrival(profile, label);
      expect(await port.commit("open_consult", { visit_id: visit, patient_id: patient }, `ver-open-${visit}`, prov(`ver-open-${tag}`))).toMatchObject({ ok: true });
      const adm = await port.commit("admit_patient", { visit_id: visit, patient_id: patient, ward: "childrens", admission_type: "emergency", reason: "ZZ-TEST abdominal pain for observation" }, `ver-admit-${visit}`, prov(`ver-admit-${tag}`));
      expect(adm, JSON.stringify(adm)).toMatchObject({ ok: true });
      const admission = (adm as { record_id: string }).record_id;
      const bed = await port.commit("assign_bed", { admission_id: admission, ward: "childrens" }, `ver-bed-${visit}`, prov(`ver-bed-${tag}`));
      return { patient, visit, admission, bed: bed.ok ? "assigned" : bed.reason };
    };
    // The nurse opens the stay's page, as her strip does, so her agent watches the record for her.
    const watch = async (admission: string) => {
      const [st, t] = await post(`${serve}/tasks/watch`, { owner: nurse.owner, admissionId: admission });
      expect(st).toBe(200);
      const id = String(t["task_id"]);
      await until("the nurse's first watch", async () => (await view(id)).watching);
      return id;
    };
    const round = async (admission: string, tag: string) => {
      const r = await port.commit("record_note", { admission_id: admission, note_type: "ward_round", text: "Ward round: abdominal pain settling, abdomen soft, tolerating fluids, plan home tomorrow if well." }, `ver-round-${admission}`, prov(`ver-round-${tag}`));
      expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
      return now();
    };
    const say = async (admission: string, text: string) => {
      const [st, b] = await post(`${serve}/tasks/say`, { owner: nurse.owner, admissionId: admission, text, spokenAt: now() });
      expect(st, JSON.stringify(b)).toBe(202);
      return String(b["line_id"]);
    };
    const result: Row = { started_at: now(), serve, desk: learn, version_log: { hash_start: logHash() } };
    const shots: Row[] = [];
    const browser = process.env["VER_SHOTS"] === "1" ? await openStrip(out, nurse.owner, serve) : null;
    const shot = async (name: string, admission: string) => { if (browser) shots.push({ name, ...(await browser.shot(name, admission)) }); };
    try {
      // 1. A person's role adopts version 2 through the desk; the running EMR serve was started before and is not restarted.
      const [ast, adopted] = await post(`${learn}/versions/adopt`, { proposal_id: process.env["VER_PROPOSAL"] ?? "p-494e0f14", approver: manager });
      expect(ast, JSON.stringify(adopted)).toBe(201);
      result["adopted"] = { at: now(), http_status: ast, ...adopted, approver: manager, log_hash: logHash() };

      // 2. A fresh ward A stay uses it: the offer at the round entry, the nurse's two lines, the saved note.
      const a1 = await stay("VER Loop A1", "a1");
      const t1 = await watch(a1.admission);
      expect((await view(t1)).questions).toHaveLength(0);
      const round1 = await round(a1.admission, "a1");
      const offer1 = await until("the offer at the round entry", async () => (await view(t1)).questions.find((q) => q.text.startsWith("The round entry is on the stay")));
      const offeredAt = now();
      await shot("a1-offer", a1.admission);
      await say(a1.admission, "Draft the summary.");
      await until("the draft for review", async () => (await view(t1)).questions.find((q) => q.text.startsWith("Summary draft for your review")));
      const saveLine = await say(a1.admission, "That reads right. Save the summary.");
      const saved = await until("the saved summary proved", async () => (await view(t1)).actions.find((x) => x.kind === "record_note" && x.state === "completed" && x.args["label"] === "stay_summary"));
      await shot("a1-saved", a1.admission);
      const notes = sandboxQuery(sb, "notes", { admission: a1.admission });
      const provRows = sandboxQuery(sb, "provenance_since", { since: new Date(Date.now() - 3_600_000).toISOString() }).filter((r) => r["evidence"] === `transcript:${saveLine}`);
      expect(notes.some((n) => n["id"] === saved.proof?.record_id && n["author"] === nurse.agent)).toBe(true);
      const v1 = await view(t1);
      result["a1"] = {
        admission: a1.admission, patient: a1.patient, bed: a1.bed, task: t1, round_at: round1, offer: offer1.text, offered_at: offeredAt, version: v1.version,
        saved: { action: saved.action_id, record_id: saved.proof?.record_id ?? null, line: saveLine, note_author_is_nurse_agent: true, notes: notes.map((n) => ({ id: n["id"], note_type: n["note_type"] })), provenance: provRows.map((r) => ({ action_type: r["action_type"], on_behalf_of: r["on_behalf_of"] === nurse.owner, origin: r["origin"] })) },
        calls: v1.calls, usd: v1.usd
      };

      // 3. A second fresh ward A stay reaches its offer and the nurse has not answered it yet.
      const a2 = await stay("VER Loop A2", "a2");
      const t2 = await watch(a2.admission);
      await round(a2.admission, "a2");
      const offer2 = await until("the second offer", async () => (await view(t2)).questions.find((q) => q.text.startsWith("The round entry is on the stay")));
      await shot("a2-pending", a2.admission);

      // 4. The person's role suspends version 2 through the desk; the EMR serve reads the log again on its next watch.
      const reason = "On dev case c-ad742d69 the draft waited 167 minutes past sign-off for a round entry typed in late; suspended until a revision is reviewed";
      const [sst, susp] = await post(`${learn}/versions/2/suspend`, { by: manager, reason });
      expect(sst, JSON.stringify(susp)).toBe(200);
      const suspendedAt = now();
      result["suspended"] = { at: suspendedAt, http_status: sst, ...susp, reason, by: manager, log_hash: logHash() };
      const gone = await until("the pending offer withdrawn", async () => { const v = await view(t2); return v.questions.length === 0 && ((v.version?.["withdrawn"] as Row[] | undefined) ?? []).length ? v : null; }, 60_000);
      await shot("a2-withdrawn", a2.admission);
      result["a2"] = { admission: a2.admission, patient: a2.patient, bed: a2.bed, task: t2, offer: offer2.text, withdrawn_after_ms: Date.now() - Date.parse(suspendedAt), version: gone.version, note: gone.notes.find((n) => n.text.startsWith("Withdrawn:"))?.text ?? null, questions: gone.questions.length, calls: gone.calls };

      // 5. The next fresh ward A stay reaches the same trigger point and is offered nothing, with the suspension as the reason.
      const a3 = await stay("VER Loop A3", "a3");
      const t3 = await watch(a3.admission);
      await round(a3.admission, "a3");
      const held = await until("the suspension given as the reason", async () => { const v = await view(t3); return ((v.version?.["withheld"] as Row[] | undefined) ?? []).length ? v : null; });
      await wait(12_000);
      const v3 = await view(t3);
      await shot("a3-not-offered", a3.admission);
      expect(v3.questions).toHaveLength(0);
      result["a3"] = { admission: a3.admission, patient: a3.patient, bed: a3.bed, task: t3, version: v3.version ?? held.version, note: v3.notes.find((n) => n.text.startsWith("Not offered:"))?.text ?? null, questions: v3.questions.length, offers: v3.actions.length, calls: v3.calls };
      result["ok"] = true;
    } finally {
      result["finished_at"] = now();
      result["version_log"] = { ...(result["version_log"] as Row), hash_end: logHash() };
      result["shots"] = shots;
      await browser?.close();
      writeFileSync(join(out, "live.json"), `${JSON.stringify(result, null, 1)}\n`);
      writeFileSync(join(out, "requests.json"), `${JSON.stringify(requests, null, 1)}\n`);
    }
  }, 1_500_000);
});

// The nurse's own EMR page in Chrome with her strip pointed at this serve, for a screenshot of what the strip shows.
async function openStrip(out: string, _owner: string, serve: string): Promise<{ shot: (name: string, admission: string) => Promise<Row>; close: () => Promise<void> }> {
  const app = process.env["VER_APP"] ?? "http://localhost:3311";
  const req = createRequire(process.env["VER_PISGAH_PKG"] ?? "/Users/samuel/Documents/Pisgah/Pisgah/package.json");
  type Pg = { goto: (u: string, o?: unknown) => Promise<unknown>; fill: (s: string, v: string) => Promise<void>; click: (s: string) => Promise<void>; waitForURL: (f: (u: URL) => boolean, o?: unknown) => Promise<void>; waitForTimeout: (ms: number) => Promise<void>; screenshot: (o: { path: string; fullPage?: boolean }) => Promise<unknown>; evaluate: <T>(f: () => T) => Promise<T> };
  const { chromium } = req("playwright") as { chromium: { launch: (o: unknown) => Promise<{ newContext: (o: unknown) => Promise<{ addInitScript: (f: (s: string) => void, a: string) => Promise<void>; newPage: () => Promise<Pg> }>; close: () => Promise<void> }> } };
  const b = await chromium.launch({ channel: "chrome", headless: true });
  const ctx = await b.newContext({ viewport: { width: 1380, height: 900 } });
  await ctx.addInitScript((s) => { try { window.localStorage.setItem("pisgah-agent-serve", s); } catch { /* storage off */ } }, serve);
  const page = await ctx.newPage();
  await page.goto(`${app}/login?next=%2Fnurse%2Fadmissions`, { timeout: 120_000 });
  await page.fill('input[name="username"]', "nurse.ada");
  await page.fill('input[name="password"]', process.env["VER_PASSWORD"] ?? "ZzTestW0-2026");
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 90_000 }).catch(() => undefined);
  return {
    shot: async (name, admission) => {
      await page.goto(`${app}/nurse/admissions/${admission}`, { timeout: 120_000 }).catch(() => undefined);
      await page.waitForTimeout(8000);
      const path = join(out, `${name}.png`);
      await page.screenshot({ path, fullPage: false });
      const strip = await page.evaluate(() => (document.querySelector('section[aria-label^="Agent for"]') as HTMLElement | null)?.innerText ?? null);
      return { path, strip: strip ? strip.slice(0, 1500) : null };
    },
    close: () => b.close()
  };
}
