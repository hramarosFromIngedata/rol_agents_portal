import { NextRequest, NextResponse } from "next/server";
import { fetchExecutionTree } from "@/lib/n8n";

export async function POST(
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

  let childIds: string[] = [];
  try {
    const tree = await fetchExecutionTree(host, apiKey, id);
    childIds = tree.filter((execution) => execution.id !== id).map((execution) => execution.id);
  } catch (err) {
    console.error(`[n8n] Impossible de résoudre les sous-exécutions de ${id} :`, err);
  }

  // Best-effort: stop every sub-workflow execution first (deepest first),
  // then the parent. A child that already finished will fail here, which is
  // fine — only the parent's outcome determines this route's response.
  for (const childId of childIds) {
    const childRes = await fetch(
      `${host}/api/v1/executions/${encodeURIComponent(childId)}/stop`,
      { method: "POST", headers: { "X-N8N-API-KEY": apiKey } }
    );
    if (!childRes.ok) {
      console.error(`[n8n] Échec de l'arrêt du sous-workflow ${childId} (HTTP ${childRes.status}).`);
    }
  }

  const res = await fetch(
    `${host}/api/v1/executions/${encodeURIComponent(id)}/stop`,
    {
      method: "POST",
      headers: { "X-N8N-API-KEY": apiKey },
    }
  );

  if (!res.ok) {
    return NextResponse.json(
      { error: `n8n stop failed with ${res.status}` },
      { status: res.status }
    );
  }

  return NextResponse.json({ ok: true, stoppedChildren: childIds });
}
