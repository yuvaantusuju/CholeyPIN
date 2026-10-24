/**
 * Pinterest video pin resolver.
 *
 * Pinterest does not expose a public API for pin media, but every public pin
 * page embeds the pin record inside a server-rendered Relay payload:
 *
 *   window.__PWS_RELAY_REGISTER_COMPLETED_REQUEST__("<encoded-query-id>", {<pin json>})
 *
 * We fetch the page, locate that call, and pull the pin object out of it. We
 * fall back to OpenGraph meta tags and a raw URL scan when the Relay payload
 * is missing (e.g. for story/idea pins).
 */

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const PINTEREST_HOSTS = [
  "pinterest.com",
  "pinterest.co.uk",
  "pinterest.ca",
  "pinterest.com.au",
  "pinterest.fr",
  "pinterest.de",
  "pinterest.it",
  "pinterest.es",
  "pinterest.in",
  "pinterest.co.nz",
  "pinterest.ie",
  "pinterest.pt",
  "pinterest.se",
  "pinterest.ch",
  "pinterest.at",
  "pinterest.be",
  "pinterest.dk",
  "pinterest.nl",
  "pinterest.no",
  "pinterest.pl",
  "pinterest.cz",
  "pinterest.ru",
  "pinterest.jp",
  "pinterest.mx",
  "pinterest.com.br",
  "pinterest.com.ar",
  "pinterest.cl",
  "pinterest.co.id",
  "pinterest.ph",
  "pinterest.vn",
  "pinterest.co.kr",
  "pinterest.com.tw",
  "pinterest.com.my",
  "pinterest.com.sg",
  "pinterest.ae",
  "pinterest.sa",
  "pinterest.eg",
  "pinterest.co.za",
  "pin.it",
];

/** The pin id is the numeric segment of /pin/<id>/ — also present in pin.it short links after redirect. */
export function extractPinId(input: string): string | null {
  const trimmed = input.trim();
  const match = trimmed.match(/\/pin\/(\d{6,})/);
  if (match) return match[1];
  const bare = trimmed.match(/^(\d{9,})$/);
  if (bare) return bare[1];
  return null;
}

export function isPinterestUrl(input: string): boolean {
  try {
    const url = new URL(input.trim());
    return PINTEREST_HOSTS.some(
      (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
    );
  } catch {
    return false;
  }
}

/** Pull every `#tag` out of free text, lowercased and de-duplicated, order preserved. */
export function extractHashtags(...texts: (string | null | undefined)[]): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    const matches = text.matchAll(/#([\p{L}\p{N}_]{1,60})/gu);
    for (const match of matches) {
      const tag = match[1].toLowerCase();
      if (!seen.has(tag)) {
        seen.add(tag);
        found.push(tag);
      }
    }
  }
  return found;
}

function decodeJsStringLiteral(source: string, start: number): { value: string; end: number } {
  // `start` points at the opening quote of a double-quoted JS string.
  let i = start + 1;
  let value = "";
  while (i < source.length) {
    const char = source[i];
    if (char === "\\") {
      const next = source[i + 1];
      if (next === "n") value += "\n";
      else if (next === "t") value += "\t";
      else if (next === "r") value += "\r";
      else if (next === "u") {
        value += String.fromCharCode(parseInt(source.slice(i + 2, i + 6), 16));
        i += 6;
        continue;
      } else value += next;
      i += 2;
      continue;
    }
    if (char === '"') return { value, end: i + 1 };
    value += char;
    i += 1;
  }
  return { value, end: i };
}

/** Find the end of a `fn(...)` call, respecting nested parens and string literals. */
function findCallEnd(source: string, openParenIndex: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = openParenIndex; i < source.length; i += 1) {
    const char = source[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split the top-level arguments of a call body on commas outside strings/parens. */
function splitTopLevelArgs(body: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let current = "";
  for (const char of body) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      current += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      current += char;
      continue;
    }
    if (!inString) {
      if (char === "(" || char === "[" || char === "{") depth += 1;
      else if (char === ")" || char === "]" || char === "}") depth -= 1;
      else if (char === "," && depth === 0) {
        args.push(current);
        current = "";
        continue;
      }
    }
    current += char;
  }
  if (current.trim()) args.push(current);
  return args;
}

/** Walk an arbitrary JSON blob looking for the first object that looks like a pin. */
function findPinObject(node: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 12 || !node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findPinObject(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const record = node as Record<string, unknown>;
  const looksLikePin =
    typeof record.entityId === "string" &&
    (typeof record.gridTitle === "string" || typeof record.description === "string");
  if (looksLikePin) return record;
  for (const value of Object.values(record)) {
    const found = findPinObject(value, depth + 1);
    if (found) return found;
  }
  return null;
}

function parseRelayPin(html: string): Record<string, unknown> | null {
  const marker = "window.__PWS_RELAY_REGISTER_COMPLETED_REQUEST__(";
  let searchFrom = 0;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const idx = html.indexOf(marker, searchFrom);
    if (idx === -1) break;
    const openParen = idx + marker.length - 1;
    const end = findCallEnd(html, openParen);
    if (end === -1) break;
    const body = html.slice(openParen + 1, end);
    const args = splitTopLevelArgs(body);
    // The second argument is the inline response payload.
    for (const arg of args.slice(1)) {
      const trimmed = arg.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        const pin = findPinObject(parsed);
        if (pin) return pin;
      } catch {
        // keep looking
      }
    }
    // The first argument is a percent-encoded query descriptor; sometimes the
    // response is nested inside it.
    for (const arg of args.slice(0, 1)) {
      const trimmed = arg.trim();
      if (!trimmed.startsWith('"')) continue;
      const literal = decodeJsStringLiteral(trimmed, 0);
      try {
        const decoded = decodeURIComponent(literal.value);
        const parsed = JSON.parse(decoded) as unknown;
        const pin = findPinObject(parsed);
        if (pin) return pin;
      } catch {
        // keep looking
      }
    }
    searchFrom = end;
  }
  return null;
}

function parseMeta(html: string, name: string): string | null {
  const patterns = [
    new RegExp(
      `<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']*)["']`,
      "i",
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${name}["']`,
      "i",
    ),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return decodeEntities(match[1]);
  }
  return null;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));
}

/** Pick the best progressive MP4 out of Pinterest's rendition list. */
export function pickBestMp4(urls: string[]): string | null {
  if (!urls.length) return null;
  const mp4s = urls.filter((url) => url.includes(".mp4") && !url.includes(".mpd"));
  if (!mp4s.length) return null;

  const score = (url: string): number => {
    let value = 0;
    const width = url.match(/_(\d{3,4})w/);
    if (width) value += Number(width[1]);
    if (url.includes("expMp4")) value += 2000;
    if (url.includes("hevcMp4")) value += 1500;
    if (url.includes("h265")) value += 1200;
    if (url.includes("av1")) value += 800;
    if (url.includes("_720w")) value += 720;
    return value;
  };

  return mp4s.sort((a, b) => score(b) - score(a))[0] ?? null;
}

export interface ResolvedPin {
  pinId: string;
  sourceUrl: string;
  canonicalUrl: string;
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
  boardName: string | null;
  boardUrl: string | null;
  creatorName: string | null;
  creatorUsername: string | null;
  saveCount: number | null;
  repinCount: number | null;
  commentCount: number | null;
  sourceLink: string | null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function pickVideoList(pin: Record<string, unknown>): Record<string, unknown> | null {
  const videos = pin.videos as Record<string, unknown> | undefined;
  if (!videos) return null;
  const videoList = videos.videoList as Record<string, unknown> | undefined;
  return videoList && typeof videoList === "object" ? videoList : null;
}

function entryUrl(entry: unknown): string | null {
  if (!entry || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  return asString(record.url);
}

function captionsFrom(entry: unknown): string | null {
  if (!entry || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  const captions = record.captionsUrls as Record<string, string> | undefined;
  if (!captions) return null;
  const values = Object.values(captions);
  return values[0] ?? null;
}

/**
 * Resolve a Pinterest pin (by URL or id) into its media + metadata.
 * Throws when the pin does not exist, is not a video pin, or is unreachable.
 */
export async function resolvePin(input: string): Promise<ResolvedPin> {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Provide a Pinterest pin URL.");
  if (!isPinterestUrl(trimmed) && !extractPinId(trimmed)) {
    throw new Error("That does not look like a Pinterest pin URL.");
  }

  const url = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://www.pinterest.com/pin/${extractPinId(trimmed)}/`;

  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
    redirect: "follow",
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(
      response.status === 404
        ? "That Pinterest pin could not be found (it may be private or deleted)."
        : `Pinterest responded with ${response.status}.`,
    );
  }

  const html = await response.text();
  const finalUrl = response.url || url;
  const relayPin = parseRelayPin(html);

  // `pin.it` short links redirect to a landing page whose URL does not always
  // contain the numeric id, so fall back to the pin record itself and the
  // og:url meta tag before giving up.
  const pinId =
    extractPinId(finalUrl) ??
    extractPinId(url) ??
    extractPinId(parseMeta(html, "og:url") ?? "") ??
    (asString(relayPin?.entityId) ?? "");

  if (!pinId) {
    throw new Error(
      "Could not read a pin id from that URL. Make sure it is a link to a public Pinterest pin.",
    );
  }
  const allUrls = relayPin
    ? ((relayPin.videos as Record<string, unknown> | undefined)?.videoUrls as string[] | undefined) ?? []
    : [];
  if (!allUrls.length) {
    const scanned = html.match(/https:\/\/v1\.pinimg\.com\/videos\/[^"'\\\s]+/g) ?? [];
    allUrls.push(...scanned);
  }

  const videoList = relayPin ? pickVideoList(relayPin) : null;
  const v720 = videoList?.v720P;
  const vHls = videoList?.vHLSV4;

  const title =
    asString(relayPin?.gridTitle) ??
    asString(relayPin?.seoTitle) ??
    parseMeta(html, "og:title") ??
    "";

  const description =
    asString(relayPin?.description) ??
    asString(relayPin?.gridDescription) ??
    parseMeta(html, "og:description") ??
    "";

  const videoUrl =
    entryUrl(v720) ??
    pickBestMp4(allUrls) ??
    (allUrls.find((u) => u.includes(".mp4") && !u.includes(".mpd")) ?? null);

  const hlsUrl = entryUrl(vHls) ?? allUrls.find((u) => u.endsWith(".m3u8")) ?? null;

  if (!videoUrl && !hlsUrl) {
    throw new Error(
      "No video found on that pin. It may be an image pin — this tool only handles video pins.",
    );
  }

  const board = relayPin?.board as Record<string, unknown> | undefined;
  const pinner = relayPin?.pinner as Record<string, unknown> | undefined;
  const attribution = relayPin?.closeupAttribution as Record<string, unknown> | undefined;
  const stats = (relayPin?.aggregatedPinData as Record<string, unknown> | undefined)
    ?.aggregated_stats as Record<string, unknown> | undefined;

  const durationMs =
    asNumber((v720 as Record<string, unknown> | undefined)?.duration) ??
    asNumber((vHls as Record<string, unknown> | undefined)?.duration) ??
    null;

  const thumbnailUrl =
    asString(relayPin?.images_736x && (relayPin.images_736x as Record<string, unknown>).url) ??
    asString(relayPin?.imageSignature
      ? `https://i.pinimg.com/736x/${relayPin.imageSignature}.jpg`
      : null) ??
    parseMeta(html, "og:image");

  return {
    pinId,
    sourceUrl: url,
    canonicalUrl: relayPin
      ? asString((relayPin.pinJoin as Record<string, unknown> | undefined)?.seoCanonicalUrl)
        ? `https://www.pinterest.com${(relayPin.pinJoin as Record<string, unknown>).seoCanonicalUrl as string}`
        : finalUrl
      : finalUrl,
    title,
    description,
    hashtags: extractHashtags(title, description),
    thumbnailUrl,
    videoUrl,
    hlsUrl,
    captionsUrl: captionsFrom(v720) ?? captionsFrom(vHls),
    durationMs,
    width: asNumber((v720 as Record<string, unknown> | undefined)?.width),
    height: asNumber((v720 as Record<string, unknown> | undefined)?.height),
    boardName: asString(board?.name),
    boardUrl: asString(board?.url)
      ? `https://www.pinterest.com${board?.url as string}`
      : null,
    creatorName:
      asString(pinner?.full_name) ??
      asString(attribution?.fullName) ??
      null,
    creatorUsername:
      asString(pinner?.username) ??
      (asString(board?.url) ? (board?.url as string).split("/").filter(Boolean)[0] : null),
    saveCount: asNumber(stats?.aggregated_save_count),
    repinCount: asNumber(stats?.repin_count),
    commentCount: asNumber(stats?.aggregated_comment_count),
    sourceLink: asString(relayPin?.link),
  };
}

/** Read a caption track (WebVTT) and turn it into a plain transcript string. */
export async function fetchTranscript(captionsUrl: string): Promise<string | null> {
  try {
    const response = await fetch(captionsUrl, {
      headers: { "User-Agent": USER_AGENT },
      cache: "no-store",
    });
    if (!response.ok) return null;
    const vtt = await response.text();
    return vtt
      .replace(/^WEBVTT.*$/gm, "")
      .replace(/^\d+$/gm, "")
      .replace(/(\d{2}:\d{2}:\d{2}\.\d{3} --> .*)$/gm, "")
      .replace(/<[^>]+>/g, "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .join(" ");
  } catch {
    return null;
  }
}
