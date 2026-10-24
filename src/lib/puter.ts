"use client";

/**
 * Thin, typed wrapper around the Puter.js SDK.
 *
 * Puter is loaded from its CDN at runtime (see `PuterProvider`), so the
 * global `puter` object is not guaranteed to exist on first render. Every
 * helper here waits for the SDK to be ready and gives a readable error if the
 * user has to sign in first.
 */

export interface PuterUser {
  username: string;
  email?: string;
  uuid?: string;
}

declare global {
  interface Window {
    puter?: PuterGlobal;
  }
}

export interface PuterFSItem {
  name: string;
  path: string;
  size: number;
  is_dir?: boolean;
}

export interface PuterGlobal {
  auth: {
    signIn(options?: { redirect?: boolean }): Promise<PuterUser>;
    signOut(): Promise<void>;
    isSignedIn(redirect?: boolean): Promise<boolean>;
    getUser(): Promise<PuterUser>;
  };
  fs: {
    read(path: string): Promise<Blob>;
    stat(path: string): Promise<PuterFSItem>;
  };
  ai: {
    chat(
      prompt: string | unknown[],
      media?: string | File | string[],
      testMode?: boolean,
      options?: Record<string, unknown>,
    ): Promise<PuterChatResponse>;
  };
  ui: {
    alert(message: string): Promise<void>;
    notify?(options: Record<string, unknown>): Promise<void>;
  };
}

export interface PuterChatResponse {
  message?: {
    content?: string | Array<{ type: string; text?: string }>;
  };
  text?: string;
  toString(): string;
}

const SDK_URL = "https://js.puter.com/v2/";
const SDK_TIMEOUT_MS = 15000;

let sdkPromise: Promise<void> | null = null;

/** Loads Puter.js from the CDN exactly once and resolves when `window.puter` is ready. */
export function loadPuter(): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Puter can only be used in the browser."));
  }
  if (window.puter) return Promise.resolve();
  if (sdkPromise) return sdkPromise;

  sdkPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${SDK_URL}"]`,
    );
    if (existing) {
      if (window.puter) {
        resolve();
        return;
      }
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () =>
        reject(new Error("Could not load the Puter SDK.")),
      );
      return;
    }

    const script = document.createElement("script");
    script.src = SDK_URL;
    script.async = true;
    script.onload = () => {
      if (window.puter) resolve();
      else reject(new Error("The Puter SDK loaded but did not register itself."));
    };
    script.onerror = () => reject(new Error("Could not load the Puter SDK."));
    document.head.appendChild(script);

    window.setTimeout(
      () => reject(new Error("Timed out loading the Puter SDK.")),
      SDK_TIMEOUT_MS,
    );
  });

  return sdkPromise;
}

export function getPuter(): PuterGlobal {
  if (typeof window === "undefined" || !window.puter) {
    throw new Error("Puter is not ready yet.");
  }
  return window.puter;
}

/** Normalises the many shapes a chat response can take into plain text. */
export function readChatText(response: PuterChatResponse): string {
  const content = response?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("");
  }
  if (typeof response?.text === "string") return response.text;
  return String(response ?? "");
}

/** Signs the user in, showing the Puter auth dialog when needed. */
export async function ensureSignedIn(): Promise<PuterUser> {
  const puter = getPuter();
  if (await puter.auth.isSignedIn()) {
    return puter.auth.getUser();
  }
  return puter.auth.signIn({ redirect: true });
}
