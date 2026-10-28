import { readFileSync } from "node:fs";
import { z } from "zod";
import { ExternalSchedule } from "@hey-pisgah/simulator";

const read = (rel: string): unknown => JSON.parse(readFileSync(new URL(`../fixtures/${rel}`, import.meta.url), "utf8"));
const Arm = z.strictObject({ v1_wait_min: z.number().int(), changed_wait_min: z.number().int(), cut_min: z.number().int() });

// The hand case with its expected G2 result on the definition executor, for both who-prepares settings.
export const HandCase = z.strictObject({
  note: z.string().max(300),
  schedule: ExternalSchedule,
  g2: z.strictObject({
    executor: z.literal("definition"),
    ops: z.array(z.unknown()).min(1),
    edge_only_ops: z.array(z.unknown()).min(1),
    after_order_ops: z.array(z.unknown()).min(1),
    expected: z.strictObject({ agent: Arm, staff: Arm, min_cut_agent: z.number().int(), edge_only_cut: z.number().int(), min_control_wait: z.number().int() })
  })
});
export type HandCase = z.infer<typeof HandCase>;
export const GoldenHashes = z.strictObject({
  engine: z.string(),
  runs: z.record(z.string(), z.strictObject({ fixture: z.string(), events_hash: z.string().regex(/^[0-9a-f]{64}$/), post_signoff_wait_min: z.number().int().nullable(), terminal_state: z.string() }))
});

export const loadHandCase = (): HandCase => HandCase.parse(read("hand/f1.json"));
export const loadGoldenSchedule = (fixture: string): ExternalSchedule => ExternalSchedule.parse((read(fixture) as { schedule: unknown }).schedule);
export const loadGoldenHashes = () => GoldenHashes.parse(read("golden/hashes.json"));
