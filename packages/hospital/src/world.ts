import { readFileSync } from "node:fs";
import { z } from "zod";
import { ActionKind, DocumentId, RecordKind, Stage, hashJson } from "@hey-pisgah/contracts";
import type { ServiceQuery, WorldRules } from "@hey-pisgah/simulator";

const Tag = z.enum(["observed", "assumed"]);

// World parameters frozen at day-2; each base value and world rule says whether it was observed on a ward or assumed.
export const WorldParameters = z.strictObject({
  frozen_at: z.literal("day-2"),
  draft_verification_by_nurse: z.strictObject({ on: z.boolean(), minutes: z.number().int().min(0), tag: Tag }),
  draft_use_by_staff: z.strictObject({ p: z.number().min(0).max(1), tag: Tag }),
  agent_prepare_min: z.strictObject({ minutes: z.number().int().min(1), tag: Tag }),
  base: z.array(z.strictObject({ name: z.string().regex(/^[a-z_]+$/), min: z.number(), max: z.number(), unit: z.enum(["minute_of_day", "minutes", "minutes_after_signoff", "count", "share"]), tag: Tag, note: z.string().max(200) })),
  flow_order: z.strictObject({ text: z.string().max(300), tag: Tag }),
  world_rules: z.strictObject({
    nurse_window: z.strictObject({ text: z.string().max(300), tag: Tag }),
    summary_check: z.strictObject({
      action_kind: ActionKind, document_id: DocumentId, stage: Stage, seen_while_pending: RecordKind,
      min_seen: z.number().int().min(0), min_unseen: z.number().int().min(0), text: z.string().max(300), tag: Tag
    })
  })
});
export type WorldParameters = z.infer<typeof WorldParameters>;

export const loadWorldParameters = (): WorldParameters => WorldParameters.parse(JSON.parse(readFileSync(new URL("./data/parameters.json", import.meta.url), "utf8")));

type Payload = Record<string, unknown> | null;

// The summary check is quick when the nurse saw a draft while the record it waits for was still missing.
export function summaryCheckMin(rule: WorldParameters["world_rules"]["summary_check"], q: ServiceQuery): number | undefined {
  if (q.action_kind !== rule.action_kind || q.document_id !== rule.document_id || q.stage !== rule.stage) return undefined;
  const pendingUntil = q.events.find((e) => e.kind === "record.versioned" && e.subject === rule.seen_while_pending)?.occurred_at ?? Infinity;
  const seen = q.events.some((e) => {
    const p = e.payload as Payload;
    if (p?.["document_id"] !== rule.document_id || p["stage"] !== "draft" || e.occurred_at >= pendingUntil) return false;
    return e.kind === "check.verified" || (e.kind === "step.completed" && e.actor_role === "nurse");
  });
  return seen ? rule.min_seen : rule.min_unseen;
}

// The world rules handed to the simulator; the hash covers the rule data so a change shows in every run's rules_hash.
export function worldRules(p: WorldParameters = loadWorldParameters()): WorldRules {
  return { rules_hash: hashJson(p.world_rules), service_min: (q) => summaryCheckMin(p.world_rules.summary_check, q) };
}
