import { NextResponse } from "next/server";
import { resolvePin, fetchTranscript } from "@/lib/pinterest";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: { url?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const url = (body.url ?? "").trim();
  if (!url) {
    return NextResponse.json({ error: "A Pinterest pin URL is required." }, { status: 400 });
  }

  try {
    const pin = await resolvePin(url);
    const transcript = pin.captionsUrl ? await fetchTranscript(pin.captionsUrl) : null;

    return NextResponse.json({ pin, transcript });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not resolve that pin.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
