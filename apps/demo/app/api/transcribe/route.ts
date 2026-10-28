export const dynamic = "force-dynamic";

// Speech to text is lane L1.6's; until it lands the route answers 501 and stores nothing.
function notYet(): Response {
  return Response.json({ error: "not_implemented", detail: "Speech to text is not built yet." }, { status: 501 });
}

export function POST(): Response { return notYet(); }
export function GET(): Response { return notYet(); }
