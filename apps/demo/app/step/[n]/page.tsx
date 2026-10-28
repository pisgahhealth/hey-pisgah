import { notFound } from "next/navigation";
import { getBoard, getClaims, getTaskPage } from "../../../components/data.js";
import { StepPage } from "../../../components/pages";

export const dynamic = "force-dynamic";

export default async function Step({ params, searchParams }: { params: Promise<{ n: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { n } = await params;
  const sp = await searchParams;
  const num = Number(n);
  if (!Number.isInteger(num) || num < 1 || num > 6) notFound();
  const taskId = typeof sp["task"] === "string" ? sp["task"] : null;
  const task = await getTaskPage(taskId);
  return <StepPage n={num} claims={getClaims()} board={num === 1 ? getBoard() : null} task={task} />;
}
