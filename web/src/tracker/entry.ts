import { start } from "./tracker";

const s = document.currentScript as HTMLScriptElement | null;
const key = s?.getAttribute("data-site-key");
if (s && key) {
  start({
    win: window,
    siteKey: key,
    origin: new URL(s.src, location.href).origin,
    consent: s.getAttribute("data-consent") === "manual" ? "manual" : "auto",
  });
}
