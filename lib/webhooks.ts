// Single source of truth for n8n webhook paths (mounted under `${host}/webhook/`).
// Each path can be overridden via env var so a path rename in n8n never
// requires a code change — only a `.env.local` update.
const WEBHOOK_PATHS = {
  rolPortal: process.env.N8N_WEBHOOK_ROL_PORTAL || "rol-portal",
  mistralPrice: process.env.N8N_WEBHOOK_MISTRAL_PRICE || "mistral-price",
  openrouterPrice: process.env.N8N_WEBHOOK_OPENROUTER_PRICE || "openrouter-price",
  rolStoreMetaData: process.env.N8N_WEBHOOK_ROL_STORE_META_DATA || "rol-store-meta-data",
  fetchFormData: process.env.N8N_WEBHOOK_FETCH_FORM_DATA || "fetch-form-data",
} as const;

export type WebhookName = keyof typeof WEBHOOK_PATHS;

export function webhookUrl(host: string, name: WebhookName): string {
  return `${host}/webhook/${WEBHOOK_PATHS[name]}`;
}
