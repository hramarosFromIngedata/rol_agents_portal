import { NextRequest, NextResponse } from "next/server";
import { buildExecutionReport } from "@/lib/n8n-report";
import { postJsonWithRetry } from "@/lib/webhook-retry";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const apiKey = process.env.N8N_API_KEY;
  const host = process.env.N8N_HOST;
  if (!apiKey || !host) {
    return NextResponse.json(
      { error: "N8N_API_KEY / N8N_HOST is not configured on the server." },
      { status: 500 }
    );
  }

  const { id } = await params;

  let report;
  try {
    report = await buildExecutionReport(host, apiKey, id);
  } catch (err) {
    console.error(`[n8n] Échec de la construction du rapport pour l'exécution ${id} :`, err);
    return NextResponse.json({ error: "Failed to build execution report." }, { status: 502 });
  }

  if (!report) {
    return NextResponse.json({ error: `Execution ${id} not found.` }, { status: 404 });
  }

  // Fire-and-forget: don't block the response on the store webhook, it
  // retries indefinitely with backoff in the background until it succeeds.
  postJsonWithRetry(`${host}/webhook/rol-store-meta-data`, report, `rol-store-meta-data:${id}`);

  return NextResponse.json(report);
}
