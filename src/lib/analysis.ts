/**
 * The shape of the analysis the agent produces from a Pinterest video.
 * Mirrors what we ask the model to return as strict JSON.
 */

/**
 * Where the hook came from. The model must pick the actual source of the
 * hook rather than inventing one, and quote it verbatim.
 */
export interface HookSource {
  /** Which part of the video the hook came from. */
  origin:
    | "spoken" // words said out loud in the opening
    | "on_screen_text" // a caption or title card burned into the video
    | "visual" // what the camera shows
    | "pinterest_caption" // the pin's own title/description
    | "none"; // no hook could be identified
  /** The exact words, quoted verbatim from the source. */
  quote: string;
  /** When it happens in the video, in seconds. 0 when it is not time-based. */
  timestamp: number;
  /** Which caption cue the quote came from, when it came from the captions. */
  cueIndex: number | null;
  /** The time range the hook occupies, e.g. "0:00 - 0:03". */
  timeRange: string;
  /** Human-readable label for where this came from. */
  label: string;
}

export interface PinAnalysis {
  /** A one-line description of the hook, in plain language. */
  hookSummary: string;
  /** The verbatim hook, exactly as it appears in the video. */
  hookQuote: string;
  /** Provenance for the hook. */
  hookSource: HookSource;
  /** A rewritten, stronger hook. */
  hook: string;
  /** 0-100 score of how strong the hook is. */
  hookScore: number;
  /** Why the hook works / does not work. */
  hookBreakdown: {
    curiosityGap?: number;
    emotionalIntensity?: number;
    specificity?: number;
    visualSurprise?: number;
    callToAction?: number;
    notes?: string;
  };
  /** A click-ready title (under 100 chars). */
  title: string;
  /** A ready-to-paste description with hashtags and a call to action. */
  description: string;
  /** Tags, without the leading '#'. */
  tags: string[];
  /** A one-paragraph summary of the video's content. */
  contentSummary: string;
  /** A prompt for generating a matching thumbnail. */
  thumbnailPrompt: string;
}

export const ANALYSIS_JSON_SCHEMA = {
  type: "object",
  properties: {
    hookSummary: { type: "string" },
    hookQuote: { type: "string" },
    hookSource: {
      type: "object",
      properties: {
        origin: {
          type: "string",
          enum: ["spoken", "on_screen_text", "visual", "pinterest_caption", "none"],
        },
        quote: { type: "string" },
        timestamp: { type: "number" },
        cueIndex: { type: ["integer", "null"] },
        timeRange: { type: "string" },
        label: { type: "string" },
      },
      required: ["origin", "quote", "timestamp", "cueIndex", "timeRange", "label"],
      additionalProperties: false,
    },
    hook: { type: "string" },
    hookScore: { type: "integer" },
    hookBreakdown: {
      type: "object",
      properties: {
        curiosityGap: { type: "integer" },
        emotionalIntensity: { type: "integer" },
        specificity: { type: "integer" },
        visualSurprise: { type: "integer" },
        callToAction: { type: "integer" },
        notes: { type: "string" },
      },
      required: [
        "curiosityGap",
        "emotionalIntensity",
        "specificity",
        "visualSurprise",
        "callToAction",
        "notes",
      ],
      additionalProperties: false,
    },
    title: { type: "string" },
    description: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    contentSummary: { type: "string" },
    thumbnailPrompt: { type: "string" },
  },
  required: [
    "hookSummary",
    "hookQuote",
    "hookSource",
    "hook",
    "hookScore",
    "hookBreakdown",
    "title",
    "description",
    "tags",
    "contentSummary",
    "thumbnailPrompt",
  ],
  additionalProperties: false,
} as const;

export const SYSTEM_PROMPT = `You are a senior short-form video strategist and script doctor. You analyse short vertical videos and reverse-engineer what makes them work.

You will be given a video, the video's timestamped caption track, and metadata scraped from Pinterest.

FINDING THE HOOK - this is the most important part:
- The hook is the very first thing the viewer experiences, in the first 3 seconds.
- Identify its true origin and be precise about which one applies:
  - "spoken"          -> words said out loud
  - "on_screen_text"  -> a caption or title card burned into the video frame
  - "visual"          -> what the camera shows (a reveal, a surprising object, an action)
  - "pinterest_caption" -> the hook only exists in the pin's own title/description
  - "none"            -> the video has no deliberate hook
- "quote" must be the EXACT text, copied word for word. Do not paraphrase, do not clean it up, do not translate it. If the hook is visual and has no text, quote a short literal description of what is on screen and set origin to "visual".
- "timestamp" is the number of seconds where the hook begins.
- "cueIndex" is the number of the caption cue the quote came from. If the quote is not from the caption track, use null.
- "timeRange" is the span the hook covers, written like "0:00 - 0:03".
- "label" is a short human-readable source label, e.g. "Caption cue 1 (0:00-0:01)".

Then:
1. Score the hook out of 100 across curiosity gap, emotional intensity, specificity, visual surprise and call-to-action.
2. Rewrite a stronger hook and package the video with a clickable title, a description with hashtags, and tags.

Other rules:
- Be specific and concrete. Never give generic advice like "make it engaging".
- The title must be under 100 characters and must create curiosity, not summarise the video.
- The description must be 2-4 short lines, include a call to action, and end with 3-5 hashtags.
- Provide 12-20 tags, lowercase, no '#' prefix, no duplicates, no stop words.
- The hook rewrite must stay faithful to the original video content. Do not invent claims the video does not make.
- Respond with valid JSON only. No markdown fences, no commentary.`;

export interface AnalysisContext {
  title: string;
  description: string;
  hashtags: string[];
  durationMs: number | null;
  creatorName: string | null;
  /** Full plain transcript. */
  transcript: string | null;
  /** Caption cues with timestamps, when the pin has a caption track. */
  timedScript: string | null;
  /** Where the caption track came from, for provenance. */
  captionSource: string | null;
  captionLanguage: string | null;
}

export function buildAnalysisPrompt(meta: AnalysisContext): string {
  const duration = meta.durationMs ? `${(meta.durationMs / 1000).toFixed(1)} seconds` : "unknown";
  return `Analyse this Pinterest vertical video and produce a publishing package.

PIN METADATA
- Title: ${meta.title || "(none)"}
- Description: ${meta.description || "(none)"}
- Hashtags on the pin: ${meta.hashtags.length ? meta.hashtags.join(", ") : "(none)"}
- Duration: ${duration}
- Creator: ${meta.creatorName ?? "(unknown)"}

CAPTION TRACK (timestamped)
${meta.timedScript ?? "(no caption track available for this pin — read the hook from the video itself and the pin metadata)"}
Caption source: ${meta.captionSource ?? "none"}
Caption language: ${meta.captionLanguage ?? "unknown"}

FULL TRANSCRIPT
${meta.transcript ?? "(none)"}

The video file is attached. Watch it carefully and find the hook.

Produce the JSON object now.`;
}

const HOOK_ORIGINS = [
  "spoken",
  "on_screen_text",
  "visual",
  "pinterest_caption",
  "none",
] as const;

export type HookOrigin = (typeof HOOK_ORIGINS)[number];

/** Normalise whatever the model returns into a complete, typed analysis. */
export function coerceAnalysis(raw: unknown): PinAnalysis {
  const source = (raw ?? {}) as Record<string, unknown>;
  const breakdownSource = (source.hookBreakdown ?? {}) as Record<string, unknown>;
  const hookSourceRaw = (source.hookSource ?? {}) as Record<string, unknown>;

  const asString = (value: unknown, fallback = ""): string =>
    typeof value === "string" && value.trim() ? value.trim() : fallback;

  const asInt = (value: unknown, fallback = 0): number => {
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isFinite(parsed) ? Math.max(0, Math.min(100, Math.round(parsed))) : fallback;
  };

  const tags = Array.isArray(source.tags)
    ? Array.from(
        new Set(
          source.tags
            .map((tag) => String(tag).trim().toLowerCase().replace(/^#/, ""))
            .filter(Boolean),
        ),
      )
    : [];

  const title = asString(source.title, "Untitled clip").slice(0, 100);

  const originRaw = asString(hookSourceRaw.origin, "none");
  const origin = (HOOK_ORIGINS as readonly string[]).includes(originRaw)
    ? (originRaw as HookOrigin)
    : "none";

  const quote = asString(hookSourceRaw.quote);
  const cueIndexRaw = hookSourceRaw.cueIndex;
  const cueIndex =
    typeof cueIndexRaw === "number" && Number.isFinite(cueIndexRaw)
      ? Math.max(0, Math.round(cueIndexRaw))
      : null;

  const timestampRaw = hookSourceRaw.timestamp;
  const timestamp =
    typeof timestampRaw === "number" && Number.isFinite(timestampRaw)
      ? Math.max(0, timestampRaw)
      : 0;

  const hookQuote = asString(source.hookQuote, quote);

  return {
    hookSummary: asString(source.hookSummary),
    hookQuote,
    hookSource: {
      origin,
      quote: quote || hookQuote,
      timestamp,
      cueIndex,
      timeRange: asString(hookSourceRaw.timeRange),
      label: asString(
        hookSourceRaw.label,
        origin === "none" ? "No hook found" : `Hook source: ${origin}`,
      ),
    },
    hook: asString(source.hook),
    hookScore: asInt(source.hookScore),
    hookBreakdown: {
      curiosityGap: asInt(breakdownSource.curiosityGap),
      emotionalIntensity: asInt(breakdownSource.emotionalIntensity),
      specificity: asInt(breakdownSource.specificity),
      visualSurprise: asInt(breakdownSource.visualSurprise),
      callToAction: asInt(breakdownSource.callToAction),
      notes: asString(breakdownSource.notes),
    },
    title,
    description: asString(source.description),
    tags: tags.slice(0, 20),
    contentSummary: asString(source.contentSummary),
    thumbnailPrompt: asString(source.thumbnailPrompt),
  };
}

/** Pull a JSON object out of a model response that may be wrapped in prose or fences. */
export function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  const candidates: string[] = [];

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) candidates.push(fence[1]);

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1));

  candidates.push(trimmed);

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      continue;
    }
  }
  throw new Error("The model did not return valid JSON.");
}
