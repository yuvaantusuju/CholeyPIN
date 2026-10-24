import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

/**
 * Only Pinterest's own media CDN may be proxied. Without this check the route
 * would be an open proxy that could be pointed at internal addresses.
 */
function isAllowedSource(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return (
    host === "v1.pinimg.com" ||
    host === "pinimg.com" ||
    host.endsWith(".pinimg.com") ||
    host === "i.pinimg.com"
  );
}

/**
 * Streams the Pinterest video through our own origin.
 *
 * Two reasons this exists:
 *  1. Pinterest's CDN does not send permissive CORS headers, so the browser
 *     cannot read the bytes directly for download or preview.
 *  2. The client needs a stable URL it can pass to `puter.ai.chat()` as
 *     multimodal media context.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const source = searchParams.get("src") ?? "";
  const name = searchParams.get("name") ?? "pinterest-video.mp4";

  if (!source) {
    return NextResponse.json({ error: "Missing video source." }, { status: 400 });
  }

  if (!isAllowedSource(source)) {
    return NextResponse.json({ error: "Unsupported media source." }, { status: 400 });
  }

  const upstream = await fetch(source, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "video/mp4,video/*;q=0.9,*/*;q=0.8",
      Referer: "https://www.pinterest.com/",
    },
    cache: "no-store",
  });

  if (!upstream.ok || !upstream.body) {
    return NextResponse.json(
      { error: `Pinterest CDN responded with ${upstream.status}.` },
      { status: 502 },
    );
  }

  const headers = new Headers();
  headers.set("Content-Type", upstream.headers.get("content-type") ?? "video/mp4");
  headers.set("Cache-Control", "no-store");
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set(
    "Content-Disposition",
    `inline; filename="${name.replace(/[^a-zA-Z0-9._-]/g, "_")}"`,
  );
  const length = upstream.headers.get("content-length");
  if (length) headers.set("Content-Length", length);

  return new NextResponse(upstream.body, { status: 200, headers });
}
