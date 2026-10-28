"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { MicButton } from "./voice";

// Refreshes the server-rendered task view while the task can still change.
export function LiveRefresh({ active, ms = 1500 }: { active: boolean; ms?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => router.refresh(), ms);
    return () => clearInterval(t);
  }, [active, ms, router]);
  return null;
}

// Opens the step 5 case on the running serve with the typed or spoken goal; serve writes the store, this app never does.
export function StartTask({ defaultGoal }: { defaultGoal: string }) {
  const router = useRouter();
  const [goal, setGoal] = useState(defaultGoal);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/api/serve/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ goal }) });
      const b = (await r.json()) as { task_id?: string; error?: string };
      if (!r.ok || !b.task_id) throw new Error(b.error ?? `serve answered ${r.status}`);
      router.push(`/step/5?task=${encodeURIComponent(b.task_id)}`);
      router.refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "could not start the task");
    } finally {
      setBusy(false);
    }
  };
  const trimmed = goal.trim();
  return (
    <form className="start" onSubmit={(e) => { e.preventDefault(); if (trimmed && !busy) void start(); }}>
      <label className="goal-label" htmlFor="task-goal">Goal</label>
      <div className="goal-row">
        <input id="task-goal" name="goal" className="goal-input" value={goal} maxLength={500} autoComplete="off" onChange={(e) => setGoal(e.target.value)} />
        <MicButton onFinal={setGoal} disabled={busy} />
      </div>
      <button type="submit" disabled={busy || !trimmed}>{busy ? "Starting" : "Start the step 5 case on serve"}</button>
      {msg ? <p role="alert" className="start-err">{msg}</p> : null}
    </form>
  );
}
