import { getClaims, getTaskPage } from "../../components/data.js";
import { EvaluationPage } from "../../components/evaluation";

export const dynamic = "force-dynamic";

export default async function Evaluation({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const tab = typeof sp["tab"] === "string" ? sp["tab"] : null;
  return <EvaluationPage claims={getClaims()} tabSlug={tab} task={await getTaskPage(null)} />;
}
