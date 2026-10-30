import { loadProfile } from "../src/profile.js";
import type { DoorLog } from "../src/port.js";
import { personCaller } from "../src/journey.sandbox.js";
import { SandboxBlock, sandboxQuery } from "../src/sandbox.js";

// A fresh synthetic arrival, registered and paid by the desk person, so no other run's patient is touched.
export async function freshArrival(profile = loadProfile(), label = "E2 Child"): Promise<{ patient: string; visit: string; sb: SandboxBlock; person: ReturnType<typeof personCaller>; log: DoorLog[] }> {
  const sb = SandboxBlock.parse(profile.sandbox);
  const log: DoorLog[] = [];
  const call = personCaller(profile, sb, new Map(), log);
  // A keep-alive socket the app already closed resets once; the person step is tried again on a fresh one.
  const person: typeof call = async (op, vars) => { try { return await call(op, vars); } catch { return call(op, vars); } };
  const tag = Date.now().toString(36);
  const reg = await person("register", { name: `${sb.scrub[0] ?? ""}${label} ${tag}`, phone: `0803${String(Date.now()).slice(-7)}` });
  if (!reg.ok) throw new Error(`register failed: ${reg.status} ${reg.note ?? ""}`);
  const patient = String((reg.json as { id: string }).id);
  const visit = String(sandboxQuery(sb, "visit_for_patient", { patient })[0]?.["id"] ?? "");
  if (!visit) throw new Error("the arrival has no visit");
  const paid = await person("mark_paid", { visit_id: visit });
  if (!paid.ok) throw new Error(`mark paid failed: ${paid.status} ${paid.note ?? ""}`);
  return { patient, visit, sb, person, log };
}

