/**
 * First-party tracker. Built to public/t.js (see entry.ts). Sends anonymous events only:
 * never form field values, never e-mail / phone / name, no cookies (first touch lives in localStorage).
 */
export type Consent = "auto" | "manual";
export type TrackProps = { value?: number; currency?: string };
export type AdsTrack = ((name: string, props?: TrackProps) => void) & { consent: () => void };

declare global {
  interface Window {
    adsTrack: AdsTrack;
  }
}

const KEY = "adsmcp_ft";
const TTL_MS = 30 * 24 * 3600 * 1000;
const ID = /^\d{1,25}$/;

type FirstTouch = { sid: string; ts: number; campaign_id: string | null; adset_id: string | null; ad_id: string | null; src: string | null; fbclid: string | null };

function randomId(win: Window): string {
  const a = new Uint8Array(16);
  win.crypto.getRandomValues(a);
  return Array.from(a, (b) => (b < 16 ? "0" : "") + b.toString(16)).join("");
}

export function start(opts: { win: Window; siteKey: string; origin: string; consent: Consent }) {
  const { win, siteKey, origin } = opts;
  const endpoint = origin.replace(/\/+$/, "") + "/api/collect?k=" + encodeURIComponent(siteKey);
  let active = opts.consent !== "manual";
  let memory: FirstTouch | null = null;

  const readStore = (): FirstTouch | null => {
    try {
      const raw = win.localStorage.getItem(KEY);
      return raw ? (JSON.parse(raw) as FirstTouch) : null;
    } catch {
      return memory;
    }
  };
  const writeStore = (ft: FirstTouch) => {
    memory = ft;
    try {
      win.localStorage.setItem(KEY, JSON.stringify(ft));
    } catch {
      /* storage blocked: keep in memory for this page only */
    }
  };
  const id = (v: string | null) => (v && ID.test(v) ? v : null);

  function firstTouch(): FirstTouch {
    const now = Date.now();
    const q = new URL(win.location.href).searchParams;
    let ft = readStore();
    if (!ft || typeof ft.ts !== "number" || now - ft.ts > TTL_MS || typeof ft.sid !== "string") ft = null;
    const fromUrl = { campaign_id: id(q.get("utm_campaign")), adset_id: id(q.get("utm_term")), ad_id: id(q.get("utm_content")) };
    const hasUrlIds = !!(fromUrl.campaign_id || fromUrl.adset_id || fromUrl.ad_id);
    if (!ft) {
      ft = { sid: randomId(win), ts: now, ...fromUrl, src: q.get("utm_source")?.slice(0, 40) ?? null, fbclid: q.get("fbclid")?.slice(0, 200) ?? null };
      writeStore(ft);
    } else if (!ft.ad_id && !ft.adset_id && !ft.campaign_id && hasUrlIds) {
      ft = { ...ft, ...fromUrl, ts: now };
      writeStore(ft);
    }
    return ft;
  }

  function send(event: string, props: TrackProps = {}) {
    if (!active) return;
    const ft = firstTouch();
    const value = typeof props.value === "number" && Number.isFinite(props.value) && props.value >= 0 ? props.value : null;
    const currency = typeof props.currency === "string" && /^[A-Z]{3}$/.test(props.currency) ? props.currency : null;
    const body = JSON.stringify({
      site_key: siteKey,
      session_id: ft.sid,
      event,
      campaign_id: ft.campaign_id,
      adset_id: ft.adset_id,
      ad_id: ft.ad_id,
      url: win.location.origin + win.location.pathname,
      value,
      currency,
    });
    try {
      if (win.navigator.sendBeacon && win.navigator.sendBeacon(endpoint, body)) return;
      void win.fetch(endpoint, { method: "POST", body, keepalive: true, mode: "cors", credentials: "omit" }).catch(() => {});
    } catch {
      /* tracking must never break the page */
    }
  }

  // Dwell time = time the document was visible. visibilitychange is the reliable signal on iOS Safari and
  // in-app browsers (pagehide often never fires); whichever comes first sends the one page_leave.
  const isVisible = () => win.document.visibilityState !== "hidden";
  let visibleMs = 0;
  let visibleSince: number | null = isVisible() ? Date.now() : null;
  let left = false;
  const leave = () => {
    if (left) return;
    try {
      if (visibleSince !== null) {
        visibleMs += Math.max(0, Date.now() - visibleSince);
        visibleSince = null;
      }
      if (!active) return;            // nothing before consent; a later hide/pagehide may still report
      left = true;
      send("page_leave", { value: Math.min(86400, Math.max(0, Math.floor(visibleMs / 1000))) });
    } catch {
      /* tracking must never break the page */
    }
  };
  win.addEventListener("pagehide", leave);
  win.document.addEventListener("visibilitychange", () => {
    try {
      if (!isVisible()) leave();
      else if (!left && visibleSince === null) visibleSince = Date.now();
    } catch {
      /* tracking must never break the page */
    }
  });

  const track = ((name: string, props?: TrackProps) => send(String(name), props)) as AdsTrack;
  track.consent = () => {
    if (active) return;
    active = true;
    send("page_view");
  };
  win.adsTrack = track;

  win.document.addEventListener("submit", () => send("form_submit"), true);
  send("page_view");
  return track;
}
