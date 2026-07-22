import { NextResponse } from "next/server";
import { webhookUrl } from "@/lib/webhooks";

export async function GET() {
  const host = process.env.N8N_HOST;
  if (!host) {
    return NextResponse.json(
      { error: "N8N_HOST is not configured on the server." },
      { status: 500 }
    );
  }

  let res: Response;
  try {
    res = await fetch(webhookUrl(host, "fetchFormData"));
  } catch (err) {
    console.error("[n8n] Échec de la récupération des données du formulaire :", err);
    return NextResponse.json({ error: "Failed to fetch form data." }, { status: 502 });
  }

  if (!res.ok) {
    return NextResponse.json(
      { error: `fetch-form-data failed with ${res.status}` },
      { status: res.status }
    );
  }

  const json = (await res.json()) as { matricules?: unknown; langues?: unknown }[] | null;
  const matricules = Array.isArray(json)
    ? json.flatMap((entry) => (Array.isArray(entry?.matricules) ? entry.matricules : []))
    : [];
  const langues = Array.isArray(json)
    ? json.flatMap((entry) => (Array.isArray(entry?.langues) ? entry.langues : []))
    : [];

  return NextResponse.json({ matricules, langues });
}
