import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildClaims } from "../src/lib/claims.js";
import { EVAL_TABS, tabFor } from "../src/lib/evaluation.js";
import { checkHtml, claimElements, claimFragments, loadRegistry } from "./claim-check";
import { fixturePage, loadClaims, renderEval, renderStep, root } from "./render";

const { registry, status } = loadRegistry(root);

describe("claims registry render rule", () => {
  it("the status file covers the registry, 16 claims", () => {
    expect(registry.claims).toHaveLength(16);
    expect(status.claims.map((c) => c.claim_id).sort()).toEqual(registry.claims.map((c) => c.claim_id).sort());
  });

  it("every step and every evaluation tab shows only registry ids with their measured wording, and claim text nowhere else", async () => {
    const claims = loadClaims(root);
    const task = await fixturePage();
    const pages: [string, string][] = [];
    for (let n = 1; n <= 6; n += 1) pages.push([`step ${n}`, renderStep(n, claims, task)]);
    for (const t of EVAL_TABS) pages.push([`tab ${t.slug}`, renderEval(t.slug, claims, task)]);
    for (const [name, html] of pages) {
      expect(checkHtml(html, registry, status), name).toEqual([]);
      const els = claimElements(html);
      for (const c of registry.claims) expect(els.some((e) => e.id === c.claim_id), `${name} strip has ${c.claim_id}`).toBe(true);
      expect(els.every((e) => e.wording !== null), `${name} every badge has wording`).toBe(true);
    }
  });

  it("each registry surface is rendered: steps, the results tile and the footer", async () => {
    const claims = loadClaims(root);
    const task = await fixturePage();
    for (const c of registry.claims) {
      const surfaces = claims.claims.find((x) => x.id === c.claim_id)!.surfaces;
      for (const s of surfaces) {
        const n = Number(s);
        const html = Number.isInteger(n) && n >= 1 ? renderStep(n, claims, task) : renderStep(1, claims, task);
        const strip = html.slice(html.indexOf('class="main"'));
        expect(claimElements(strip).some((e) => e.id === c.claim_id), `${c.claim_id} on ${s}`).toBe(true);
      }
    }
  });

  it("every registry tab name maps to one of the ten evaluation tabs", () => {
    for (const c of registry.claims) expect(tabFor(JSON.parse(readFileSync(join(root, "evaluation", "claims.json"), "utf8")).claims.find((x: { claim_id: string }) => x.claim_id === c.claim_id).evaluation_view.tab), c.claim_id).not.toBeNull();
  });

  it("a measured status changes the badge to its filled wording, and the checker agrees", async () => {
    const st = structuredClone(status);
    const c01 = st.claims.find((c) => c.claim_id === "C-01")!;
    Object.assign(c01, { status: "amber", values: { done: 7, total: 9 } });
    const c12 = st.claims.find((c) => c.claim_id === "C-12")!;
    Object.assign(c12, { status: "green", values: { provider: "modal", calls: 38, usd: "0.34", p50: "1.17" } });
    const claims = buildClaims(registry, { ...st, generated_at: "2026-10-28T00:00:00.000Z", commit: "x" });
    const html = renderStep(5, claims, await fixturePage());
    expect(checkHtml(html, registry, st)).toEqual([]);
    expect(html).toContain("Completed 7 of 9 items");
    expect(html).toContain("Muse Spark Open on modal: 38 calls, $0.34, p50 1.17s");
    expect(checkHtml(html, registry, status).length).toBeGreaterThan(0);
  });

  it("negative controls: the checker catches a stray claim sentence, a wrong wording and an unknown id", () => {
    const frag = claimFragments(registry)[1]!;
    expect(checkHtml(`<main><p>${frag}</p></main>`, registry, status).join()).toContain("outside a registry component");
    expect(checkHtml(`<main><p title="${registry.claims[0]!.question}">x</p></main>`, registry, status).join()).toContain("outside a registry component");
    expect(checkHtml(`<a data-claim="C-01" data-claim-status="not_measured"><span data-claim-wording="">Done</span></a>`, registry, status).join()).toContain("registry wording");
    expect(checkHtml(`<a data-claim="C-99" data-claim-status="green"><span data-claim-wording="">x</span></a>`, registry, status).join()).toContain("not a registry id");
    expect(checkHtml(`<a data-claim="C-01" data-claim-status="green"><span data-claim-wording="">Not measured yet</span></a>`, registry, status).join()).toContain("file says not_measured");
  });

  it("no claim sentence is written into the demo's source", () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(tsx?|css|mjs)$/.test(f)) files.push(p);
      }
    };
    for (const d of ["app", "components", "src"]) walk(join(root, "apps", "demo", d));
    expect(files.length).toBeGreaterThan(10);
    const hits: string[] = [];
    for (const f of files) {
      const t = readFileSync(f, "utf8").toLowerCase();
      for (const frag of claimFragments(registry)) if (t.includes(frag.toLowerCase())) hits.push(`${f}: ${frag}`);
    }
    expect(hits).toEqual([]);
  });
});
