import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyChain } from "@hey-pisgah/contracts";
import { StoreError, configureSealing, copyForRun, open, openStream, readStream, seal } from "./index.js";

const KEY = "11".repeat(32);
const OTHER = "22".repeat(32);
const PHRASE = "Adaeze Okon says the chest pain started at noon";
const PHONE = "08031234567";
const S = "emr/t-seal0001";
const Z = { recorded_at: 0, occurred_at: 0 };

let dir: string;
let root: string;
const disk = (id = S) => readFileSync(join(root, `${id}.jsonl`), "utf8");
const code = (fn: () => unknown) => { try { fn(); } catch (e) { if (e instanceof StoreError) return e.code; throw e; } return "no_error"; };

function writeTask(): void {
  const s = openStream(root, S, { writer: true });
  s.append("emr.task.opened", { task_id: "t-seal0001", label: "Adaeze Okon", run_id: "run-abcdef12" }, Z);
  s.append("utterance.heard", { line_id: "l-1", text: PHRASE, source: "audio" }, Z);
  s.append("identity.held", { obligation_id: "o-1", name: "Adaeze Okon", phone: PHONE, nested: [{ quote: PHRASE }] }, Z);
  s.append("action.written", { action_id: "a-1", written: { record_id: "rec-00000001" } }, Z);
  s.close();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hp-seal-"));
  root = join(dir, "store");
  configureSealing({ key: KEY });
});
afterEach(() => {
  configureSealing({ key: null });
  rmSync(dir, { recursive: true, force: true });
});

describe("sealed words at rest", () => {
  it("holds no plaintext words, names or phones on disk and replays them with the key", () => {
    writeTask();
    const text = disk();
    for (const w of [PHRASE, "Adaeze", PHONE]) expect(text).not.toContain(w);
    expect(text).toContain("rec-00000001");
    const envs = readStream(root, S);
    expect(envs[1]!.payload).toEqual({ line_id: "l-1", text: PHRASE, source: "audio" });
    expect((envs[2]!.payload as { nested: { quote: string }[] }).nested[0]!.quote).toBe(PHRASE);
    expect(verifyChain(openStream(root, S, { keepSealed: true }).sealedRecords())).toEqual({ ok: true });
  });

  it("a writer reopened after a restart folds the sealed journal and keeps appending", () => {
    writeTask();
    const s = openStream(root, S, { writer: true });
    expect((s.records()[2]!.payload as { phone: string }).phone).toBe(PHONE);
    s.append("utterance.heard", { line_id: "l-2", text: "second line" }, Z);
    s.close();
    expect(readStream(root, S).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it("an old plaintext journal still replays with a key, and keeps its chain when the migration's writer appends sealed lines", () => {
    configureSealing({ key: null });
    writeTask();
    expect(disk()).toContain(PHRASE);
    configureSealing({ key: KEY });
    const s = openStream(root, S, { writer: true, allowPlain: true });
    s.append("utterance.heard", { line_id: "l-2", text: "a sealed line after plain ones" }, Z);
    s.close();
    const envs = readStream(root, S);
    expect((envs[1]!.payload as { text: string }).text).toBe(PHRASE);
    expect((envs[4]!.payload as { text: string }).text).toBe("a sealed line after plain ones");
    expect(disk()).not.toContain("a sealed line after plain ones");
  });

  it("refuses to read sealed words with no key or another key, never returning sealed objects as words", () => {
    writeTask();
    configureSealing({ key: null });
    expect(code(() => readStream(root, S))).toBe("store_key_missing");
    configureSealing({ key: OTHER });
    expect(code(() => readStream(root, S))).toBe("store_key_mismatch");
  });

  it("an edited ciphertext fails the chain check", () => {
    writeTask();
    const text = disk();
    const m = /"ct":"([A-Za-z0-9+/=]{8})/.exec(text)!;
    const edited = text.replace(m[1]!, m[1]!.split("").reverse().join(""));
    const file = join(root, `${S}.jsonl`);
    writeFileSync(file, edited);
    expect(code(() => readStream(root, S))).toBe("store_corrupt");
  });

  it("required sealing refuses to write words with no key, and a payload cannot smuggle its own sealed field", () => {
    configureSealing({ key: null, required: true });
    const s = openStream(root, S, { writer: true });
    expect(code(() => s.append("utterance.heard", { text: PHRASE }, Z))).toBe("store_key_missing");
    configureSealing({ key: KEY });
    expect(code(() => s.append("utterance.heard", { x: { $sealed: 1, kid: "k", digest: "d" } }, Z))).toBe("store_unsealable");
    s.close();
  });

  it("leaves other areas as they are", () => {
    const s = openStream(root, "ledger/run-abcdef12", { writer: true });
    s.append("model.call", { text: PHRASE }, Z);
    s.close();
    expect(disk("ledger/run-abcdef12")).toContain(PHRASE);
  });

  it("a run copy carries the sealed lines with no key needed", () => {
    writeTask();
    configureSealing({ key: null });
    const c = copyForRun(root, "run-abcdef12", [S], { runsRoot: join(dir, "runs") });
    expect(readFileSync(join(c.dir, `${S}.jsonl`), "utf8")).not.toContain(PHRASE);
  });
});

describe("retention", () => {
  it("drops the words and keeps line ids, digests, record ids, the label and the chain", () => {
    writeTask();
    const s = openStream(root, S, { writer: true });
    const before = s.sealedRecords().map((e) => e.hash);
    expect(s.retain()).toEqual({ fields: 4 });
    expect(s.records().at(-1)!.record_type).toBe("store.retained");
    expect((s.records()[1]!.payload as { text: string }).text).toBe("");
    s.close();
    const text = disk();
    expect(text).not.toMatch(/"ct":"[^"]*"[^\n]*l-1/);
    expect(text).toContain("l-1");
    expect(text).toContain("rec-00000001");
    expect(text).toContain("digest");
    const sealedNow = openStream(root, S, { keepSealed: true }).sealedRecords();
    expect(sealedNow.slice(0, 4).map((e) => e.hash)).toEqual(before);
    expect(verifyChain(sealedNow)).toEqual({ ok: true });
    configureSealing({ key: KEY });
    const envs = readStream(root, S);
    expect((envs[0]!.payload as { label: string }).label).toBe("Adaeze Okon");
    expect((envs[2]!.payload as { name: string; phone: string }).name).toBe("");
    expect((envs[2]!.payload as { phone: string }).phone).toBe("");
    expect(readdirSync(join(root, "emr")).filter((f) => f.endsWith(".retain"))).toEqual([]);
  });

  it("is idempotent and a reader cannot retain", () => {
    writeTask();
    const s = openStream(root, S, { writer: true });
    s.retain();
    expect(s.retain()).toEqual({ fields: 0 });
    s.close();
    expect(code(() => openStream(root, S).retain())).toBe("not_writer");
  });
});

describe("seal and open for files", () => {
  it("seals a pending file's text under its context and opens it again; plain text passes through", () => {
    const sealed = seal(JSON.stringify([{ text: PHRASE }]), "join-pending");
    expect(sealed).not.toContain("Adaeze");
    expect(JSON.parse(open(sealed, "join-pending"))).toEqual([{ text: PHRASE }]);
    expect(open("[]", "join-pending")).toBe("[]");
    expect(code(() => open(sealed, "another-file"))).toBe("store_key_mismatch");
    configureSealing({ key: null });
    expect(seal("[]", "join-pending")).toBe("[]");
    expect(code(() => open(sealed, "join-pending"))).toBe("store_key_missing");
  });
});

describe("review fixes", () => {
  it("seals registration details inside args.instruction and split names, and retention drops them", () => {
    const s = openStream(root, S, { writer: true });
    s.append("action.proposed", { action_id: "a-2", args: { instruction: `Register Adaeze Okon, phone ${PHONE}`, surname: "Okon", other_names: "Adaeze Ngozi" } }, Z);
    expect(disk()).not.toMatch(/Okon|Adaeze|Ngozi|0803/);
    expect((readStream(root, S)[0]!.payload as { args: { other_names: string } }).args.other_names).toBe("Adaeze Ngozi");
    expect(s.retain()).toEqual({ fields: 3 });
    s.close();
    expect((readStream(root, S)[0]!.payload as { args: { instruction: string } }).args.instruction).toBe("");
  });

  it("refuses a keyed start over a plaintext journal until the chain-verified migration seals it", () => {
    configureSealing({ key: null });
    writeTask();
    configureSealing({ key: KEY });
    expect(code(() => openStream(root, S, { writer: true }))).toBe("store_unsealed");
    expect(readStream(root, S).length).toBe(4);
    const m = openStream(root, S, { writer: true, allowPlain: true });
    expect(m.sealPlain()).toEqual({ lines: 3 });
    m.close();
    const text = disk();
    for (const w of [PHRASE, "Adaeze", PHONE]) expect(text).not.toContain(w);
    expect(text).toContain("store.sealed");
    expect(verifyChain(openStream(root, S, { keepSealed: true }).sealedRecords())).toEqual({ ok: true });
    expect((readStream(root, S)[1]!.payload as { text: string }).text).toBe(PHRASE);
    const w = openStream(root, S, { writer: true });
    w.close();
  });
});
