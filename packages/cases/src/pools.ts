import { sha256 } from "@hey-pisgah/contracts";
import type { Family, InfraFault, Overlay, Payer, Pool, Ward } from "./types.js";

// The one committed seed rule, shared by every arm: a pool's i-th seed is sha256 of this prefix, the pool name and i.
export const SEED_RULE = "hey-pisgah|seed-rule-1";
export const seedFor = (pool: Pool, index: number): string => sha256(`${SEED_RULE}|${pool}|${index}`);

export type CaseSpec = {
  family: Family; ward: Ward; payer: Payer; overlays?: Overlay[];
  infra_fault?: Omit<InfraFault, "from_min" | "to_min"> & { from_after_signoff: number; length_min: number };
};

const c = (family: Family, ward: Ward, payer: Payer = "self_pay", extra: Partial<CaseSpec> = {}): CaseSpec => ({ family, ward, payer, ...extra });

export const POOL_SPECS: Record<"discovery" | "dev" | "dev_held" | "variation" | "demo", CaseSpec[]> = {
  discovery: [
    c("F1", "A"), c("F1", "A"), c("F1", "A"), c("F7", "A"), c("F7", "B"), c("F2", "A"),
    c("F3", "B"), c("F4", "C"), c("F5", "A", "hmo"), c("F6", "A"), c("F8", "C", "corporate"), c("F9", "A")
  ],
  dev: [
    c("F1", "A"),
    c("F1", "A", "self_pay", { infra_fault: { kind: "write_ack_lost", target: "prepare_document discharge_summary final", from_after_signoff: 0, length_min: 30 } }),
    c("F1", "B"),
    c("F2", "A", "self_pay", { overlays: ["F11"] }),
    c("F2", "B", "self_pay", { infra_fault: { kind: "write_dropped", target: "hand_over_document discharge_summary final", from_after_signoff: 0, length_min: 240 } }),
    c("F3", "A"), c("F3", "C"), c("F4", "A"),
    c("F5", "A", "hmo", { infra_fault: { kind: "read_unavailable", target: "get_record hmo_claim_cover", from_after_signoff: 10, length_min: 40 } }),
    c("F6", "A"),
    c("F8", "A", "self_pay", { infra_fault: { kind: "event_delivery_late", target: "step.completed record_departure", from_after_signoff: 30, length_min: 120 } }),
    c("F9", "A"), c("F9", "B"), c("F10", "A"), c("F12", "A")
  ],
  dev_held: [
    c("F1", "A"), c("F1", "A"), c("F2", "A"), c("F3", "A"), c("F4", "A"), c("F5", "A", "hmo"), c("F6", "A"), c("F8", "C"), c("F9", "A"), c("F10", "A")
  ],
  variation: [c("FV", "B"), c("FV", "B", "hmo")],
  demo: [c("F1", "A"), c("FV", "B")]
};

// Which dev and demo cases the reliability reruns use; none carries an infrastructure fault.
export const FR4_SUBSET = { dev: [0, 7, 11, 14], demo: [0, 1] } as const;
// Folder each pool is committed under.
export const POOL_DIR: Record<keyof typeof POOL_SPECS, string> = { discovery: "discovery", dev: "dev", dev_held: "dev/held", variation: "variation", demo: "demo" };
