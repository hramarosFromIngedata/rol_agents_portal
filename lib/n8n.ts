export type N8nNode = {
  name: string;
  type: string;
  parameters?: Record<string, unknown>;
};

export type N8nRunItem = {
  json?: Record<string, unknown>;
  binary?: Record<string, { fileName?: string; fileSize?: string | number; mimeType?: string }>;
};

export type N8nRunEntry = {
  data?: { main?: (N8nRunItem[] | null)[]; [outputName: string]: unknown };
  metadata?: {
    subExecution?: {
      executionId?: string;
      workflowId?: string;
    };
  };
};

export type N8nRunData = Record<string, N8nRunEntry[]>;

export type N8nExecution = {
  id: string;
  workflowId?: string;
  status?: string;
  startedAt?: string;
  stoppedAt?: string | null;
  data?: {
    resultData?: {
      runData?: N8nRunData;
    };
  };
  workflowData?: {
    id?: string;
    nodes?: N8nNode[];
  };
};

// Fetches an execution with its full node run data (includeData=true), which
// is required both to find n8n-nodes-base.executeWorkflow sub-execution ids
// and to inspect what each node actually produced (tokens, pages, models...).
export async function fetchExecution(
  host: string,
  apiKey: string,
  executionId: string
): Promise<N8nExecution | null> {
  const res = await fetch(
    `${host}/api/v1/executions/${encodeURIComponent(executionId)}?includeData=true`,
    { headers: { "X-N8N-API-KEY": apiKey } }
  );
  if (!res.ok) return null;
  return (await res.json()) as N8nExecution;
}

// Recursively walks the execution tree (sub-workflows can themselves call
// further sub-workflows) and returns every execution in the tree, deepest
// descendants first and the root execution last.
export async function fetchExecutionTree(
  host: string,
  apiKey: string,
  rootId: string
): Promise<N8nExecution[]> {
  const visited = new Set<string>();
  const result: N8nExecution[] = [];

  async function visit(executionId: string) {
    if (visited.has(executionId)) return;
    visited.add(executionId);

    const execution = await fetchExecution(host, apiKey, executionId);
    if (!execution) return;

    const runData = execution.data?.resultData?.runData ?? {};
    const childIds = new Set<string>();
    for (const runs of Object.values(runData)) {
      for (const run of runs) {
        const childId = run?.metadata?.subExecution?.executionId;
        if (childId && !visited.has(childId)) childIds.add(childId);
      }
    }

    for (const childId of childIds) {
      await visit(childId);
    }

    result.push(execution);
  }

  await visit(rootId);
  return result;
}
