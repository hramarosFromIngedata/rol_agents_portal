import { N8nExecution, N8nRunItem, fetchExecutionTree } from "@/lib/n8n";

type TokenUsage = {
  completionTokens: number;
  promptTokens: number;
  totalTokens: number;
};

type FormMetaData = {
  type: "pdf" | "url" | null;
  url: string | null;
  fileName: string | null;
  size: number | null;
  language: string | null;
  agentId: number | string | null;
  category: string | null;
};

type OcrAgentReport = {
  model: string | null;
  pagesProcessed: number | null;
  price: number | null;
} | null;

type AiAgentReport = {
  model: string | string[] | null;
  tokenUsage: TokenUsage | null;
  price: {
    completionCost: number | null;
    promptCost: number | null;
    totalCost: number | null;
  } | null;
} | null;

type AiUsageEntry = { model: string | null; tokenUsage: TokenUsage };

export type ExecutionReport = {
  executionId: string;
  workflowId: string | null;
  startedAt: string | null;
  stoppedAt: string | null;
  formMetaData: FormMetaData;
  ocrAgent: OcrAgentReport;
  aiAgent: AiAgentReport;
  agentFeedback: string | null;
};

// Builds name -> node maps per execution, since node type/parameters live in
// workflowData.nodes while the actual output lives in runData keyed by name.
function buildNodeMap(execution: N8nExecution): Map<string, { type: string; parameters?: Record<string, unknown> }> {
  const map = new Map<string, { type: string; parameters?: Record<string, unknown> }>();
  for (const node of execution.workflowData?.nodes ?? []) {
    if (node?.name && node?.type) map.set(node.name, { type: node.type, parameters: node.parameters });
  }
  return map;
}

function firstOutputItem(entry: { data?: { main?: (N8nRunItem[] | null)[] } }): N8nRunItem | null {
  const firstOutput = entry.data?.main?.[0];
  return firstOutput?.[0] ?? null;
}

// Scans every node output (json, plus json.body for webhook-shaped payloads)
// across the whole execution tree and returns the first item whose json (or
// json.body) contains any of the given keys. Used for values that live on
// whatever node received the original form submission or set feedback data,
// without depending on a fixed node name.
function findFieldAnywhere(
  executions: N8nExecution[],
  keys: string[]
): { source: Record<string, unknown>; item: N8nRunItem } | null {
  for (const execution of executions) {
    const runData = execution.data?.resultData?.runData ?? {};
    for (const entries of Object.values(runData)) {
      for (const entry of entries) {
        const outputs = entry.data?.main ?? [];
        for (const output of outputs) {
          for (const item of output ?? []) {
            const candidates: (Record<string, unknown> | undefined)[] = [
              item.json,
              item.json?.body as Record<string, unknown> | undefined,
            ];
            for (const candidate of candidates) {
              if (candidate && keys.some((key) => key in candidate)) {
                return { source: candidate, item };
              }
            }
          }
        }
      }
    }
  }
  return null;
}

function extractFormMetaData(executions: N8nExecution[]): FormMetaData {
  const match = findFieldAnywhere(executions, ["langue", "code", "categorie", "url-source"]);
  const source = match?.source ?? null;
  const binary = match?.item.binary?.["document_pdf"] ?? null;

  const url = (source?.["url-source"] as string | undefined) ?? null;
  const fileName = binary?.fileName ?? null;
  const size = binary?.fileSize != null ? Number(binary.fileSize) : null;

  return {
    type: binary ? "pdf" : url ? "url" : null,
    url,
    fileName,
    size: Number.isFinite(size) ? size : null,
    language: (source?.["langue"] as string | undefined) ?? null,
    agentId: (source?.["code"] as string | number | undefined) ?? null,
    category: (source?.["categorie"] as string | undefined) ?? null,
  };
}

function extractOcrUsage(executions: N8nExecution[]): { model: string | null; pagesProcessed: number | null } | null {
  let model: string | null = null;
  let pagesProcessed = 0;
  let found = false;

  for (const execution of executions) {
    const nodes = buildNodeMap(execution);
    const runData = execution.data?.resultData?.runData ?? {};
    for (const [nodeName, entries] of Object.entries(runData)) {
      const nodeType = nodes.get(nodeName)?.type ?? "";
      if (!/mistralAi/i.test(nodeType)) continue;

      for (const entry of entries) {
        const item = firstOutputItem(entry);
        const json = item?.json;
        if (!json) continue;
        const usage = json["usage_info"] as { pages_processed?: number } | undefined;
        if (usage?.pages_processed == null) continue;

        found = true;
        pagesProcessed += Number(usage.pages_processed) || 0;
        if (typeof json["model"] === "string") model = json["model"] as string;
      }
    }
  }

  return found ? { model, pagesProcessed } : null;
}

// Returns one entry per AI Agent / model call found anywhere in the tree,
// each tagged with the model it actually used. Kept ungrouped (rather than
// summed into a single model+tokenUsage pair) because different calls can
// use different models, which each carry their own OpenRouter price.
function extractAiUsageEntries(executions: N8nExecution[]): AiUsageEntry[] {
  const usageEntries: AiUsageEntry[] = [];

  for (const execution of executions) {
    const nodes = buildNodeMap(execution);
    const runData = execution.data?.resultData?.runData ?? {};
    for (const [nodeName, entries] of Object.entries(runData)) {
      const node = nodes.get(nodeName);
      if (!node || !/openrouter/i.test(node.type)) continue;

      const configuredModel = node.parameters?.["model"];
      const model = typeof configuredModel === "string" ? configuredModel : null;

      for (const entry of entries) {
        const outputs = (entry.data as Record<string, unknown> | undefined)?.["ai_languageModel"] as
          | (N8nRunItem[] | null)[]
          | undefined;
        const item = outputs?.[0]?.[0];
        const usage = item?.json?.["tokenUsage"] as
          | { completionTokens?: number; promptTokens?: number; totalTokens?: number }
          | undefined;
        if (!usage) continue;

        usageEntries.push({
          model,
          tokenUsage: {
            completionTokens: Number(usage.completionTokens) || 0,
            promptTokens: Number(usage.promptTokens) || 0,
            totalTokens: Number(usage.totalTokens) || 0,
          },
        });
      }
    }
  }

  return usageEntries;
}

function sumTokenUsage(entries: AiUsageEntry[]): TokenUsage {
  return entries.reduce(
    (total, entry) => ({
      completionTokens: total.completionTokens + entry.tokenUsage.completionTokens,
      promptTokens: total.promptTokens + entry.tokenUsage.promptTokens,
      totalTokens: total.totalTokens + entry.tokenUsage.totalTokens,
    }),
    { completionTokens: 0, promptTokens: 0, totalTokens: 0 }
  );
}

function extractAgentFeedback(executions: N8nExecution[]): string | null {
  const match = findFieldAnywhere(executions, ["agentFeedback", "feedback"]);
  if (!match) return null;
  const value = match.source["agentFeedback"] ?? match.source["feedback"];
  return typeof value === "string" ? value : null;
}

function round5(value: number): number {
  return Math.round(value * 1e5) / 1e5;
}

async function priceOcrUsage(host: string, pagesProcessed: number | null): Promise<number | null> {
  if (pagesProcessed == null) return null;

  const res = await fetch(`${host}/webhook/mistral-price`);
  if (!res.ok) return null;

  const json = (await res.json()) as { price?: { cost?: number; perPage?: number } };
  const cost = json.price?.cost;
  const perPage = json.price?.perPage;
  if (cost == null || !perPage) return null;

  return round5(pagesProcessed * (cost / perPage));
}

// Prices each usage entry against its own model's OpenRouter rate (calls can
// use different models, so a single blended rate would be wrong), then sums
// the results. Entries whose model isn't found in the catalog are skipped
// rather than failing the whole calculation.
async function priceAiUsage(
  host: string,
  entries: AiUsageEntry[]
): Promise<{ completionCost: number | null; promptCost: number | null; totalCost: number | null } | null> {
  if (entries.length === 0) return null;

  const res = await fetch(`${host}/webhook/openrouter-price`);
  if (!res.ok) return null;

  const json = (await res.json()) as {
    data?: { id?: string; pricing?: { prompt?: string; completion?: string } }[];
  };
  const pricingByModel = new Map(
    (json.data ?? []).filter((m) => m.id && m.pricing).map((m) => [m.id as string, m.pricing!])
  );

  let promptCost = 0;
  let completionCost = 0;
  let priced = false;

  for (const entry of entries) {
    const pricing = entry.model ? pricingByModel.get(entry.model) : undefined;
    if (!pricing) continue;

    const promptRate = Number(pricing.prompt);
    const completionRate = Number(pricing.completion);
    if (!Number.isFinite(promptRate) || !Number.isFinite(completionRate)) continue;

    priced = true;
    promptCost += entry.tokenUsage.promptTokens * promptRate;
    completionCost += entry.tokenUsage.completionTokens * completionRate;
  }

  if (!priced) return null;

  const roundedPromptCost = round5(promptCost);
  const roundedCompletionCost = round5(completionCost);
  return {
    promptCost: roundedPromptCost,
    completionCost: roundedCompletionCost,
    totalCost: round5(roundedPromptCost + roundedCompletionCost),
  };
}

export async function buildExecutionReport(
  host: string,
  apiKey: string,
  executionId: string
): Promise<ExecutionReport | null> {
  const executions = await fetchExecutionTree(host, apiKey, executionId);
  const root = executions.find((e) => e.id === executionId) ?? null;
  if (!root) return null;

  const ocrUsage = extractOcrUsage(executions);
  const aiUsageEntries = extractAiUsageEntries(executions);
  const aiModels = Array.from(new Set(aiUsageEntries.map((e) => e.model).filter((m): m is string => m != null)));

  const [ocrPrice, aiPrice] = await Promise.all([
    priceOcrUsage(host, ocrUsage?.pagesProcessed ?? null),
    priceAiUsage(host, aiUsageEntries),
  ]);

  return {
    executionId: root.id,
    workflowId: root.workflowId ?? root.workflowData?.id ?? null,
    startedAt: root.startedAt ?? null,
    stoppedAt: root.stoppedAt ?? null,
    formMetaData: extractFormMetaData(executions),
    ocrAgent: ocrUsage
      ? { model: ocrUsage.model, pagesProcessed: ocrUsage.pagesProcessed, price: ocrPrice }
      : null,
    aiAgent:
      aiUsageEntries.length > 0
        ? {
            model: aiModels.length <= 1 ? (aiModels[0] ?? null) : aiModels,
            tokenUsage: sumTokenUsage(aiUsageEntries),
            price: aiPrice,
          }
        : null,
    agentFeedback: extractAgentFeedback(executions),
  };
}
