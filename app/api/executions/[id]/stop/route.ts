import { NextRequest, NextResponse } from "next/server";

type ExecutionRunEntry = {
  metadata?: {
    subExecution?: {
      executionId?: string;
    };
  };
};

type ExecutionRunData = Record<string, ExecutionRunEntry[]>;

// Fetches an execution's node run data so we can look for
// n8n-nodes-base.executeWorkflow calls, which record the child execution's
// id under runData[nodeName][i].metadata.subExecution.executionId.
async function fetchExecutionRunData(
  host: string,
  apiKey: string,
  executionId: string
): Promise<ExecutionRunData | null> {
  const res = await fetch(
    `${host}/api/v1/executions/${encodeURIComponent(executionId)}?includeData=true`,
    { headers: { "X-N8N-API-KEY": apiKey } }
  );
  if (!res.ok) return null;

  const data = (await res.json()) as {
    data?: { resultData?: { runData?: unknown } };
  };
  const runData = data?.data?.resultData?.runData;
  if (!runData || typeof runData !== "object") return null;

  return runData as ExecutionRunData;
}

// Recursively walks the execution tree (sub-workflows can themselves call
// further sub-workflows) and returns every descendant execution id, deepest
// first, so callers can stop them before the parent that spawned them.
async function findDescendantExecutionIds(
  host: string,
  apiKey: string,
  executionId: string,
  visited: Set<string>
): Promise<string[]> {
  if (visited.has(executionId)) return [];
  visited.add(executionId);

  const runData = await fetchExecutionRunData(host, apiKey, executionId);
  if (!runData) return [];

  const directChildren = new Set<string>();
  for (const runs of Object.values(runData)) {
    for (const run of runs) {
      const childId = run?.metadata?.subExecution?.executionId;
      if (childId && !visited.has(childId)) directChildren.add(childId);
    }
  }

  const descendants: string[] = [];
  for (const childId of directChildren) {
    const grandChildren = await findDescendantExecutionIds(host, apiKey, childId, visited);
    descendants.push(...grandChildren, childId);
  }
  return descendants;
}

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
    childIds = await findDescendantExecutionIds(host, apiKey, id, new Set());
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
