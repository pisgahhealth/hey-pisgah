import { readFileSync } from "node:fs";
import { z } from "zod";
import { Operation } from "@hey-pisgah/contracts";
import { Schedule } from "./world.js";

const read = (rel: string): unknown => JSON.parse(readFileSync(new URL(`../fixtures/${rel}`, import.meta.url), "utf8"));

// The hand case with its expected result on the definition executor.
export const HandCase = z.strictObject({
  note: z.string().max(300),
  schedule: Schedule,
  g2: z.strictObject({
    executor: z.literal("definition"),
    preparer: z.enum(["staff", "agent"]),
    ops: z.array(Operation).min(1),
    expected: z.strictObject({ v1_wait_min: z.number().int(), changed_wait_min: z.number().int(), cut_min: z.number().int(), min_cut: z.number().int() })
  })
});
export const GoldenHashes = z.strictObject({
  engine: z.string(),
  runs: z.record(z.string(), z.strictObject({ fixture: z.string(), events_hash: z.string().regex(/^[0-9a-f]{64}$/), post_signoff_wait_min: z.number().int().nullable(), terminal_state: z.string() }))
});

export const loadHandCase = () => HandCase.parse(read("hand/f1.json"));
export const loadGoldenSchedule = (fixture: string) => Schedule.parse((read(fixture) as { schedule: unknown }).schedule);
export const loadGoldenHashes = () => GoldenHashes.parse(read("golden/hashes.json"));
