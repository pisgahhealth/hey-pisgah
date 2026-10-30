import { z } from "zod";
import { callStructured, type ChatTool, type EffortLevel, type ModelClient, type ProviderId } from "@hey-pisgah/model";
import { denyScan, type DenyHit } from "../deny.js";
import type { Fact } from "./facts.js";
import type { Finding, Investigation, Proposed } from "./memo.js";

// One investigator per department reads only that department's computed facts and the ward's; it never sees names, words or the other answers.
export const INVESTIGATOR_SYSTEM = [
  "You review one hospital department's day from recorded facts only. Each fact has an id, a figure and the events it was computed from.",
  "Give at most two suspected causes for what the figures show, each citing the fact ids it rests on, and at most two proposed changes, each with a scope (department, ward or hospital) and the fact ids it rests on.",
  "A suspected cause is a hypothesis, not a finding. Use only figures that appear in the facts you cite. If nothing in the facts warrants a change, say so and propose none.",
  "Never name a patient or a person; refer to roles."
].join("\n");
export const CRITIC_SYSTEM = [
  "You are another department's reviewer. You see one department's suspected causes and the facts they cite.",
  "For each cause, say whether the cited facts support it (holds) or not (challenged), with a one-sentence reason grounded in the figures. Do not add causes."
].join("\n");

const Out = z.strictObject({
  causes: z.array(z.strictObject({ text: z.string().min(1).max(300), cites: z.array(z.string()).min(1).max(4) })).max(2),
  changes: z.array(z.strictObject({ text: z.string().min(1).max(300), cites: z.array(z.string()).min(1).max(4), scope: z.enum(["department", "ward", "hospital"]) })).max(2),
  nothing_warrants_change: z.boolean()
});
const Critique = z.strictObject({ verdicts: z.array(z.strictObject({ index: z.number().int().min(0).max(5), verdict: z.enum(["holds", "challenged"]), reason: z.string().min(1).max(240) })).max(6) });
const tool = (name: string, description: string, schema: z.ZodType): ChatTool => {
  const { $schema: _d, ...parameters } = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  return { type: "function", function: { name, description, parameters } };
};
export const INVESTIGATE_TOOL = tool("report_department", "Report suspected causes and proposed changes for one department, each citing fact ids.", Out);
export const CRITIC_TOOL = tool("review_causes", "Say for each suspected cause whether its cited facts support it.", Critique);

export type NightModel = { client: ModelClient; provider: ProviderId; model: string; effort: EffortLevel; run_id: string };
const factLines = (fs: readonly Fact[]) => fs.map((f) => `- ${f.fact_id}: ${f.text} (figure ${f.value})`).join("\n");
export const investigatorMessage = (department: string, fs: readonly Fact[]) => `Department: ${department.replace(/_/g, " ")}\nRecorded facts:\n${factLines(fs)}`;
export const criticMessage = (department: string, causes: readonly Finding[], fs: readonly Fact[]) => `Department reviewed: ${department.replace(/_/g, " ")}\nSuspected causes:\n${causes.map((c, i) => `${i}. ${c.text} (cites ${c.cites.join(", ")})`).join("\n")}\nFacts cited:\n${factLines(fs.filter((f) => causes.some((c) => c.cites.includes(f.fact_id))))}`;

// The deny-list scan over every prompt and tool text the investigators and critics receive, so no prompt points at an answer.
export function scanNightPrompts(messages: readonly string[]): DenyHit[] {
  return denyScan([{ label: "investigator_system", text: INVESTIGATOR_SYSTEM }, { label: "critic_system", text: CRITIC_SYSTEM }, { label: "tools", text: JSON.stringify([INVESTIGATE_TOOL, CRITIC_TOOL]) }, ...messages.map((text, i) => ({ label: `message_${i}`, text }))]);
}

// One investigator per department, then a critic round in which each department's causes are reviewed by the next department's reviewer.
export async function investigateDay(facts: readonly Fact[], m: NightModel): Promise<{ investigations: Investigation[]; prompts: string[]; calls: number; cost_usd: number }> {
  const depts = [...new Set(facts.map((f) => f.department).filter((d) => d !== "ward"))].sort();
  const prompts: string[] = [];
  let calls = 0, cost = 0;
  const call = async <S extends z.ZodType>(schema: S, system: string, user: string, t: ChatTool, toolName: string, purpose: string) => {
    prompts.push(user);
    const r = await callStructured(m.client, schema, { provider: m.provider, model: m.model, effort: m.effort, messages: [{ role: "system", content: system }, { role: "user", content: user }], tools: [t], parallel_tool_calls: false, purpose, run_id: m.run_id, task_id: null, task_state: null, thread: "main", affinity_key: m.run_id }, { maxRepairs: 1, toolName });
    calls += 1 + r.repairs;
    cost += r.result.row.cost_usd;
    return r.value as z.infer<S>;
  };
  const out: Investigation[] = [];
  for (const d of depts) {
    const fs = facts.filter((f) => f.department === d || f.department === "ward");
    const v = await call(Out, INVESTIGATOR_SYSTEM, investigatorMessage(d, fs), INVESTIGATE_TOOL, "report_department", "draft_text");
    const causes: Finding[] = v.causes.map((c, i) => ({ finding_id: `sc-${d}-${i + 1}`, department: d, text: c.text, cites: c.cites, critic: null }));
    const changes: Proposed[] = v.changes.map((c, i) => ({ finding_id: `pc-${d}-${i + 1}`, department: d, text: c.text, cites: c.cites, scope: c.scope, critic: null }));
    out.push({ department: d, causes, changes, nothing_warrants_change: v.nothing_warrants_change && !changes.length, model: m.model, calls: 0, cost_usd: 0 });
  }
  for (const [i, inv] of out.entries()) {
    if (!inv.causes.length || out.length < 2) continue;
    const by = out[(i + 1) % out.length]!.department;
    const v = await call(Critique, CRITIC_SYSTEM, criticMessage(inv.department, inv.causes, facts), CRITIC_TOOL, "review_causes", "other");
    for (const x of v.verdicts) { const c = inv.causes[x.index]; if (c) c.critic = { by, verdict: x.verdict, reason: x.reason }; }
  }
  return { investigations: out, prompts, calls, cost_usd: Math.round(cost * 1e6) / 1e6 };
}
