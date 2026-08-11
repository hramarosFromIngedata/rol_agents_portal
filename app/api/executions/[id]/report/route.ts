import { NextRequest, NextResponse } from "next/server";
import { applyManualCorrection, buildExecutionReport, ExecutionReport } from "@/lib/n8n-report";
import { postJsonWithRetry } from "@/lib/webhook-retry";
import { webhookUrl } from "@/lib/webhooks";

async function resolveReport(
  id: string
): Promise<{ ok: true; host: string; report: ExecutionReport } | { ok: false; response: NextResponse }> {
  const apiKey = process.env.N8N_API_KEY;
  const host = process.env.N8N_HOST;
  if (!apiKey || !host) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "N8N_API_KEY / N8N_HOST is not configured on the server." },
        { status: 500 }
      ),
    };
  }

  let report: ExecutionReport | null;
  try {
    report = await buildExecutionReport(host, apiKey, id);
  } catch (err) {
    console.error(`[n8n] Échec de la construction du rapport pour l'exécution ${id} :`, err);
    return { ok: false, response: NextResponse.json({ error: "Failed to build execution report." }, { status: 502 }) };
  }

  if (!report) {
    return { ok: false, response: NextResponse.json({ error: `Execution ${id} not found.` }, { status: 404 }) };
  }

  return { ok: true, host, report };
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const resolved = await resolveReport(id);
  if (!resolved.ok) return resolved.response;

  // Fire-and-forget: don't block the response on the store webhook. Retries
  // with backoff in the background, up to MAX_ATTEMPTS (see webhook-retry.ts).
  postJsonWithRetry(webhookUrl(resolved.host, "rolStoreMetaData"), resolved.report, "rol-store-meta-data:" + id);

  return NextResponse.json(resolved.report);
}

// Called once the operator answers the manual-correction prompt (see
// finalizeManualPhase in PortalForm.tsx), after GET above has already
// stored a first snapshot with manualProcessingDurationMs/manuallyCorrected
// still null. n8n has no notion of manual review time — only the browser
// measured it — so it can only ever be attached here, after the fact.
// Rebuilds the report fresh (n8n data isn't cached) and merges the
// client-supplied manual fields in before storing a second time. Whether
// the sheet ends up with two rows or one updated row per execution depends
// entirely on the rol-store-meta-data n8n workflow, outside this repo.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const manualProcessingDurationMs = (body as Record<string, unknown> | null)?.manualProcessingDurationMs;
  const manuallyCorrected = (body as Record<string, unknown> | null)?.manuallyCorrected;
  if (typeof manualProcessingDurationMs !== "number" || typeof manuallyCorrected !== "boolean") {
    return NextResponse.json(
      { error: "manualProcessingDurationMs (number) and manuallyCorrected (boolean) are required." },
      { status: 400 }
    );
  }

  const resolved = await resolveReport(id);
  if (!resolved.ok) return resolved.response;

  const report = applyManualCorrection(resolved.report, { manualProcessingDurationMs, manuallyCorrected });

  postJsonWithRetry(webhookUrl(resolved.host, "rolStoreMetaData"), report, "rol-store-meta-data:" + id + ":manual");

  return NextResponse.json(report);
}
