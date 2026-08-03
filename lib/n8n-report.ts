import { N8nExecution, N8nRunItem, fetchExecutionTree } from "@/lib/n8n";
import { webhookUrl } from "@/lib/webhooks";

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

type AiAgentEntry = {
  model: string | null;
  completionTokens: number;
  promptTokens: number;
  totalTokens: number;
  price: {
    completionCost: number | null;
    promptCost: number | null;
    totalCost: number | null;
  } | null;
};

// An array rather than a single object: a workflow can call several
// different AI Agent models (each with its own OpenRouter rate), so each
// model gets its own entry rather than being blended into one summed price.
type AiAgentReport = AiAgentEntry[] | null;

type AiUsageEntry = { model: string | null; tokenUsage: TokenUsage };

export type ExecutionReport = {
  executionId: string;
  workflowId: string | null;
  startedAt: string | null;
  stoppedAt: string | null;
  formMetaData: FormMetaData;
  ocrAgent: OcrAgentReport;
  aiAgent: AiAgentReport;
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

// Groups usage entries by model (summing token usage per model) so each
// distinct model reported by the workflow ends up as its own aiAgent entry.
function groupAiUsageByModel(entries: AiUsageEntry[]): { model: string | null; tokenUsage: TokenUsage }[] {
  const groups = new Map<string | null, TokenUsage>();
  for (const entry of entries) {
    const existing = groups.get(entry.model);
    if (existing) {
      existing.completionTokens += entry.tokenUsage.completionTokens;
      existing.promptTokens += entry.tokenUsage.promptTokens;
      existing.totalTokens += entry.tokenUsage.totalTokens;
    } else {
      groups.set(entry.model, { ...entry.tokenUsage });
    }
  }
  return Array.from(groups, ([model, tokenUsage]) => ({ model, tokenUsage }));
}

function round5(value: number): number {
  return Math.round(value * 1e5) / 1e5;
}

async function priceOcrUsage(host: string, pagesProcessed: number | null): Promise<number | null> {
  if (pagesProcessed == null) return null;

  const res = await fetch(webhookUrl(host, "mistralPrice"));
  if (!res.ok) return null;

  // n8n may respond with the pricing payload either bare
  // ({price: {...}}) or wrapped in an array, like the submit/form-data
  // webhooks.
  const json = (await res.json()) as
    | { price?: { cost?: number; perPage?: number } }
    | { price?: { cost?: number; perPage?: number } }[];
  const payload = Array.isArray(json) ? json[0] : json;
  const cost = payload?.price?.cost;
  const perPage = payload?.price?.perPage;
  if (cost == null || !perPage) return null;

  return round5(pagesProcessed * (cost / perPage));
}

type OpenRouterPricing = { prompt?: string; completion?: string };

async function fetchOpenRouterPricing(host: string): Promise<Map<string, OpenRouterPricing> | null> {
  const res = await fetch(webhookUrl(host, "openrouterPrice"));
  if (!res.ok) return null;

  // n8n may respond with the pricing payload either bare ({data: [...]})
  // or wrapped in an array, like the submit/form-data/mistral-price
  // webhooks.
  const json = (await res.json()) as
    | { data?: { id?: string; pricing?: OpenRouterPricing }[] }
    | { data?: { id?: string; pricing?: OpenRouterPricing }[] }[];
  const payload = Array.isArray(json) ? json[0] : json;

  return new Map(
    (payload?.data ?? []).filter((m) => m.id && m.pricing).map((m) => [m.id as string, m.pricing!])
  );
}

// Prices a single model's usage against its own OpenRouter rate. Returns
// null if the model is missing or not found in the catalog, rather than
// failing the whole report.
function priceModelUsage(
  pricingByModel: Map<string, OpenRouterPricing> | null,
  model: string | null,
  tokenUsage: TokenUsage
): { completionCost: number | null; promptCost: number | null; totalCost: number | null } | null {
  const pricing = model ? pricingByModel?.get(model) : undefined;
  if (!pricing) return null;

  const promptRate = Number(pricing.prompt);
  const completionRate = Number(pricing.completion);
  if (!Number.isFinite(promptRate) || !Number.isFinite(completionRate)) return null;

  const promptCost = round5(tokenUsage.promptTokens * promptRate);
  const completionCost = round5(tokenUsage.completionTokens * completionRate);
  return { promptCost, completionCost, totalCost: round5(promptCost + completionCost) };
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
  const aiUsageGroups = groupAiUsageByModel(extractAiUsageEntries(executions));

  const [ocrPrice, aiPricing] = await Promise.all([
    priceOcrUsage(host, ocrUsage?.pagesProcessed ?? null),
    aiUsageGroups.length > 0 ? fetchOpenRouterPricing(host) : Promise.resolve(null),
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
      aiUsageGroups.length > 0
        ? aiUsageGroups.map(({ model, tokenUsage }) => ({
            model,
            completionTokens: tokenUsage.completionTokens,
            promptTokens: tokenUsage.promptTokens,
            totalTokens: tokenUsage.totalTokens,
            price: priceModelUsage(aiPricing, model, tokenUsage),
          }))
        : null,
  };
}
