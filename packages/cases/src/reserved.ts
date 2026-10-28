import { readFileSync, writeFileSync } from "node:fs";
import { hashJson } from "@hey-pisgah/contracts";
import { generateCase } from "./generate.js";
import { seedFor, type CaseSpec } from "./pools.js";
import type { NamePool } from "./text.js";
import type { GeneratedCase } from "./types.js";

// Sealed: only the evaluator imports this module, and reserved cases exist only in the memory of the one reserved run.
const c = (family: CaseSpec["family"], ward: CaseSpec["ward"], payer: CaseSpec["payer"] = "self_pay", overlays?: CaseSpec["overlays"]): CaseSpec =>
  ({ family, ward, payer, ...(overlays ? { overlays } : {}) });

const RESERVED: CaseSpec[] = [
  c("F1", "A"), c("F1", "A"), c("F1", "A"), c("F1", "B"),
  c("F2", "A", "self_pay", ["F11"]), c("F2", "A"), c("F2", "B"),
  c("F3", "A"), c("F3", "B"), c("F3", "C"),
  c("F4", "A", "self_pay", ["F12"]), c("F4", "C"),
  c("F5", "A", "hmo"), c("F5", "B", "hmo"),
  c("F6", "A", "self_pay", ["F11"]), c("F6", "A"),
  c("F8", "C"), c("F8", "A"),
  c("F9", "A"), c("F9", "B"),
  c("F10", "A"), c("F10", "A"),
  c("FV", "B"), c("FV", "B"), c("FV", "B", "hmo")
];
const SPARE: CaseSpec[] = [
  c("F1", "A"), c("F2", "A"), c("F3", "A"), c("F4", "A"), c("F5", "A", "hmo"), c("F6", "A"), c("F8", "C"), c("F9", "A"), c("F10", "A"), c("FV", "B")
];

// Reserved patients come from their own name pool; each surname is a canary token that never appears in any other pool.
export const RESERVED_CANARIES: readonly string[] = [
  "Quorvane", "Zelmudo", "Vexandri", "Kroluwa", "Thessimbo", "Ophrandu", "Yzelko", "Brannuvex", "Calqueso", "Drimmavel",
  "Fennoquar", "Gorvalix", "Hulvendra", "Ixtamor", "Jorvequil", "Klessandu", "Lumbrevox", "Morquilan", "Nevrastho", "Olvenquar",
  "Prellumax", "Quintobar", "Rhovendil", "Sylquaro", "Tarvenquo", "Ulvessimo", "Vornakle", "Wexalundo", "Xandrevol", "Yorquemba",
  "Zandovrel", "Brexulma", "Crovandix", "Dulvaquen", "Exquoral"
];
const RESERVED_NAMES: NamePool = {
  given_female: ["Edidiong", "Iniobong", "Utibe", "Mbuotidem", "Enoabasi", "Nkoyo", "Arit", "Ime"],
  given_male: ["Ekemini", "Ofonime", "Uwem", "Ndifreke", "Abasiama", "Kufre", "Inemesit", "Otobong"],
  family: RESERVED_CANARIES
};

export type SeedEntry = { set: "reserved" | "spare"; index: number; seed: string; canary: string } & CaseSpec;

// The full reserved and spare seed list; its hash is the commitment in the evaluator's data folder.
export function seedList(): SeedEntry[] {
  const list: SeedEntry[] = [];
  RESERVED.forEach((s, i) => list.push({ set: "reserved", index: i, seed: seedFor("reserved", i), canary: RESERVED_CANARIES[i]!, ...s }));
  SPARE.forEach((s, i) => list.push({ set: "spare", index: i, seed: seedFor("spare", i), canary: RESERVED_CANARIES[RESERVED.length + i]!, ...s }));
  return list;
}
export const seedListHash = (): string => hashJson(seedList());

export class ReservedSealBroken extends Error {
  readonly code = "reserved_seal_broken";
}

// Generates the reserved or spare cases in memory, only when the committed hash file matches the seed list.
export function generateReserved(seedHashFile: string, set: "reserved" | "spare" = "reserved"): GeneratedCase[] {
  const committed = readFileSync(seedHashFile, "utf8").trim().split(/\s+/)[0] ?? "";
  if (committed !== seedListHash()) throw new ReservedSealBroken("the reserved seed list does not match its committed hash");
  return seedList().filter((e) => e.set === set).map((e) => generateCase(e.family, e.seed, e.ward, e.payer, {
    pool: set, names: RESERVED_NAMES, canary_surname: e.canary, ...(e.overlays ? { overlays: e.overlays } : {})
  }));
}

if (process.argv[1]?.endsWith("reserved.ts") && process.argv[2] === "--write-hash") {
  writeFileSync(new URL("../../evaluator/data/reserved.sha256", import.meta.url), `${seedListHash()}\n`);
}
