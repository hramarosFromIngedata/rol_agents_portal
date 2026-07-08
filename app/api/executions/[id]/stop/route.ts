import { NextRequest, NextResponse } from "next/server";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const apiKey = process.env.N8N_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "N8N_API_KEY is not configured on the server." },
      { status: 500 }
    );
  }

  const { id } = await params;

  const res = await fetch(
    `https://automate.ingedata.ai/api/v1/executions/${encodeURIComponent(id)}/stop`,
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

  return NextResponse.json({ ok: true });
}
