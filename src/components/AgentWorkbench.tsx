"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ANALYSIS_JSON_SCHEMA,
  SYSTEM_PROMPT,
  buildAnalysisPrompt,
  coerceAnalysis,
  extractJson,
  type PinAnalysis,
} from "@/lib/analysis";
import {
  ensureSignedIn,
  getPuter,
  loadPuter,
  readChatText,
  type PuterUser,
} from "@/lib/puter";

type Stage = "idle" | "resolving" | "analyzing" | "done" | "error";

type PinData = {
  pinId: string;
  sourceUrl: string;
  canonicalUrl: string | null;
  title: string;
  description: string;
  hashtags: string[];
  thumbnailUrl: string | null;
  videoUrl: string | null;
  hlsUrl: string | null;
  captionsUrl: string | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  boardUrl: string | null;
  creatorName: string | null;
  creatorUsername: string | null;
};

const STAGE_ORDER: Stage[] = ["resolving", "analyzing"];

const STAGE_COPY: Record<Stage, { label: string; detail: string }> = {
  idle: { label: "Idle", detail: "Paste a Pinterest pin to begin." },
  resolving: {
    label: "Scraping Pinterest",
    detail: "Fetching the pin page and extracting the video renditions.",
  },
  analyzing: {
    label: "Analysing with AI",
    detail: "Watching the clip: hook, title, description, hashtags.",
  },
  done: { label: "Complete", detail: "The clip has been analysed." },
  error: { label: "Failed", detail: "Something went wrong. See the log." },
};

type CaptionCue = {
  index: number;
  start: number;
  end: number;
  text: string;
};

type CaptionData = {
  source: string | null;
  language: string | null;
  duration: number | null;
  cues: CaptionCue[];
  timedScript: string[];
};

type HookSourceData = {
  source: string | null;
  language: string | null;
  window: string;
  cues: CaptionCue[];
  script: string;
};

const ANALYSIS_MODEL = "gpt-5.4-nano";

export default function AgentWorkbench() {
  const [url, setUrl] = useState("");
  const [stage, setStage] = useState<Stage>("idle");
  const [log, setLog] = useState<string[]>([]);
  const [pin, setPin] = useState<PinData | null>(null);
  const [transcript, setTranscript] = useState<string | null>(null);
  const [captions, setCaptions] = useState<CaptionData | null>(null);
  const [hookSource, setHookSource] = useState<HookSourceData | null>(null);
  const [analysis, setAnalysis] = useState<PinAnalysis | null>(null);
  const [edited, setEdited] = useState<PinAnalysis | null>(null);
  const [user, setUser] = useState<PuterUser | null>(null);
  const [puterReady, setPuterReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const appendLog = useCallback((line: string) => {
    setLog((prev) => [...prev, line]);
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [log]);

  useEffect(() => {
    let cancelled = false;
    loadPuter()
      .then(() => {
        if (cancelled) return;
        setPuterReady(true);
        appendLog("Puter SDK ready.");
      })
      .catch((e: Error) => {
        if (cancelled) return;
        appendLog(`Puter SDK unavailable: ${e.message}`);
      });
    return () => {
      cancelled = true;
    };
  }, [appendLog]);

  /** The proxied video URL — stable, same-origin and CORS friendly. */
  const videoProxyUrl = useMemo(() => {
    if (!pin) return null;
    const source = pin.videoUrl ?? pin.hlsUrl;
    if (!source) return null;
    const params = new URLSearchParams({ src: source, name: `pinterest-${pin.pinId}.mp4` });
    return `/api/pins/video?${params.toString()}`;
  }, [pin]);

  const runPipeline = useCallback(async () => {
    if (!url.trim()) {
      setError("Paste a Pinterest pin URL first.");
      return;
    }

    setError(null);
    setLog([]);
    setPin(null);
    setTranscript(null);
    setCaptions(null);
    setHookSource(null);
    setAnalysis(null);
    setEdited(null);

    try {
      // ---- Stage 1: resolve the pin -------------------------------------
      setStage("resolving");
      appendLog("Resolving pin…");
      const resolveResponse = await fetch("/api/pins/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });
      const resolveData = await resolveResponse.json();
      if (!resolveResponse.ok) {
        throw new Error(resolveData.error ?? "Could not resolve that pin.");
      }

      const resolvedPin = resolveData.pin as PinData;
      setPin(resolvedPin);
      setTranscript(resolveData.transcript ?? null);
      setCaptions(resolveData.captions ?? null);
      setHookSource(resolveData.hookSource ?? null);
      appendLog(
        `Pin ${resolvedPin.pinId} resolved — ${resolvedPin.hashtags.length} hashtags, ` +
          `${resolvedPin.durationMs ? `${(resolvedPin.durationMs / 1000).toFixed(1)}s` : "duration unknown"}.`,
      );
      if (resolveData.captions?.cues?.length) {
        appendLog(
          `Caption track: ${resolveData.captions.cues.length} cues ` +
            `(${resolveData.captions.language ?? "unknown language"}).`,
        );
      }
      if (!resolvedPin.videoUrl && !resolvedPin.hlsUrl) {
        throw new Error("That pin has no downloadable video.");
      }

      // ---- Stage 2: AI analysis -----------------------------------------
      setStage("analyzing");
      await ensureSignedIn();
      const puter = getPuter();
      const userInfo = await puter.auth.getUser();
      setUser(userInfo);

      const source = resolvedPin.videoUrl ?? resolvedPin.hlsUrl;
      const mediaUrl = `${window.location.origin}/api/pins/video?${new URLSearchParams({
        src: source as string,
        name: `pinterest-${resolvedPin.pinId}.mp4`,
      }).toString()}`;

      appendLog(`Calling ${ANALYSIS_MODEL} with the video as context…`);
      const response = await puter.ai.chat(
        [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: promptFor(
              resolvedPin,
              resolveData.transcript ?? null,
              resolveData.captions ?? null,
            ),
          },
        ],
        mediaUrl,
        false,
        {
          model: ANALYSIS_MODEL,
          outputFormat: {
            type: "json_schema",
            schema: ANALYSIS_JSON_SCHEMA,
            name: "short_package",
            strict: true,
          },
        },
      );

      const raw = readChatText(response);
      const result = coerceAnalysis(extractJson(raw));
      setAnalysis(result);
      setEdited(result);
      appendLog(
        `Analysis complete — hook score ${result.hookScore}/100, ${result.tags.length} tags.`,
      );

      setStage("done");
    } catch (e) {
      const message = e instanceof Error ? e.message : "The pipeline failed.";
      setError(message);
      setStage("error");
      appendLog(`Error: ${message}`);
    }
  }, [url, appendLog]);

  const signIn = useCallback(async () => {
    try {
      const info = await ensureSignedIn();
      setUser(info);
      appendLog(`Signed in as ${info.username}.`);
    } catch (e) {
      appendLog(`Sign-in failed: ${(e as Error).message}`);
    }
  }, [appendLog]);

  const downloadVideo = useCallback(async () => {
    if (!videoProxyUrl) return;
    appendLog("Preparing video download…");
    try {
      const response = await fetch(videoProxyUrl);
      if (!response.ok) throw new Error("Download failed.");
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = `pinterest-${pin?.pinId ?? "video"}.mp4`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
      appendLog("Video downloaded.");
    } catch (e) {
      appendLog(`Download failed: ${(e as Error).message}`);
    }
  }, [videoProxyUrl, pin, appendLog]);

  const copy = useCallback(
    async (label: string, value: string) => {
      try {
        await navigator.clipboard.writeText(value);
        appendLog(`Copied ${label} to clipboard.`);
      } catch {
        appendLog(`Could not copy ${label}.`);
      }
    },
    [appendLog],
  );

  const exportJson = useCallback(() => {
    if (!edited) return;
    const blob = new Blob([JSON.stringify(edited, null, 2)], { type: "application/json" });
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = `pinpilot-${pin?.pinId ?? "analysis"}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(objectUrl);
    appendLog("Analysis exported as JSON.");
  }, [edited, pin, appendLog]);

  const currentStageIndex = STAGE_ORDER.indexOf(stage);
  const busy = stage === "resolving" || stage === "analyzing";

  return (
    <div className="mx-auto w-full max-w-[1400px] px-4 pb-20 pt-8 sm:px-6 lg:px-8">
      <header className="mb-8 flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="mb-2 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] text-white/60">
            <span className="h-1.5 w-1.5 rounded-full bg-mint-400" />
            Agentic pipeline
          </p>
          <h1 className="text-[clamp(2rem,5vw,3.4rem)] font-semibold leading-[1.03] tracking-tight">
            Pin<span className="text-brand-400">Pilot</span>
          </h1>
          <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-white/55">
            Drop a Pinterest video pin. The agent downloads the clip and reverse-engineers
            the hook, title, description and hashtags with AI — then hands you an editable
            breakdown plus the MP4.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="panel-soft flex items-center gap-2 rounded-xl px-3 py-2 text-xs">
            <span
              className={`h-2 w-2 rounded-full ${puterReady ? "bg-mint-400" : "bg-amber-400"}`}
            />
            <span className="text-white/70">
              {puterReady ? "Puter SDK loaded" : "Loading Puter SDK…"}
            </span>
          </div>
          {user ? (
            <div className="panel-soft flex items-center gap-2 rounded-xl px-3 py-2 text-xs text-white/70">
              <span className="font-medium text-white">{user.username}</span>
              <span className="text-white/40">signed in</span>
            </div>
          ) : (
            <button
              type="button"
              onClick={signIn}
              className="panel-soft rounded-xl px-4 py-2 text-xs font-medium text-white/80 transition hover:border-white/20 hover:text-white"
            >
              Sign in with Puter
            </button>
          )}
        </div>
      </header>

      {/* ---- Input ------------------------------------------------------ */}
      <section className="panel rounded-3xl p-5 sm:p-6">
        <label
          htmlFor="pin-url"
          className="mb-2 block text-xs font-medium uppercase tracking-[0.14em] text-white/45"
        >
          Pinterest pin URL
        </label>
        <div className="flex flex-col gap-3 sm:flex-row">
          <input
            id="pin-url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void runPipeline();
            }}
            placeholder="https://www.pinterest.com/pin/10555380372667699/"
            spellCheck={false}
            className="w-full rounded-2xl border border-white/10 bg-black/40 px-4 py-3.5 text-sm text-white outline-none transition placeholder:text-white/25 focus:border-brand-500/60 focus:ring-2 focus:ring-brand-500/25"
          />
          <button
            type="button"
            onClick={() => void runPipeline()}
            disabled={busy}
            className="shrink-0 rounded-2xl bg-gradient-to-r from-brand-500 to-brand-600 px-6 py-3.5 text-sm font-semibold text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50 glow-brand"
          >
            {busy ? "Working…" : "Run agent"}
          </button>
        </div>

        {/* Stage rail */}
        <ol className="mt-6 grid gap-2 sm:grid-cols-3">
          {STAGE_ORDER.map((item, index) => {
            const active = currentStageIndex === index;
            const done = currentStageIndex > index || stage === "done";
            return (
              <li
                key={item}
                className={`rounded-2xl border px-4 py-3 transition ${
                  active
                    ? "border-brand-500/50 bg-brand-500/10"
                    : done
                      ? "border-mint-500/30 bg-mint-500/5"
                      : "border-white/8 bg-white/[0.02]"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold ${
                      done
                        ? "bg-mint-500 text-black"
                        : active
                          ? "bg-brand-500 text-white"
                          : "bg-white/10 text-white/50"
                    }`}
                  >
                    {done ? "✓" : index + 1}
                  </span>
                  <span className="text-[13px] font-medium text-white/85">
                    {STAGE_COPY[item].label}
                  </span>
                </div>
                <p className="mt-1.5 pl-7 text-[11px] leading-snug text-white/40">
                  {STAGE_COPY[item].detail}
                </p>
              </li>
            );
          })}
        </ol>

        {error && (
          <p className="mt-4 rounded-2xl border border-brand-500/40 bg-brand-500/10 px-4 py-3 text-sm text-brand-400">
            {error}
          </p>
        )}
      </section>

      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="space-y-6">
          {/* ---- Video + source metadata -------------------------------- */}
          {pin ? (
            <section className="panel overflow-hidden rounded-3xl">
              <div className="grid gap-0 md:grid-cols-[240px_minmax(0,1fr)]">
                <div className="relative bg-black">
                  {videoProxyUrl ? (
                    <video
                      src={videoProxyUrl}
                      poster={pin.thumbnailUrl ?? undefined}
                      controls
                      playsInline
                      className="h-full max-h-[420px] w-full object-contain"
                    />
                  ) : (
                    <div className="shimmer aspect-[9/16] w-full" />
                  )}
                </div>
                <div className="p-5 sm:p-6">
                  <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px]">
                    <span className="rounded-full bg-mint-500/15 px-2.5 py-1 font-medium text-mint-400">
                      pin {pin.pinId}
                    </span>
                    {pin.durationMs ? (
                      <span className="rounded-full bg-white/8 px-2.5 py-1 text-white/60">
                        {(pin.durationMs / 1000).toFixed(1)}s
                      </span>
                    ) : null}
                    {pin.width && pin.height ? (
                      <span className="rounded-full bg-white/8 px-2.5 py-1 text-white/60">
                        {pin.width}×{pin.height}
                      </span>
                    ) : null}
                    {pin.creatorName ? (
                      <span className="rounded-full bg-white/8 px-2.5 py-1 text-white/60">
                        {pin.creatorName}
                      </span>
                    ) : null}
                  </div>

                  <h2 className="text-[15px] font-semibold leading-snug text-white/95">
                    {pin.title || "Untitled pin"}
                  </h2>
                  <p className="mt-2 max-h-32 overflow-y-auto scroll-thin text-[13px] leading-relaxed text-white/50">
                    {pin.description || "No description."}
                  </p>

                  {pin.hashtags.length > 0 && (
                    <div className="mt-4 flex flex-wrap gap-1.5">
                      {pin.hashtags.map((tag) => (
                        <span
                          key={tag}
                          className="rounded-md bg-accent-500/12 px-2 py-0.5 text-[11px] font-medium text-accent-400"
                        >
                          #{tag}
                        </span>
                      ))}
                    </div>
                  )}

                  <div className="mt-4 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => void downloadVideo()}
                      className="rounded-xl border border-white/12 bg-white/5 px-3.5 py-2 text-[11.5px] font-medium text-white/80 transition hover:border-white/25 hover:text-white"
                    >
                      Download MP4
                    </button>
                    {pin.sourceUrl ? (
                      <a
                        href={pin.sourceUrl}
                        target="_blank"
                        rel="noopener"
                        className="rounded-xl border border-white/12 bg-white/5 px-3.5 py-2 text-[11.5px] font-medium text-white/80 transition hover:border-white/25 hover:text-white"
                      >
                        View on Pinterest
                      </a>
                    ) : null}
                  </div>

                  {captions?.cues?.length ? (
                    <details className="mt-4" open>
                      <summary className="cursor-pointer text-[11px] uppercase tracking-[0.14em] text-white/40 hover:text-white/60">
                        Caption track ({captions.cues.length} cues
                        {captions.language ? ` · ${captions.language}` : ""})
                      </summary>
                      <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto scroll-thin">
                        {captions.cues.map((cue) => (
                          <li
                            key={cue.index}
                            className="flex gap-2.5 text-[12px] leading-snug text-white/50"
                          >
                            <span className="shrink-0 font-mono tabular-nums text-white/25">
                              {formatStamp(cue.start)}
                            </span>
                            <span className="min-w-0">{cue.text}</span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : transcript ? (
                    <details className="mt-4">
                      <summary className="cursor-pointer text-[11px] uppercase tracking-[0.14em] text-white/40">
                        Auto transcript
                      </summary>
                      <p className="mt-2 max-h-40 overflow-y-auto scroll-thin text-[12px] leading-relaxed text-white/50">
                        {transcript}
                      </p>
                    </details>
                  ) : null}
                </div>
              </div>
            </section>
          ) : null}

          {/* ---- AI analysis -------------------------------------------- */}
          {analysis ? (
            <section className="panel rounded-3xl p-5 sm:p-6">
              <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
                <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.14em] text-white/70">
                  <span className="h-1.5 w-1.5 rounded-full bg-accent-400" />
                  AI analysis
                </h2>
                <div className="text-right">
                  <div className="text-2xl font-semibold tabular-nums text-brand-400">
                    {edited?.hookScore ?? analysis.hookScore}
                  </div>
                  <div className="text-[10px] uppercase tracking-[0.14em] text-white/35">
                    hook score
                  </div>
                </div>
              </div>

              <div className="grid gap-5 lg:grid-cols-2">
                <div className="space-y-4">
                  <HookSourcePanel
                    analysis={edited ?? analysis}
                    hookSource={hookSource}
                  />

                  {analysis.hookSummary ? (
                    <div>
                      <p className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-white/40">
                        What the hook does
                      </p>
                      <p className="rounded-2xl border border-white/8 bg-white/[0.02] px-3.5 py-2.5 text-[13px] leading-relaxed text-white/65">
                        {analysis.hookSummary}
                      </p>
                    </div>
                  ) : null}

                  <Field
                    label="Rewritten hook"
                    value={edited?.hook ?? ""}
                    onChange={(value) =>
                      setEdited((prev) => (prev ? { ...prev, hook: value } : prev))
                    }
                    multiline
                  />

                  <div className="rounded-2xl border border-white/8 bg-white/[0.02] p-4">
                    <p className="mb-3 text-[11px] font-medium uppercase tracking-[0.14em] text-white/40">
                      Hook breakdown
                    </p>
                    <div className="space-y-2.5">
                      {(
                        [
                          ["Curiosity gap", "curiosityGap"],
                          ["Emotional intensity", "emotionalIntensity"],
                          ["Specificity", "specificity"],
                          ["Visual surprise", "visualSurprise"],
                          ["Call to action", "callToAction"],
                        ] as const
                      ).map(([label, key]) => {
                        const value = edited?.hookBreakdown?.[key] ?? 0;
                        return (
                          <div key={key}>
                            <div className="mb-1 flex justify-between text-[11px]">
                              <span className="text-white/55">{label}</span>
                              <span className="tabular-nums text-white/40">{value}</span>
                            </div>
                            <div className="h-1.5 overflow-hidden rounded-full bg-white/8">
                              <div
                                className="h-full rounded-full bg-gradient-to-r from-accent-500 to-brand-500 transition-all"
                                style={{ width: `${value}%` }}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    {analysis.hookBreakdown.notes ? (
                      <p className="mt-3 text-[12px] leading-relaxed text-white/45">
                        {edited?.hookBreakdown.notes}
                      </p>
                    ) : null}
                  </div>
                </div>

                <div className="space-y-4">
                  <Field
                    label="Title"
                    value={edited?.title ?? ""}
                    counter={`${(edited?.title ?? "").length}/100`}
                    onChange={(value) =>
                      setEdited((prev) =>
                        prev ? { ...prev, title: value } : prev,
                      )
                    }
                  />
                  <Field
                    label="Description"
                    value={edited?.description ?? ""}
                    multiline
                    rows={6}
                    onChange={(value) =>
                      setEdited((prev) =>
                        prev ? { ...prev, description: value } : prev,
                      )
                    }
                  />

                  <div>
                    <div className="mb-2 flex items-center justify-between">
                      <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-white/40">
                        Tags ({edited?.tags.length ?? 0})
                      </p>
                      <button
                        type="button"
                        onClick={() =>
                          void copy(
                            "tags",
                            (edited?.tags ?? []).map((t) => `#${t}`).join(" "),
                          )
                        }
                        className="text-[10.5px] text-white/40 underline decoration-white/20 underline-offset-2 hover:text-white/70"
                      >
                        copy as hashtags
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {(edited?.tags ?? []).map((tag) => (
                        <span
                          key={tag}
                          className="rounded-md bg-white/8 px-2 py-1 text-[11px] text-white/65"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  </div>

                  <Field
                    label="Thumbnail prompt"
                    value={edited?.thumbnailPrompt ?? ""}
                    multiline
                    onChange={(value) =>
                      setEdited((prev) =>
                        prev ? { ...prev, thumbnailPrompt: value } : prev,
                      )
                    }
                  />

                  {analysis.contentSummary ? (
                    <div>
                      <p className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-white/40">
                        Content summary
                      </p>
                      <p className="rounded-2xl border border-white/8 bg-white/[0.02] px-3.5 py-2.5 text-[13px] leading-relaxed text-white/65">
                        {analysis.contentSummary}
                      </p>
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-white/8 pt-4">
                <button
                  type="button"
                  onClick={exportJson}
                  className="rounded-xl border border-white/12 bg-white/5 px-4 py-2 text-xs font-medium text-white/80 transition hover:border-white/25 hover:text-white"
                >
                  Export JSON
                </button>
                <button
                  type="button"
                  onClick={() => void copy("title", edited?.title ?? "")}
                  className="rounded-xl border border-white/12 bg-white/5 px-4 py-2 text-xs font-medium text-white/80 transition hover:border-white/25 hover:text-white"
                >
                  Copy title
                </button>
                <button
                  type="button"
                  onClick={() => void copy("description", edited?.description ?? "")}
                  className="rounded-xl border border-white/12 bg-white/5 px-4 py-2 text-xs font-medium text-white/80 transition hover:border-white/25 hover:text-white"
                >
                  Copy description
                </button>
              </div>
            </section>
          ) : null}
        </div>

        {/* ---- Side rail ------------------------------------------------- */}
        <aside className="space-y-6">
          <section className="panel rounded-3xl p-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-white/50">
                Agent log
              </h2>
              <span className="text-[11px] text-white/30">{STAGE_COPY[stage].label}</span>
            </div>
            <div
              ref={logRef}
              className="scroll-thin max-h-[320px] space-y-1.5 overflow-y-auto rounded-2xl bg-black/35 p-3.5 font-mono text-[11.5px] leading-relaxed"
            >
              {log.length === 0 ? (
                <p className="text-white/25">Waiting for a pin URL…</p>
              ) : (
                log.map((line, index) => (
                  <p key={index} className="text-white/55">
                    <span className="mr-2 text-white/20">›</span>
                    {line}
                  </p>
                ))
              )}
            </div>
          </section>

          <section className="panel rounded-3xl p-5">
            <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-white/50">
              Pipeline status
            </h2>
            <ul className="space-y-2 text-[12px]">
              <StatusRow label="Pinterest scrape" done={Boolean(pin)} />
              <StatusRow label="AI analysis" done={Boolean(analysis)} active={stage === "analyzing"} />
            </ul>
            {pin ? (
              <p className="mt-4 truncate rounded-xl bg-black/35 px-3 py-2 font-mono text-[10.5px] text-white/45">
                {pin.pinId}.mp4
              </p>
            ) : null}
          </section>

          <section className="panel rounded-3xl p-5">
            <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-white/50">
              How it works
            </h2>
            <ol className="space-y-3 text-[12px] leading-relaxed text-white/50">
              <li>
                <span className="mr-1.5 text-brand-400">1.</span>
                The server scrapes the pin page, parses Pinterest&rsquo;s embedded
                Relay payload and pulls out every MP4 rendition, the caption
                track and the original caption/hashtags.
              </li>
              <li>
                <span className="mr-1.5 text-brand-400">2.</span>
                The clip is streamed through our origin and handed to a Puter AI
                model as video context, alongside the pin&rsquo;s title,
                description and hashtags.
              </li>
              <li>
                <span className="mr-1.5 text-brand-400">3.</span>
                The model returns a scored hook breakdown plus a title,
                description, tags and thumbnail prompt as strict JSON.
              </li>
              <li>
                <span className="mr-1.5 text-brand-400">4.</span>
                You can edit any field, copy it, export the whole analysis as
                JSON, or download the MP4.
              </li>
            </ol>
          </section>
        </aside>
      </div>

      <footer className="mt-12 border-t border-white/8 pt-6 text-center text-[11px] text-white/30">
        Powered by{" "}
        <a
          href="https://developer.puter.com"
          target="_blank"
          rel="noopener"
          className="text-white/50 underline decoration-white/20 underline-offset-2 hover:text-white"
        >
          Puter
        </a>{" "}
        · Pinterest video analysis
      </footer>
    </div>
  );
}

function promptFor(
  pin: PinData,
  transcript: string | null,
  captions: CaptionData | null,
): string {
  return buildAnalysisPrompt({
    title: pin.title,
    description: pin.description,
    hashtags: pin.hashtags,
    durationMs: pin.durationMs,
    creatorName: pin.creatorName,
    transcript,
    timedScript: captions?.timedScript?.join("\n") ?? null,
    captionSource: captions?.source ?? null,
    captionLanguage: captions?.language ?? null,
  });
}

const ORIGIN_LABELS: Record<string, string> = {
  spoken: "Spoken out loud",
  on_screen_text: "On-screen text",
  visual: "Visual only",
  pinterest_caption: "Pinterest caption",
  none: "No hook found",
};

const ORIGIN_STYLES: Record<string, string> = {
  spoken: "bg-mint-500/15 text-mint-400",
  on_screen_text: "bg-accent-500/15 text-accent-400",
  visual: "bg-brand-500/15 text-brand-400",
  pinterest_caption: "bg-amber-500/15 text-amber-400",
  none: "bg-white/8 text-white/45",
};

/**
 * Shows exactly where the hook came from: the verbatim quote, its origin
 * type, the moment it happens, and the caption cues it was drawn from.
 */
function HookSourcePanel({
  analysis,
  hookSource,
}: {
  analysis: PinAnalysis;
  hookSource: HookSourceData | null;
}) {
  const source = analysis.hookSource;
  const origin = source.origin ?? "none";

  return (
    <div className="rounded-2xl border border-white/10 bg-gradient-to-br from-white/[0.06] to-white/[0.02] p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-white/40">
          Hook source
        </p>
        <span
          className={`rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide ${
            ORIGIN_STYLES[origin] ?? ORIGIN_STYLES.none
          }`}
        >
          {ORIGIN_LABELS[origin] ?? origin}
        </span>
      </div>

      {/* The verbatim quote */}
      <blockquote className="rounded-xl border-l-2 border-brand-500/70 bg-black/30 px-3.5 py-3">
        <p className="text-[15px] font-medium leading-snug text-white/95">
          {source.quote || analysis.hookQuote || "—"}
        </p>
      </blockquote>

      {/* Provenance row */}
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[11px]">
        <div>
          <dt className="text-white/35">Timestamp</dt>
          <dd className="mt-0.5 font-mono tabular-nums text-white/75">
            {source.timestamp > 0 ? `${source.timestamp.toFixed(2)}s` : "n/a"}
          </dd>
        </div>
        <div>
          <dt className="text-white/35">Time range</dt>
          <dd className="mt-0.5 font-mono tabular-nums text-white/75">
            {source.timeRange || "n/a"}
          </dd>
        </div>
        <div>
          <dt className="text-white/35">Caption cue</dt>
          <dd className="mt-0.5 font-mono tabular-nums text-white/75">
            {source.cueIndex != null ? `#${source.cueIndex}` : "n/a"}
          </dd>
        </div>
        <div>
          <dt className="text-white/35">Language</dt>
          <dd className="mt-0.5 font-mono tabular-nums text-white/75">
            {hookSource?.language ?? "n/a"}
          </dd>
        </div>
      </dl>

      {source.label ? (
        <p className="mt-3 border-t border-white/8 pt-2.5 text-[11px] text-white/40">
          {source.label}
        </p>
      ) : null}

      {/* The underlying caption cues, so the quote can be traced back */}
      {hookSource?.cues?.length ? (
        <details className="mt-3 border-t border-white/8 pt-3">
          <summary className="cursor-pointer text-[10.5px] uppercase tracking-[0.14em] text-white/40 hover:text-white/60">
            Source cues (0:00 – {hookSource.window.split(" - ")[1] ?? "0:15"})
          </summary>
          <ul className="mt-2 space-y-1.5">
            {hookSource.cues.map((cue) => {
              const isSource =
                source.cueIndex != null && cue.index === source.cueIndex;
              return (
                <li
                  key={cue.index}
                  className={`flex gap-2.5 rounded-lg px-2 py-1.5 text-[11.5px] leading-snug ${
                    isSource
                      ? "bg-brand-500/12 text-white/90 ring-1 ring-brand-500/30"
                      : "text-white/45"
                  }`}
                >
                  <span className="shrink-0 font-mono tabular-nums text-white/30">
                    {formatStamp(cue.start)}
                  </span>
                  <span className="min-w-0">{cue.text}</span>
                </li>
              );
            })}
          </ul>
        </details>
      ) : (
        <p className="mt-3 border-t border-white/8 pt-3 text-[11px] text-white/35">
          This pin has no caption track, so the hook was read from the video frame
          and the pin&rsquo;s own caption.
        </p>
      )}
    </div>
  );
}

function formatStamp(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  const secs = whole % 60;
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function Field({
  label,
  value,
  onChange,
  multiline,
  rows = 3,
  muted,
  counter,
}: {
  label: string;
  value: string;
  onChange?: (value: string) => void;
  multiline?: boolean;
  rows?: number;
  muted?: boolean;
  counter?: string;
}) {
  const shared =
    "w-full rounded-2xl border border-white/10 bg-black/35 px-3.5 py-2.5 text-[13px] leading-relaxed text-white/90 outline-none transition placeholder:text-white/25 focus:border-accent-500/50 focus:ring-2 focus:ring-accent-500/20";

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <label className="text-[11px] font-medium uppercase tracking-[0.14em] text-white/40">
          {label}
        </label>
        {counter ? (
          <span className="text-[10.5px] tabular-nums text-white/30">{counter}</span>
        ) : null}
      </div>
      {multiline ? (
        <textarea
          value={value}
          rows={rows}
          readOnly={!onChange}
          onChange={(event) => onChange?.(event.target.value)}
          className={`${shared} resize-y ${muted ? "text-white/55" : ""}`}
        />
      ) : (
        <input
          value={value}
          readOnly={!onChange}
          onChange={(event) => onChange?.(event.target.value)}
          className={`${shared} ${muted ? "text-white/55" : ""}`}
        />
      )}
    </div>
  );
}

function StatusRow({
  label,
  done,
  active,
}: {
  label: string;
  done?: boolean;
  active?: boolean;
}) {
  return (
    <li className="flex items-center justify-between">
      <span className="text-white/55">{label}</span>
      <span
        className={`flex items-center gap-1.5 text-[11px] ${
          done ? "text-mint-400" : active ? "text-brand-400" : "text-white/25"
        }`}
      >
        <span
          className={`h-1.5 w-1.5 rounded-full ${
            done ? "bg-mint-400" : active ? "bg-brand-400 pulse-ring" : "bg-white/15"
          }`}
        />
        {done ? "done" : active ? "running" : "pending"}
      </span>
    </li>
  );
}
