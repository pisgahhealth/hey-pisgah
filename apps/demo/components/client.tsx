"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

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

// Opens the step 5 task on the running serve; serve writes the store, this app never does.
export function StartTask() {
  const router = useRouter();
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/api/serve/tasks", { method: "POST" });
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
  return (
    <div className="start">
      <button type="button" onClick={start} disabled={busy}>{busy ? "Starting" : "Start the step 5 case on serve"}</button>
      {msg ? <p role="alert" className="start-err">{msg}</p> : null}
    </div>
  );
}
