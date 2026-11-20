// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { start } from "./tracker";

const ORIGIN = "https://app.example";
let beacon: ReturnType<typeof vi.fn>;
const sent = () => beacon.mock.calls.map(([url, body]) => ({ url: url as string, body: JSON.parse(body as string) }));

function go(url: string) {
  window.history.pushState({}, "", url);
}
function boot(consent: "auto" | "manual" = "auto") {
  return start({ win: window, siteKey: "sk_test", origin: ORIGIN, consent });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-20T10:00:00Z"));
  localStorage.clear();
  go("/");
  beacon = vi.fn(() => true);
  Object.defineProperty(window.navigator, "sendBeacon", { value: beacon, configurable: true });
  delete (window as any).adsTrack;
});
afterEach(() => vi.useRealTimers());

describe("tracker", () => {
  it("sends a page view on load with ad ids from utm parameters", () => {
    go("/landing?utm_source=facebook&utm_campaign=111&utm_term=222&utm_content=333&fbclid=abc");
    boot();
    const [m] = sent();
    expect(m.url).toBe(`${ORIGIN}/api/collect?k=sk_test`);   // key in the URL lets the collector answer CORS preflight
    expect(m.body).toMatchObject({ site_key: "sk_test", event: "page_view", campaign_id: "111", adset_id: "222", ad_id: "333" });
    expect(m.body.session_id).toMatch(/^[0-9a-f]{32}$/);
    expect(m.body.url).toBe("http://localhost:3000/landing");
  });

  it("first touch persists and a later form_submit carries the stored ad ids", () => {
    go("/?utm_campaign=111&utm_term=222&utm_content=333");
    boot();
    const sid = sent()[0].body.session_id;
    expect(JSON.parse(localStorage.getItem("adsmcp_ft")!).ad_id).toBe("333");
    delete (window as any).adsTrack;
    beacon.mockClear();
    go("/thanks");
    boot();
    window.adsTrack("form_submit");
    const last = sent().at(-1)!.body;
    expect(last).toMatchObject({ event: "form_submit", campaign_id: "111", adset_id: "222", ad_id: "333", session_id: sid });
  });

  it("keeps the first touch when a later URL carries different ad ids", () => {
    go("/?utm_content=333");
    boot();
    delete (window as any).adsTrack;
    go("/?utm_content=999");
    boot();
    expect(sent().at(-1)!.body.ad_id).toBe("333");
  });

  it("drops an expired (31 day) first touch and starts a new session", () => {
    go("/?utm_content=333");
    boot();
    const first = sent()[0].body.session_id;
    delete (window as any).adsTrack;
    vi.setSystemTime(new Date("2026-12-21T10:00:00Z"));
    beacon.mockClear();
    go("/");
    boot();
    const b = sent()[0].body;
    expect(b.ad_id).toBeNull();
    expect(b.session_id).not.toBe(first);
  });

  it("keeps a 29 day old first touch", () => {
    go("/?utm_content=333");
    boot();
    delete (window as any).adsTrack;
    vi.setSystemTime(new Date("2026-12-19T10:00:00Z"));
    go("/");
    boot();
    expect(sent().at(-1)!.body.ad_id).toBe("333");
  });

  it("ignores unfilled macros and non numeric ids", () => {
    go("/?utm_campaign={{campaign.id}}&utm_term=<x>&utm_content=333");
    boot();
    expect(sent()[0].body).toMatchObject({ campaign_id: null, adset_id: null, ad_id: "333" });
  });

  it("manual consent mode sends and stores nothing until adsTrack.consent()", () => {
    go("/?utm_content=333");
    boot("manual");
    window.adsTrack("add_to_cart");
    expect(beacon).not.toHaveBeenCalled();
    expect(localStorage.getItem("adsmcp_ft")).toBeNull();
    window.adsTrack.consent();
    expect(sent().map((s) => s.body.event)).toEqual(["page_view"]);
    expect(sent()[0].body.ad_id).toBe("333");
    window.adsTrack("add_to_cart", { value: 10, currency: "INR" });
    expect(sent().at(-1)!.body).toMatchObject({ event: "add_to_cart", value: 10, currency: "INR" });
  });

  it("auto form detection sends form_submit and never any field values", () => {
    boot();
    document.body.innerHTML = `<form id="f"><input name="email" value="a@b.com"><input name="phone" value="9999999999"><input name="name" value="Asha"></form>`;
    document.getElementById("f")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    const b = sent().at(-1)!.body;
    expect(b.event).toBe("form_submit");
    expect(JSON.stringify(b)).not.toMatch(/a@b\.com|9999999999|Asha/);
  });

  it("payload contains no email, phone or name keys and ignores bad props", () => {
    boot();
    window.adsTrack("purchase", { value: Number.NaN, currency: "rupees", email: "x@y.z", name: "N" } as any);
    for (const { body } of sent()) {
      expect(Object.keys(body).filter((k) => /^(email|phone|name)$/i.test(k))).toEqual([]);
    }
    expect(sent().at(-1)!.body).toMatchObject({ value: null, currency: null });
  });

  it("works when localStorage is unavailable", () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    expect(() => boot()).not.toThrow();
    expect(sent()).toHaveLength(1);
    spy.mockRestore();
  });
});
