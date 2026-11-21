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
const pagehide: EventListener[] = [];
const vis: EventListener[] = [];
const realAdd = window.addEventListener.bind(window);
const realDocAdd = document.addEventListener.bind(document);
let hidden = false;
beforeEach(() => {
  hidden = false;
  Object.defineProperty(document, "visibilityState", { get: () => (hidden ? "hidden" : "visible"), configurable: true });
  vi.spyOn(window, "addEventListener").mockImplementation(((t: string, l: EventListener, o?: any) => {
    if (t === "pagehide") pagehide.push(l);
    realAdd(t, l, o);
  }) as any);
  vi.spyOn(document, "addEventListener").mockImplementation(((t: string, l: EventListener, o?: any) => {
    if (t === "visibilitychange") vis.push(l);
    realDocAdd(t, l, o);
  }) as any);
});
const setHidden = (h: boolean) => { hidden = h; document.dispatchEvent(new Event("visibilitychange")); };
afterEach(() => {
  while (pagehide.length) window.removeEventListener("pagehide", pagehide.pop()!);   // one tracker per test
  while (vis.length) document.removeEventListener("visibilitychange", vis.pop()!);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

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

  describe("page_leave", () => {
    const leaves = () => sent().filter((s) => s.body.event === "page_leave");

    it("sends one page_leave on pagehide with whole seconds on the page, and not again", () => {
      boot();
      vi.advanceTimersByTime(12_700);
      window.dispatchEvent(new Event("pagehide"));
      window.dispatchEvent(new Event("pagehide"));
      expect(leaves()).toHaveLength(1);
      expect(leaves()[0].body).toMatchObject({ event: "page_leave", value: 12, currency: null });
    });

    it("sends page_leave when the page becomes hidden, once, even if pagehide follows", () => {
      boot();
      vi.advanceTimersByTime(5_200);
      setHidden(true);
      window.dispatchEvent(new Event("pagehide"));
      setHidden(false);
      setHidden(true);
      expect(leaves()).toHaveLength(1);
      expect(leaves()[0].body.value).toBe(5);
    });

    it("does nothing on visibilitychange to visible", () => {
      boot();
      setHidden(false);
      expect(leaves()).toHaveLength(0);
    });

    it("sends page_leave from visibilitychange alone (no pagehide) with the visible seconds", () => {
      boot();
      vi.advanceTimersByTime(4_000);
      setHidden(true);
      expect(leaves()).toHaveLength(1);
      expect(leaves()[0].body.value).toBe(4);
    });

    it("excludes hidden time when the page starts hidden then becomes visible", () => {
      hidden = true;
      boot();
      vi.advanceTimersByTime(60_000);
      setHidden(false);
      vi.advanceTimersByTime(7_000);
      window.dispatchEvent(new Event("pagehide"));
      expect(leaves()[0].body.value).toBe(7);
    });

    it("manual consent: nothing on hidden before consent", () => {
      boot("manual");
      setHidden(true);
      expect(beacon).not.toHaveBeenCalled();
    });

    it("never throws on visibilitychange when sendBeacon and fetch both fail", () => {
      (beacon as any).mockImplementation(() => { throw new Error("boom"); });
      const f = vi.spyOn(window as any, "fetch").mockImplementation(() => { throw new Error("nope"); });
      boot();
      expect(() => setHidden(true)).not.toThrow();
      f.mockRestore();
    });

    it("caps value at 86400", () => {
      boot();
      vi.advanceTimersByTime(90_000_000);
      window.dispatchEvent(new Event("pagehide"));
      expect(leaves()[0].body.value).toBe(86400);
    });

    it("carries the first-touch ad ids and no personal keys", () => {
      go("/?utm_content=333");
      boot();
      window.dispatchEvent(new Event("pagehide"));
      const b = leaves()[0].body;
      expect(b.ad_id).toBe("333");
      expect(Object.keys(b).filter((k) => /^(email|phone|name)$/i.test(k))).toEqual([]);
    });

    it("sends nothing in manual consent mode before consent", () => {
      boot("manual");
      window.dispatchEvent(new Event("pagehide"));
      expect(beacon).not.toHaveBeenCalled();
    });

    it("never throws when sendBeacon and fetch both fail", () => {
      (beacon as any).mockImplementation(() => { throw new Error("boom"); });
      const f = vi.spyOn(window as any, "fetch").mockImplementation(() => { throw new Error("nope"); });
      boot();
      expect(() => window.dispatchEvent(new Event("pagehide"))).not.toThrow();
      f.mockRestore();
    });
  });
});
