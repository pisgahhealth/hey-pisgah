import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hashJson, sha256, WorkflowChangeProposal } from "@hey-pisgah/contracts";
import { PROPOSALS_STREAM, runValidationStream } from "@hey-pisgah/evaluator";
import { openStream } from "@hey-pisgah/store";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

// The person making the change; the defaults disclose that a person plays the synthetic ward manager.
function requester(args: string[]) {
  return {
    kind: flag(args, "kind") ?? "person", role: flag(args, "role") ?? "ward_manager",
    staff_id: flag(args, "approver-id") ?? "wm_synthetic", display_name: flag(args, "approver-name") ?? "Synthetic ward manager (a person, disclosed)"
  };
}

// Turns a proposal file into a submitted WorkflowChangeProposal with a content-derived id.
export function submittedProposal(raw: unknown): WorkflowChangeProposal {
  const p = ((raw as { proposal?: unknown }).proposal ?? raw) as Record<string, unknown>;
  const { proposal_id: _i, hash: _h, status: _s, viewed_case_ids: _v, ...rest } = p;
  const id = typeof p["proposal_id"] === "string" ? String(p["proposal_id"]) : `p-${sha256(JSON.stringify(rest)).slice(0, 8)}`;
  const body = { proposal_id: id, ...rest, viewed_case_ids: (p["viewed_case_ids"] as string[] | undefined) ?? [], status: "submitted" as const };
  return WorkflowChangeProposal.parse({ ...body, hash: hashJson(body) });
}

async function post(url: string, body: unknown): Promise<[number, unknown]> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return [r.status, await r.json()];
}

// `version adopt --proposal-file f`, `version suspend --version n --reason r`, `version revert --version n --reason r`; each posts to a running serve.
export async function versionCommand(repoRoot: string, args: string[]): Promise<number> {
  const sub = args[0];
  const serve = flag(args, "serve") ?? `http://127.0.0.1:${process.env["HEY_PISGAH_SERVE_PORT"] ?? 4317}`;
  const store = flag(args, "store") ?? join(repoRoot, ".hey-pisgah", "store");
  const at = flag(args, "at-minute");
  const by = requester(args);
  if (sub === "adopt") {
    const file = flag(args, "proposal-file");
    let id = flag(args, "proposal");
    if (file) {
      const p = submittedProposal(JSON.parse(readFileSync(file, "utf8")));
      id = p.proposal_id;
      const s = openStream(store, PROPOSALS_STREAM, { writer: true });
      try {
        if (!s.records().some((e) => e.record_type === "proposal.submitted" && (e.payload as { hash?: string }).hash === p.hash)) s.append("proposal.submitted", p, { recorded_at: 0, occurred_at: 0 });
      } finally { s.close(); }
      const reports = await runValidationStream(store);
      for (const r of reports) process.stdout.write(`validated ${r.proposal_id}: ${r.status}\n`);
    }
    if (!id) { process.stderr.write("version adopt needs --proposal-file or --proposal\n"); return 2; }
    const [status, out] = await post(`${serve}/versions/adopt`, { proposal_id: id, approver: by, ...(at ? { at_minute: Number(at) } : {}) });
    process.stdout.write(`${JSON.stringify({ status, ...(out as object) })}\n`);
    return status === 201 ? 0 : 1;
  }
  if (sub === "suspend" || sub === "revert") {
    const v = flag(args, "version");
    const reason = flag(args, "reason");
    if (!v || !reason) { process.stderr.write(`version ${sub} needs --version and --reason\n`); return 2; }
    const ref = flag(args, "proposal");
    const proposal = ref ? { task_id: ref.split(":")[0]!, proposal_id: ref.split(":")[1] ?? "" } : undefined;
    const [status, out] = await post(`${serve}/versions/${v}/${sub}`, { by, reason, ...(at ? { at_minute: Number(at) } : {}), ...(proposal ? { proposal } : {}) });
    process.stdout.write(`${JSON.stringify({ status, ...(out as object) })}\n`);
    return status === 200 ? 0 : 1;
  }
  if (sub === "list") {
    const r = await fetch(`${serve}/versions`);
    process.stdout.write(`${JSON.stringify(await r.json(), null, 2)}\n`);
    return r.ok ? 0 : 1;
  }
  process.stderr.write("version adopt|suspend|revert|list\n");
  return 2;
}
