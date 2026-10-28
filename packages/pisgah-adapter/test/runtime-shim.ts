import { EmrRuntime } from "@hey-pisgah/agent";
import { ModelClient, type ChatCompletion } from "@hey-pisgah/model";

export { EmrRuntime };

// A mock model for adapter tests: it records the pulse and blood pressure it hears.
export function ModelClientLike(root: string, rt: () => EmrRuntime | null): ModelClient {
  return new ModelClient({
    storeRoot: root, mode: "mock", taskStateOf: (id) => rt()?.stateOf(id) ?? null,
    mock: ({ body, hash }) => {
      const user = String((body["messages"] as { role: string; content: string }[]).find((m) => m.role === "user")?.content ?? "");
      const pulse = Number(/pulse (\d+)/.exec(user)?.[1] ?? 0);
      const bp = /pressure (\d+\/\d+)/.exec(user)?.[1] ?? null;
      const c: ChatCompletion = {
        id: `mock-${hash.slice(0, 8)}`, object: "chat.completion", created: 0, model: String(body["model"]),
        choices: [{ index: 0, finish_reason: "tool_calls", logprobs: null, message: { role: "assistant", content: null, refusal: null, tool_calls: [{ id: "c1", type: "function", function: { name: "decide", arguments: JSON.stringify({ decision: "record", pulse, bp, summary: "Record" }) } }] } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      };
      return c;
    }
  });
}
