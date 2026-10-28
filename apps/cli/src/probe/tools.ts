import { z } from "zod";

export const WARDS = ["Ward A", "Ward B", "Maternity", "Paediatrics", "Surgical"] as const;

export const ARGS = {
  get_case_state: z.strictObject({ case_id: z.string().regex(/^C-\d{3}$/).describe("Case id such as C-104") }),
  get_ward_requirements: z.strictObject({
    ward: z.enum(WARDS).describe("Ward name exactly as listed"),
    kind: z.enum(["discharge", "transfer", "admission"]).describe("Which requirement list to read")
  }),
  compute_intervals: z.strictObject({
    start: z.iso.datetime({ offset: true }).describe("ISO 8601 date-time with offset, e.g. 2026-10-28T09:15:00+01:00"),
    end: z.iso.datetime({ offset: true }).describe("ISO 8601 date-time with offset"),
    unit: z.enum(["minutes", "hours"])
  })
} as const;
export type ToolName = keyof typeof ARGS;

const DESCRIPTIONS: Record<ToolName, string> = {
  get_case_state: "Read the current state of one discharge case.",
  get_ward_requirements: "Read the current requirements a ward sets for discharge, transfer or admission.",
  compute_intervals: "Compute the time between two instants in minutes or hours."
};

// Builds OpenAI tool definitions from the same zod schemas used to validate the replies.
export function toolDefs(names: ToolName[] = Object.keys(ARGS) as ToolName[]) {
  return names.map((name) => {
    const { $schema: _drop, ...parameters } = z.toJSONSchema(ARGS[name]) as Record<string, unknown>;
    return { type: "function" as const, function: { name, description: DESCRIPTIONS[name], parameters } };
  });
}

export type CallVerdict = { valid: boolean; reason: string | null; name: string | null; calls: number };

// Judges one reply: exactly the declared schema for every tool call, and at least one call.
export function judgeToolCalls(toolCalls: unknown): CallVerdict {
  const calls = Array.isArray(toolCalls) ? toolCalls : [];
  if (!calls.length) return { valid: false, reason: "no_tool_call", name: null, calls: 0 };
  for (const c of calls) {
    const name = c?.function?.name as string | undefined;
    if (!name || !(name in ARGS)) return { valid: false, reason: `unknown_tool:${String(name)}`, name: name ?? null, calls: calls.length };
    let args: unknown;
    try { args = JSON.parse(c.function.arguments ?? ""); } catch { return { valid: false, reason: "args_not_json", name, calls: calls.length }; }
    const r = ARGS[name as ToolName].safeParse(args);
    if (!r.success) return { valid: false, reason: `schema:${r.error.issues.map((i) => i.path.join(".") || i.code).join(",")}`, name, calls: calls.length };
  }
  return { valid: true, reason: null, name: calls[0]?.function?.name ?? null, calls: calls.length };
}

// Thirty one-tool prompts, ten per tool, varied in phrasing and in how much the model must convert.
export const SUITE: { expect: ToolName; prompt: string }[] = [
  { expect: "get_case_state", prompt: "What is the current state of case C-104?" },
  { expect: "get_case_state", prompt: "Pull up case C-007 for me." },
  { expect: "get_case_state", prompt: "Is the discharge for case number 215 still blocked? Case ids look like C-215." },
  { expect: "get_case_state", prompt: "Check on C-330, the patient in bed 4." },
  { expect: "get_case_state", prompt: "Where are we with case C-911?" },
  { expect: "get_case_state", prompt: "Nurse asks: has pharmacy finished for case C-042?" },
  { expect: "get_case_state", prompt: "Give me the status of discharge case C-588 before handover." },
  { expect: "get_case_state", prompt: "Case C-120: anything outstanding?" },
  { expect: "get_case_state", prompt: "Look at case one hundred and two (C-102) and tell me what it is waiting for." },
  { expect: "get_case_state", prompt: "The family of the patient on case C-777 is asking when they can go home. Check the case." },
  { expect: "get_ward_requirements", prompt: "What does Ward A need before a discharge?" },
  { expect: "get_ward_requirements", prompt: "List Maternity's transfer requirements." },
  { expect: "get_ward_requirements", prompt: "Before we admit to Paediatrics, what do they require?" },
  { expect: "get_ward_requirements", prompt: "Surgical ward discharge checklist, please." },
  { expect: "get_ward_requirements", prompt: "Did Ward B change what they want for transfers?" },
  { expect: "get_ward_requirements", prompt: "What are the current admission rules on Ward A?" },
  { expect: "get_ward_requirements", prompt: "We are sending a mother home from Maternity. What must be done first?" },
  { expect: "get_ward_requirements", prompt: "Read me the discharge requirements for the children's ward (Paediatrics)." },
  { expect: "get_ward_requirements", prompt: "Moving a patient into Surgical from A and E: what does Surgical require on admission?" },
  { expect: "get_ward_requirements", prompt: "Ward B discharge requirements as of today." },
  { expect: "compute_intervals", prompt: "How many minutes between 2026-10-28T09:15:00+01:00 and 2026-10-28T11:40:00+01:00?" },
  { expect: "compute_intervals", prompt: "The bill was raised at 08:00 UTC on 27 Oct 2026 and paid at 14:30 UTC the same day. How many hours did payment take?" },
  { expect: "compute_intervals", prompt: "Discharge was ordered at 2026-10-26T10:00:00Z and the patient left at 2026-10-26T16:45:00Z. Interval in minutes?" },
  { expect: "compute_intervals", prompt: "In hours, how long from 2026-10-25T22:00:00+01:00 to 2026-10-26T07:30:00+01:00?" },
  { expect: "compute_intervals", prompt: "Pharmacy got the prescription at 13:05 West Africa Time (UTC+1) on 28 October 2026 and released it at 13:52 the same day. Minutes?" },
  { expect: "compute_intervals", prompt: "Compute the gap in minutes between 2026-10-28T23:50:00Z and 2026-10-29T00:20:00Z." },
  { expect: "compute_intervals", prompt: "How many hours between noon UTC on 1 Nov 2026 and 06:00 UTC on 2 Nov 2026?" },
  { expect: "compute_intervals", prompt: "Lab result requested 2026-10-27T07:10:00+01:00, returned 2026-10-27T09:55:00+01:00. Turnaround in minutes." },
  { expect: "compute_intervals", prompt: "From 2026-10-30T18:00:00Z until 2026-10-31T09:00:00Z, in hours." },
  { expect: "compute_intervals", prompt: "Nurse sign-off at 2026-10-28T15:20:00+01:00, doctor sign-off at 2026-10-28T16:05:00+01:00. Minutes between them?" }
];

export const SUITE_SYSTEM = "You are a hospital discharge assistant. Answer every request by calling exactly one tool with arguments that match its schema. Do not answer in text.";
