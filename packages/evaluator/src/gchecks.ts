import type { GeneratedCase } from "@hey-pisgah/cases";
import { g1, g2, g3, g4, g5, type Checked } from "@hey-pisgah/cases/checks";
import { scheduleHash } from "@hey-pisgah/simulator";
import { reservedCasesInMemory } from "./reserved.js";

export type GStatus = "pass" | "fail" | "n/a";
export type GLine = { id: "G1" | "G2" | "G3" | "G4" | "G5" | "G6"; status: GStatus };

// A check that throws counts as a failure; the error text is dropped because it may name a case.
const safe = (f: () => boolean | "n/a"): GStatus => { try { const r = f(); return r === "n/a" ? "n/a" : r ? "pass" : "fail"; } catch { return "fail"; } };

// G1 to G6 on a generated set; G6 regenerates the set and compares every schedule hash with its manifest and the first draw.
export function runGChecks(cases: readonly GeneratedCase[], regenerate?: () => readonly GeneratedCase[]): GLine[] {
  const checked: Checked[] = cases.map((c) => ({ schedule: c.schedule, manifest: c.manifest, texts: { schedule: c.schedule, initial_state: c.initial_state, infra_fault: c.infra_fault } }));
  const hashes = cases.map((c) => scheduleHash(c.schedule));
  return [
    { id: "G1", status: safe(() => g1(checked).pass) },
    { id: "G2", status: safe(() => g2(checked).pass) },
    { id: "G3", status: safe(() => { const r = g3(checked); return r.applicable ? r.pass : "n/a"; }) },
    { id: "G4", status: safe(() => g4(checked).pass) },
    { id: "G5", status: safe(() => g5(checked).pass) },
    { id: "G6", status: safe(() => cases.length > 0 && cases.every((c, i) => hashes[i] === c.manifest.schedule_hash) && (!regenerate || regenerate().map((c) => scheduleHash(c.schedule)).join() === hashes.join())) }
  ];
}

// The sealed command: generates the set in memory and prints pass or fail per check, nothing else.
export function checkG(argv: readonly string[], print: (line: string) => void = console.log, generate: (set: "reserved" | "spare") => readonly GeneratedCase[] = reservedCasesInMemory): number {
  const i = argv.indexOf("--set");
  const set = i >= 0 ? argv[i + 1] : "reserved";
  if (set !== "reserved" && set !== "spare") { print("check:g fail"); return 2; }
  let lines: GLine[];
  try {
    lines = runGChecks(generate(set), () => generate(set));
  } catch {
    print("check:g fail");
    return 1;
  }
  for (const l of lines) print(`${l.id} ${l.status}`);
  const pass = lines.every((l) => l.status !== "fail");
  print(`check:g ${pass ? "pass" : "fail"}`);
  return pass ? 0 : 1;
}
