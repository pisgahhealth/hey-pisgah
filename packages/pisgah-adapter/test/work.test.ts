import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { DoorProfile } from "../src/profile.js";
import { PisgahPort, render, type DoorLog } from "../src/port.js";
import { SandboxBlock, mintArgs } from "../src/sandbox.js";

const PAT = "33333333-4444-4555-8666-777777777777";
const VIS = "55555555-4444-4555-8666-777777777777";
const ADM = "11111111-2222-4333-8444-555555555555";
const CLINIC = "66666666-4444-4555-8666-777777777777";
const PAGE = "77777777-4444-4555-8666-777777777777";
const DOC = "doc-owner", ACC = "acc-owner";
const prov = (owner: string) => ({ owner, evidence: "transcript:u-1", spoken_at: "2026-10-28T09:00:00.000Z" });

// A stand-in door with made-up routes: a board, a stay with its plan, bill and stage, pages and slots.
async function door() {
  const st = { admitted: false, items: [] as { title: string }[], pages: new Map<string, { subject: string; body: string }>(), linkAt: null as string | null, booked: [] as unknown[], seen: [] as { path: string; body: unknown }[] };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
    const url = new URL(req.url ?? "/", "http://door");
    const path = url.pathname.replace(/^\/d\//, "");
    st.seen.push({ path: `${req.method} ${path}${url.search}`, body });
    const send = (s: number, j: unknown) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(j)); };
    if (path === "board") return send(200, { rows: [{ pid: PAT, visit: VIS, name: "Journey Patient" }] });
    if (path === "stay/ask") { st.admitted = true; return send(200, { ok: true, id: ADM, status: "requested" }); }
    if (path === `stay/${ADM}`) return send(200, { name: "Journey Patient", ward: "A&E", status: st.admitted ? "Requested" : null, note: { body: "Handover. Settled overnight." } });
    if (path === "stay/plan-item") { st.items.push({ title: body.label }); return send(200, { ok: true, id: ADM }); }
    if (path === `stay/${ADM}/plan`) return send(200, { items: st.items });
    if (path === "page/send") { st.pages.set(PAGE, { subject: body.subject, body: body.body }); return send(200, { pageId: PAGE, sent: 1 }); }
    if (path === "page/one") return send(200, { pageId: url.searchParams.get("pageId"), ...st.pages.get(String(url.searchParams.get("pageId"))), patientId: PAT });
    if (path === "page/mine") return send(200, { pages: [...st.pages.keys()].map((id) => ({ pageId: id, subject: st.pages.get(id)!.subject, createdAt: "2026-10-28T09:01:00.000Z" })) });
    if (path === "slots") return send(200, { slots: [{ slotId: `${CLINIC}|${url.searchParams.get("date")}|0`, taken: true }, { slotId: `${CLINIC}|${url.searchParams.get("date")}|3`, taken: false }] });
    if (path === "book") { st.booked.push(body); return send(200, { ok: true, id: "appt-1" }); }
    if (path === `stay/${ADM}/bill`) return send(200, { total: "10250.00", paid: "4000.00", lines: [{ d: "Bed" }, { d: "Fee" }], linkAt: st.linkAt });
    if (path === "stay/out/pay-link") { st.linkAt = "2026-10-28T10:00:00.000Z"; return send(200, { ok: true, status: "sent" }); }
    if (path === `stay/${ADM}/stage`) return send(200, { stage: "signed_off" });
    send(404, { error: { code: "not_found_opaque" } });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { st, base: `http://127.0.0.1:${(server.address() as { port: number }).port}/d`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const profile = (base: string) => DoorProfile.parse({
  base_url: base, timeout_ms: 2000,
  headers: { on_behalf_of: "X-For", origin: "X-Origin", evidence: "X-Evidence", spoken_at: "X-Spoken", idempotency: "X-Key", replayed: "X-Replayed" },
  origin_value: "voice", deny: ["stay/out/done", "stay/settle"], deny_exact: ["stay/out"],
  ops: {
    read_admission: { method: "GET", path: "stay/{admission_id}", label: "name", facts: { ward: "ward", status: "status" }, proof: {} },
    write_observation: { method: "POST", path: "stay/entry", body: {}, writes_path: "writes", primary_store: "obs" },
    patient_context: { path: "board", list_path: "rows", match: "pid", label: "name", visit: "visit" }
  },
  work: {
    request_admission: { method: "POST", path: "stay/ask", body: { visitId: "$visit_id", wardClass: "$ward_class", type: "$admission_type", reason: "$reason" }, ack: { id_path: "id", store: "admission" }, proof: { path: "stay/{record_id}", checks: { status: "@nonnull" } } },
    add_care_plan_item: { method: "POST", path: "stay/plan-item", body: { admissionId: "$admission_id", label: "$title", kind: "$item_kind", cadence: "$cadence" }, ack: { store: "care_plan_item" }, proof: { path: "stay/{admission_id}/plan", find: { list: "items", where: { title: "$title" } }, checks: { title: "$title" } } },
    page_staff: { method: "POST", path: "page/send", body: { to: "$target_kind", toId: "$target_id", subject: "$subject", body: "$page_body", patientId: "$patient_id" }, ack: { id_path: "pageId", store: "page", positive: "sent" }, proof: { path: "page/one", query: { pageId: "$record_id" }, checks: { body: "@contains:$text" } } },
    schedule_follow_up: { method: "POST", path: "book", body: { visitId: "$visit_id", targetClinicId: "$slot_clinic_id", appointmentDate: "$date", slotIndex: "$slot_index" }, before: [{ path: "slots", query: { date: "$date" }, list: "slots", where: { taken: false }, field: "slotId", split: "|", vars: ["slot_clinic_id", "_", "slot_index"] }], ack: { id_path: "id", store: "appointment" }, proof: { path: "slots", query: { date: "$date" }, checks: { "slots.0.taken": "@nonnull" } } },
    send_pay_link: { method: "POST", path: "stay/out/pay-link", body: { admissionId: "$admission_id" }, ack: { store: "pay_link" }, proof: { path: "stay/{admission_id}/bill", checks: { linkAt: "@nonnull" } } },
    prepare_bill: { reads: { bill: { path: "stay/{admission_id}/bill" } }, report: "Charged {bill.total}, paid {bill.paid}; lines: {bill.lines[].d}.", store: "bill_view" },
    draft_handover: { reads: { stay: { path: "stay/{admission_id}" }, plan: { path: "stay/{admission_id}/plan" } }, draft: "Handover for {stay.name} in {stay.ward}. Plan: {plan.items[].title}.", store: "handover_draft" }
  },
  owners: [
    { id: DOC, label: "Doctor", kinds: ["request_admission", "page_staff", "schedule_follow_up", "add_care_plan_item", "draft_handover"], watches: ["stage"], inbox: true },
    { id: ACC, label: "Accounts", kinds: ["prepare_bill", "send_pay_link"], watches: ["stage"], offers: [{ fact: "stage.stage", equals: "signed_off", kind: "send_pay_link", ask: "Send the pay link?" }] }
  ],
  watches: { stage: { path: "stay/{admission_id}/stage", facts: { stage: { path: "stage", label: "Discharge stage" } } } },
  inbox: { path: "page/mine", list_path: "pages", id: "pageId", subject: "subject", at: "createdAt", detail: { path: "page/one", query: { pageId: "$page_id" }, patient: "patientId" } },
  page_targets: { accounts: { words: ["accounts"], vars: { target_kind: "person", target_id: "88888888-4444-4555-8666-777777777777", subject: "A request from a doctor's agent" } } },
  clinics: { gopd: { words: ["GOPD"], id: CLINIC } },
  targets: { admission_by_patient: {}, episode_by_admission: {} }
});

describe("profile-driven work over the door", () => {
  it("runs each write kind with its proof, learns the admission, and keeps reads read-only", async () => {
    const d = await door();
    const log: DoorLog[] = [];
    try {
      const port = new PisgahPort(profile(d.base), { bearers: { [DOC]: "b-doc", [ACC]: "b-acc" }, onRequest: (l) => log.push(l) });
      expect(port.kindsFor(ACC)).toEqual(["prepare_bill", "send_pay_link"]);
      expect(port.names()).toEqual({ page_targets: { accounts: ["accounts"] }, clinics: { gopd: ["GOPD"] }, wards: {} });
      const before = await port.resolve({ patient_id: PAT }, prov(DOC));
      expect(before).toMatchObject({ admission_id: "", visit_id: VIS, label: "Journey Patient" });

      const req = { visit_id: VIS, patient_id: PAT, ward_class: "general", admission_type: "emergency", reason: "suspected appendicitis" };
      const c1 = await port.commit("request_admission", req, "key-1", prov(DOC));
      expect(c1).toMatchObject({ ok: true, record_id: ADM, event_ids: [`admission:${ADM}`] });
      expect(await port.prove("request_admission", req, c1 as never, prov(DOC))).not.toBeNull();
      expect(await port.resolve({ patient_id: PAT }, prov(DOC))).toMatchObject({ admission_id: ADM, patient_id: PAT, visit_id: VIS });

      const item = { admission_id: ADM, title: "Four-hourly observations", item_kind: "observation", cadence: "q4h" };
      const c2 = await port.commit("add_care_plan_item", item, "key-2", prov(DOC));
      expect(await port.prove("add_care_plan_item", item, c2 as never, prov(DOC))).toMatchObject({ record_id: ADM });
      expect(await port.prove("add_care_plan_item", { ...item, title: "Something else" }, c2 as never, prov(DOC))).toBeNull();

      const page = { to: "accounts", text: "She is ready for her bill.", admission_id: ADM };
      const c3 = await port.commit("page_staff", page, "key-3", prov(DOC));
      expect(c3).toMatchObject({ ok: true, record_id: PAGE });
      expect(d.st.pages.get(PAGE)).toEqual({ subject: "A request from a doctor's agent", body: "Journey Patient: She is ready for her bill." });
      expect(await port.prove("page_staff", page, c3 as never, prov(DOC))).not.toBeNull();

      const fu = { visit_id: VIS, clinic: "gopd", date: "2026-11-11" };
      expect(await port.commit("schedule_follow_up", fu, "key-4", prov(DOC))).toMatchObject({ ok: true, record_id: "appt-1" });
      expect(d.st.booked).toEqual([{ visitId: VIS, targetClinicId: CLINIC, appointmentDate: "2026-11-11", slotIndex: 3 }]);

      const draft = await port.commit("draft_handover", { admission_id: ADM }, "key-5", prov(DOC));
      expect(draft).toMatchObject({ ok: true, draft: "Handover for Journey Patient in A&E. Plan: Four-hourly observations." });

      expect(await port.commit("send_pay_link", { admission_id: ADM }, "key-6", prov(DOC))).toMatchObject({ ok: false, reason: "kind_not_held", counted: true });
      const bill = await port.commit("prepare_bill", { admission_id: ADM }, "key-7", prov(ACC));
      expect(bill).toMatchObject({ ok: true, report: "Charged 10250.00, paid 4000.00; lines: Bed, Fee." });
      const c8 = await port.commit("send_pay_link", { admission_id: ADM }, "key-8", prov(ACC));
      expect(await port.prove("send_pay_link", { admission_id: ADM }, c8 as never, prov(ACC))).not.toBeNull();

      expect(await port.watch(ACC, { admission_id: ADM }, prov(ACC))).toEqual({ facts: { "stage.stage": "signed_off" }, labels: { "stage.stage": "Discharge stage" } });
      expect(port.offers(ACC)).toHaveLength(1);
      expect(await port.inbox(DOC, prov(DOC))).toEqual([{ page_id: PAGE, subject: "A request from a doctor's agent", at: "2026-10-28T09:01:00.000Z", patient_id: PAT }]);
      expect(await port.inbox(ACC, prov(ACC))).toEqual([]);

      const writes = d.st.seen.filter((x) => x.body !== null).map((x) => x.path);
      expect(writes).toEqual(["POST stay/ask", "POST stay/plan-item", "POST page/send", "POST book", "POST stay/out/pay-link"]);
      for (const l of log.filter((x) => x.outcome === "response")) expect(l.headers["X-Evidence"]).toBe("transcript:u-1");
      expect(log.filter((x) => x.method === "POST").every((l) => typeof l.headers["X-Key"] === "string")).toBe(true);
    } finally { await d.close(); }
  });

  it("refuses an exact deny but allows its longer sibling, and refuses a query value that could step out", async () => {
    const d = await door();
    try {
      const port = new PisgahPort(profile(d.base), { bearers: { [DOC]: "b" } });
      expect(await port.request("POST", "stay/out", prov(DOC), { body: {} })).toEqual({ kind: "refused", reason: "denied_path" });
      expect(await port.request("POST", "stay/out/done", prov(DOC), { body: {} })).toEqual({ kind: "refused", reason: "denied_path" });
      expect(await port.request("GET", "page/one", prov(DOC), { query: { pageId: "../x" } })).toEqual({ kind: "refused", reason: "bad_header" });
      expect((await port.request("POST", "stay/out/pay-link", prov(DOC), { body: { admissionId: ADM } })).kind).toBe("response");
      expect(port.refusedCount()).toBe(3);
      expect(() => new PisgahPort(DoorProfile.parse({ ...profile(d.base), deny_exact: ["stay/plan-item"] }), { bearers: {} })).toThrow(/denied path/);
    } finally { await d.close(); }
  });

  it("mints each owner with its own login and clinic, and a person without the agent flag", () => {
    const sb = SandboxBlock.parse({ env_file: "x", db_url_var: "DB", owner: "o", mint: { cwd: "/", command: "npx", args: ["tsx", "mint.ts", "--login", "dr.a", "--clinic", "GOPD", "--agent"], node_options: "", output: { bearer: "b", owner: "o", agent: "a" } }, sql: {} });
    expect(mintArgs(sb, null, true)).toEqual(["tsx", "mint.ts", "--login", "dr.a", "--clinic", "GOPD", "--agent"]);
    expect(mintArgs(sb, { login: "acc.b" }, true)).toEqual(["tsx", "mint.ts", "--login", "acc.b", "--agent"]);
    expect(mintArgs(sb, { login: "nurse.c", clinic: "A&E" }, false)).toEqual(["tsx", "mint.ts", "--login", "nurse.c", "--clinic", "A&E"]);
  });

  it("renders list and missing placeholders plainly", () => {
    expect(render("A {x.a} B {x.l[].t} C {x.none}", { x: { a: 1, l: [{ t: "p" }, { t: "q" }] } })).toBe("A 1 B p, q C none");
    expect(render("{x.g[].items[].label}", { x: { g: [{ items: [{ label: "a" }] }, { items: [{ label: "b" }, { label: "c" }] }] } })).toBe("a, b, c");
  });
});
