import { NextRequest, NextResponse } from "next/server";

export async function GET(
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

  const res = await fetch(
    `${host}/api/v1/executions/${encodeURIComponent(id)}`,
    { headers: { "X-N8N-API-KEY": apiKey } }
  );

  if (!res.ok) {
    return NextResponse.json(
      { error: `n8n status fetch failed with ${res.status}` },
      { status: res.status }
    );
  }

  const data = await res.json();
  return NextResponse.json({ status: data?.status ?? null });
}
