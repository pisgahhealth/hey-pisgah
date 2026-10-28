import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tempRoot } from "./helpers.js";

const tsx = fileURLToPath(new URL("../../../node_modules/.bin/tsx", import.meta.url));
const child = fileURLToPath(new URL("./kill-child.ts", import.meta.url));
type Out = { hits: Record<string, number>; final: { actions: { state: string; effective_writes: number }[] } & Record<string, unknown>; resumedByWake: Record<string, number> };

function run(root: string, spec: string): Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(tsx, [child, root, spec], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    p.on("error", reject);
    p.on("close", (code, signal) => resolve({ code, signal, out }));
  });
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(Array.from({ length: n }, async () => { for (let x = queue.shift(); x !== undefined; x = queue.shift()) await fn(x); }));
}

describe("kill -9 at every boundary on a store-backed port", () => {
  it("restart gives one effective write per action, the same final state, and each wake fires once", async () => {
    const base = await run(tempRoot(), "none");
    expect(base.code).toBe(0);
    const b = JSON.parse(base.out) as Out;
    expect(b.final["state"]).toBe("done");
    const specs = Object.entries(b.hits).flatMap(([name, n]) => Array.from({ length: n }, (_x, i) => `${name}:${i + 1}`));
    expect(specs.length).toBeGreaterThan(40);
    const failures: string[] = [];
    await pool(specs, 8, async (spec) => {
      const root = tempRoot();
      const crashed = await run(root, spec);
      // The tsx wrapper reports its child's SIGKILL as exit code 137.
      if (crashed.signal !== "SIGKILL" && crashed.code !== 137) { failures.push(`${spec}: did not die (${crashed.code})`); return; }
      const again = await run(root, "none");
      if (again.code !== 0) { failures.push(`${spec}: restart exited ${again.code}`); return; }
      const r = JSON.parse(again.out) as Out;
      if (JSON.stringify(r.final) !== JSON.stringify(b.final)) failures.push(`${spec}: final state differs`);
      if (r.final.actions.some((a) => a.state === "completed" && a.effective_writes !== 1)) failures.push(`${spec}: an action has ${r.final.actions.map((a) => a.effective_writes).join(",")} writes`);
      if (Object.values(r.resumedByWake).some((n) => n !== 1)) failures.push(`${spec}: a wake resumed more than once`);
      if (JSON.stringify(Object.keys(r.resumedByWake).sort()) !== JSON.stringify(Object.keys(b.resumedByWake).sort())) failures.push(`${spec}: the wakes that fired differ`);
    });
    expect(failures).toEqual([]);
  }, 600_000);
});
