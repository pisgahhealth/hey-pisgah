import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { LedgerRow } from "@hey-pisgah/contracts";

export type Budget = { runUsd: number; runMaxCalls: number; weekUsd: number; weekStopFraction: number; weekSince: () => Date };

const num = (v: string | undefined, d: number) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);

// Budget figures come from the run's environment, not the keys file; the week stop is 80% of the week total.
export function budgetFromEnv(env: NodeJS.ProcessEnv = process.env): Budget {
  return {
    runUsd: num(env.HEY_PISGAH_BUDGET_USD, 5),
    runMaxCalls: num(env.HEY_PISGAH_MAX_CALLS, 200),
    weekUsd: num(env.HEY_PISGAH_WEEK_USD, 120),
    weekStopFraction: 0.8,
    weekSince: () => (env.HEY_PISGAH_WEEK_SINCE ? new Date(env.HEY_PISGAH_WEEK_SINCE) : new Date(Date.now() - 7 * 24 * 3600 * 1000))
  };
}

// Reads model.call envelopes and bare ledger rows alike, so the probe's ledger counts toward the week.
export function ledgerRowsIn(file: string): LedgerRow[] {
  if (!existsSync(file)) return [];
  const text = readFileSync(file, "utf8");
  const end = text.lastIndexOf("\n");
  const rows: LedgerRow[] = [];
  for (const line of text.slice(0, end + 1).split("\n")) {
    if (!line) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const candidate = o && typeof o === "object" && "record_type" in o ? (o.record_type === "model.call" ? o.payload : null) : o;
    const r = LedgerRow.safeParse(candidate);
    if (r.success) rows.push(r.data);
  }
  return rows;
}

export function weekSpendUsd(ledgerDir: string, since: Date): number {
  if (!existsSync(ledgerDir)) return 0;
  let sum = 0;
  for (const f of readdirSync(ledgerDir)) {
    if (!f.endsWith(".jsonl")) continue;
    for (const r of ledgerRowsIn(join(ledgerDir, f))) if (new Date(r.at_wall) >= since) sum += r.cost_usd;
  }
  return sum;
}
