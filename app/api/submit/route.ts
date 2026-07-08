import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  const host = process.env.N8N_HOST;
  if (!host) {
    return NextResponse.json(
      { error: "N8N_HOST is not configured on the server." },
      { status: 500 }
    );
  }

  const formData = await request.formData();

  const res = await fetch(`${host}/webhook-test/rol-portal`, {
    method: "POST",
    body: formData,
  });

  const body = await res.text();

  return new NextResponse(body, {
    status: res.status,
    headers: {
      "Content-Type": res.headers.get("content-type") ?? "application/json",
    },
  });
}
