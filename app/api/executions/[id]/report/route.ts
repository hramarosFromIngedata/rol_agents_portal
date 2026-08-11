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

// Used for FAILED runs only: PortalForm calls this once a run ends in
// error/canceled/crashed, and this is that execution's one and only store
// call — there's no manual-review phase to wait for on a failed run. For
// SUCCESSFUL runs, PortalForm does NOT call this: it waits for POST below
// instead, so a successful execution is only ever stored once, already
// carrying its manual-review data, rather than once prematurely (with
// manual fields still null) and once again after.
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

// Used for SUCCESSFUL runs: called once the operator answers the
// manual-correction prompt (see finalizeManualPhase in PortalForm.tsx) —
// the one and only store call for that execution. n8n has no notion of
// manual review time — only the browser measured it — so it can only ever
// be attached here, after the fact. Rebuilds the report fresh (n8n data
// isn't cached) and merges the client-supplied manual timestamps/answer in
// before storing.
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

  const manualStartedAt = (body as Record<string, unknown> | null)?.manualStartedAt;
  const manualStoppedAt = (body as Record<string, unknown> | null)?.manualStoppedAt;
  const manuallyCorrected = (body as Record<string, unknown> | null)?.manuallyCorrected;
  if (
    typeof manualStartedAt !== "string" ||
    typeof manualStoppedAt !== "string" ||
    typeof manuallyCorrected !== "boolean"
  ) {
    return NextResponse.json(
      {
        error:
          "manualStartedAt (string), manualStoppedAt (string) and manuallyCorrected (boolean) are required.",
      },
      { status: 400 }
    );
  }

  const resolved = await resolveReport(id);
  if (!resolved.ok) return resolved.response;

  const report = applyManualCorrection(resolved.report, { manualStartedAt, manualStoppedAt, manuallyCorrected });

  postJsonWithRetry(webhookUrl(resolved.host, "rolStoreMetaData"), report, "rol-store-meta-data:" + id + ":manual");

  return NextResponse.json(report);
}
