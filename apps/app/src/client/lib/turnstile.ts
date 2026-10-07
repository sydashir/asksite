// Cloudflare Turnstile's explicit rendering (developers.cloudflare.com/turnstile/get-started/client-side-rendering/):
// load api.js?render=explicit, then turnstile.render(container, { sitekey, action, size, callback, ... }).
// Only the sign-in form loads it (the script never appears on any other page).

import type { WidgetSize } from "./widget-size.ts";

const SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

export interface RenderOptions {
  sitekey: string;
  action: string;
  size: WidgetSize;
  callback: (token: string) => void;
  "error-callback": () => void;
  "expired-callback": () => void;
}

interface TurnstileApi {
  render: (container: HTMLElement, options: RenderOptions) => string;
  reset: (widgetId: string) => void;
  remove: (widgetId: string) => void;
}

let loading: Promise<TurnstileApi> | null = null;

/** Loads Cloudflare's script once. A failed load is forgotten, so a later attempt can retry. */
export function loadTurnstile(): Promise<TurnstileApi> {
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_URL;
    script.async = true;
    script.onload = () => {
      const api = (window as unknown as { turnstile?: TurnstileApi }).turnstile;
      if (api === undefined) reject(new Error("Turnstile did not start"));
      else resolve(api);
    };
    script.onerror = () => reject(new Error("Turnstile did not load"));
    document.head.appendChild(script);
  }).catch((error: unknown) => {
    loading = null;
    throw error;
  });
  return loading;
}
