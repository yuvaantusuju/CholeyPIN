import { NextResponse } from "next/server";
import {
  buildTimedScript,
  fetchCaptionTrack,
  resolvePin,
  type CaptionCue,
} from "@/lib/pinterest";

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
    const track = pin.captionsUrl ? await fetchCaptionTrack(pin.captionsUrl) : null;

    // The hook source: the opening lines of the video, each anchored to the
    // moment it is spoken, with the exact caption track it came from.
    const hookCues: CaptionCue[] = track ? track.cues.slice(0, 6) : [];
    const hookScript = track ? buildTimedScript(track, 15, 12) : "";

    return NextResponse.json({
      pin,
      transcript: track?.text ?? null,
      captions: track
        ? {
            source: pin.captionsUrl,
            language: captionLanguage(pin.captionsUrl),
            duration: track.duration,
            cues: track.cues,
            timedScript: track.cues.map(
              (cue) =>
                `[${cue.start.toFixed(2)}s] ${cue.text}`,
            ),
          }
        : null,
      hookSource: {
        source: pin.captionsUrl,
        language: captionLanguage(pin.captionsUrl),
        window: "0:00 - 0:15",
        cues: hookCues,
        script: hookScript,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not resolve that pin.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

/** Pull the language code out of a Pinterest caption URL, e.g. `en-gb`. */
function captionLanguage(captionsUrl: string | null): string | null {
  if (!captionsUrl) return null;
  const match = captionsUrl.match(/\/captions\/([^/]+)\//);
  return match ? match[1] : null;
}
