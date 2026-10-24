/**
 * The shape of the analysis the agent produces from a Pinterest video.
 * Mirrors what we ask the model to return as strict JSON.
 */
export interface PinAnalysis {
  /** The exact words spoken/typed in the first 3 seconds. */
  spokenHook: string;
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
    spokenHook: { type: "string" },
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
    "spokenHook",
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

You will be given a video and metadata scraped from Pinterest. Your job is to:
1. Watch/analyse the video and identify the HOOK - the very first thing the viewer sees and hears in the first 3 seconds.
2. Score the hook out of 100 across curiosity gap, emotional intensity, specificity, visual surprise and call-to-action.
3. Rewrite a stronger hook and package the video with a clickable title, a description with hashtags, and tags.

Rules:
- Be specific and concrete. Never give generic advice like "make it engaging".
- The title must be under 100 characters and must create curiosity, not summarise the video.
- The description must be 2-4 short lines, include a call to action, and end with 3-5 hashtags.
- Provide 12-20 tags, lowercase, no '#' prefix, no duplicates, no stop words.
- The hook rewrite must stay faithful to the original video content. Do not invent claims the video does not make.
- Respond with valid JSON only. No markdown fences, no commentary.`;

export function buildAnalysisPrompt(meta: {
  title: string;
  description: string;
  hashtags: string[];
  durationMs: number | null;
  creatorName: string | null;
  transcript: string | null;
}): string {
  const duration = meta.durationMs ? `${(meta.durationMs / 1000).toFixed(1)} seconds` : "unknown";
  return `Analyse this Pinterest vertical video and produce a publishing package.

PIN METADATA
- Title: ${meta.title || "(none)"}
- Description: ${meta.description || "(none)"}
- Hashtags on the pin: ${meta.hashtags.length ? meta.hashtags.join(", ") : "(none)"}
- Duration: ${duration}
- Creator: ${meta.creatorName ?? "(unknown)"}
- Spoken transcript (auto captions): ${meta.transcript ?? "(no caption track available — rely on the video itself and the metadata)"}

The video file is attached. Watch it carefully.

Produce the JSON object now.`;
}

/** Normalise whatever the model returns into a complete, typed analysis. */
export function coerceAnalysis(raw: unknown): PinAnalysis {
  const source = (raw ?? {}) as Record<string, unknown>;
  const breakdownSource = (source.hookBreakdown ?? {}) as Record<string, unknown>;

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

  return {
    spokenHook: asString(source.spokenHook),
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
