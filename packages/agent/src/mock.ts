import type { ChatCompletion, MockResponder } from "@hey-pisgah/model";

type Msg = { role: string; content?: unknown; tool_calls?: { id: string; function: { name: string; arguments: string } }[] };
type Doc = { document_id: string; stage: string; required: boolean; status: string; ready: boolean };
type State = { now: number; documents: Doc[]; agent_writes: { action_kind: string; args: Record<string, unknown> }[] };

export type ScriptOptions = {
  // Send one document_ready message after each complete final, which gives crash tests a write the port cannot deduplicate.
  notify?: boolean;
  // Wait with wait_until and this many minutes of deadline instead of ending the turn.
  waitMinutes?: number;
  // Claim completion at once, to exercise the completion guard.
  liar?: boolean;
  // Calls made one per turn at the start of the first tick, to exercise refusals.
  forbidden?: { name: string; args: Record<string, unknown> }[];
  // Document stages, as document_id.stage, the script never prepares.
  skip?: string[];
  // Ask for two tools in one turn on the first turn, to check that results come back in call order.
  pairFirst?: boolean;
};

function completion(hash: string, model: string, message: ChatCompletion["choices"][number]["message"], finish: "tool_calls" | "stop"): ChatCompletion {
  return {
    id: `mock-${hash.slice(0, 12)}`, object: "chat.completion", created: 0, model,
    choices: [{ index: 0, message, finish_reason: finish, logprobs: null }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  };
}

// A deterministic stand-in for the model: it reads the case, prepares whatever is ready, and otherwise ends its turn.
export function scriptedAgent(opts: ScriptOptions = {}): MockResponder {
  return ({ body, hash }) => {
    const msgs = body["messages"] as Msg[];
    const model = String(body["model"]);
    const user = String(msgs.find((m) => m.role === "user")?.content ?? "");
    const caseId = /case (c-[a-z0-9]{8})/.exec(user)?.[1] ?? "c-unknown0";
    const turn = msgs.filter((m) => m.role === "assistant").length;
    const call = (name: string, args: Record<string, unknown>) =>
      completion(hash, model, { role: "assistant", content: null, refusal: null, tool_calls: [{ id: `call_${turn}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, "tool_calls");
    const say = (text: string) => completion(hash, model, { role: "assistant", content: text, refusal: null }, "stop");
    const last = msgs.at(-1)!;
    const forbidden = opts.forbidden ?? [];
    const firstTick = /Why this turn: the task was just opened/.test(user);
    if (firstTick && turn === 0 && opts.liar) return call("finish_task", { summary: "All paperwork is complete." });
    if (firstTick && turn < forbidden.length) return call(forbidden[turn]!.name, forbidden[turn]!.args);
    if (firstTick && turn === 0 && opts.pairFirst) {
      return completion(hash, model, { role: "assistant", content: null, refusal: null, tool_calls: [
        { id: "call_0a", type: "function", function: { name: "get_ward_requirements", arguments: JSON.stringify({ case_id: caseId }) } },
        { id: "call_0b", type: "function", function: { name: "get_workflow_definition", arguments: JSON.stringify({ case_id: caseId }) } }
      ] }, "tool_calls");
    }
    if (last.role !== "tool") return call("get_case_state", { case_id: caseId });
    const prev = [...msgs].reverse().find((m) => m.role === "assistant" && m.tool_calls?.length);
    const prevName = prev?.tool_calls?.[0]?.function.name;
    const res = JSON.parse(String(last.content)) as { ok: boolean; state?: State };
    if (prevName !== "get_case_state" || !res.ok || !res.state) return call("get_case_state", { case_id: caseId });
    const st = res.state;
    const ready = st.documents.find((d) => d.ready && !(opts.skip ?? []).includes(`${d.document_id}.${d.stage}`));
    if (ready) return call("prepare_document", { case_id: caseId, document_id: ready.document_id, stage: ready.stage });
    if (opts.notify) {
      const sent = new Set(st.agent_writes.filter((w) => w.action_kind === "send_staff_message").map((w) => `${String(w.args["document_id"])}.${String(w.args["stage"])}`));
      const fin = st.documents.find((d) => d.stage === "final" && d.status === "complete" && !sent.has(`${d.document_id}.final`));
      if (fin) return call("send_staff_message", { case_id: caseId, role: "nurse", template_id: "document_ready", document_id: fin.document_id, stage: "final" });
    }
    const required = st.documents.filter((d) => d.required);
    if (required.length && required.every((d) => d.status === "complete")) return call("finish_task", { summary: "Every required document stage is complete." });
    if (opts.waitMinutes) return call("wait_until", { deadline_simulated_min: Math.min(st.now + opts.waitMinutes, 2880) });
    return say("Nothing more can be done until the record changes.");
  };
}
