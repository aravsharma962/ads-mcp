import { describe, it, expect } from "vitest";
import { analyzePages, suggestRetargeting, type EventRow } from "./pages";

let t = 0;
const ev = (session_id: string, name: string, o: Partial<EventRow> = {}): EventRow => ({
  session_id, name, ad_id: null, url: null, value: null, ts: new Date(Date.UTC(2026, 10, 1, 0, 0, t++)).toISOString(), ...o,
});
const view = (s: string, url: string, o: Partial<EventRow> = {}) => ev(s, "page_view", { url, ...o });
const leave = (s: string, url: string, value: number | null, o: Partial<EventRow> = {}) => ev(s, "page_leave", { url, value, ...o });
const find = (r: ReturnType<typeof analyzePages>, url: string) => r.pages.find((p) => p.url === url)!;
const CONV = ["purchase", "lead"];

describe("analyzePages", () => {
  it("empty input", () => {
    expect(analyzePages([], CONV, 10)).toEqual({ pages: [], sessions: 0, bounced_sessions: 0 });
  });

  it("exit = last page_view of a non converting session; earlier page is not an exit", () => {
    const r = analyzePages([view("a", "/x"), view("a", "/y")], CONV, 10);
    expect(find(r, "/x")).toMatchObject({ sessions: 1, exits: 0, exit_rate: 0 });
    expect(find(r, "/y")).toMatchObject({ sessions: 1, exits: 1, exit_rate: 1 });
  });

  it("converted sessions are never exits or bounces and count as conversions on their pages", () => {
    const r = analyzePages([view("a", "/x"), leave("a", "/x", 1), ev("a", "purchase", { url: "/x", value: 5 })], CONV, 10);
    expect(find(r, "/x")).toMatchObject({ exits: 0, bounces: 0, conversions: 1 });
    expect(r.bounced_sessions).toBe(0);
  });

  it("bounce: one distinct url, page_leave below threshold; boundary is not a bounce", () => {
    const r = analyzePages([
      view("a", "/x"), leave("a", "/x", 3),
      view("b", "/x"), leave("b", "/x", 10),
    ], CONV, 10);
    expect(find(r, "/x")).toMatchObject({ sessions: 2, bounces: 1, bounce_rate: 0.5 });
    expect(r.bounced_sessions).toBe(1);
    expect(r.sessions).toBe(2);
  });

  it("sessions without page_leave are never bounces (but can be exits)", () => {
    const r = analyzePages([view("a", "/x")], CONV, 10);
    expect(find(r, "/x")).toMatchObject({ bounces: 0, exits: 1 });
    expect(r.bounced_sessions).toBe(0);
  });

  it("same page viewed twice in one session still counts one session and can bounce", () => {
    const r = analyzePages([view("a", "/x"), view("a", "/x"), leave("a", "/x", 2)], CONV, 10);
    expect(find(r, "/x")).toMatchObject({ sessions: 1, bounces: 1, exits: 1 });
  });

  it("multi page sessions are not bounces; session counted once per page", () => {
    const r = analyzePages([view("a", "/x"), view("a", "/y"), leave("a", "/y", 1)], CONV, 10);
    expect(r.bounced_sessions).toBe(0);
    expect(find(r, "/x").sessions).toBe(1);
    expect(find(r, "/y").sessions).toBe(1);
    expect(r.sessions).toBe(1);
  });

  it("ignores null or invalid page_leave values and page_views without url", () => {
    const r = analyzePages([view("a", "/x"), leave("a", "/x", null), ev("b", "page_view")], CONV, 10);
    expect(r.bounced_sessions).toBe(0);
    expect(r.pages.map((p) => p.url)).toEqual(["/x"]);
  });

  it("uses ts order, not input order, to find the last page", () => {
    const e1 = view("a", "/x"), e2 = view("a", "/y");
    const r = analyzePages([e2, e1], CONV, 10);
    expect(find(r, "/y").exits).toBe(1);
    expect(find(r, "/x").exits).toBe(0);
  });

  it("same visitor, two visits days apart: two sessions, each visit counted once per page, own exit/bounce", () => {
    const day = (d: number, sec = 0) => new Date(Date.UTC(2026, 10, d, 0, 0, sec)).toISOString();
    const r = analyzePages([
      view("a", "/x", { ts: day(1) }), leave("a", "/x", 3, { ts: day(1, 5) }),
      view("a", "/x", { ts: day(4) }), view("a", "/y", { ts: day(4, 20) }), leave("a", "/y", 30, { ts: day(4, 50) }),
    ], CONV, 10);
    expect(r.sessions).toBe(2);
    expect(r.bounced_sessions).toBe(1);
    expect(find(r, "/x")).toMatchObject({ sessions: 2, exits: 1, bounces: 1, bounce_rate: 0.5 });
    expect(find(r, "/y")).toMatchObject({ sessions: 1, exits: 1, bounces: 0 });
  });

  it("a conversion in one visit does not make the visitor's other visit converted", () => {
    const day = (d: number) => new Date(Date.UTC(2026, 10, d)).toISOString();
    const r = analyzePages([
      view("a", "/x", { ts: day(1) }), ev("a", "lead", { url: "/x", ts: day(1) }),
      view("a", "/x", { ts: day(5) }),
    ], CONV, 10);
    expect(find(r, "/x")).toMatchObject({ sessions: 2, conversions: 1, exits: 1 });
  });

  it("events within 30 minutes stay one visit; a gap over 30 minutes splits it", () => {
    const at = (min: number) => new Date(Date.UTC(2026, 10, 1, 0, min)).toISOString();
    const one = analyzePages([view("a", "/x", { ts: at(0) }), view("a", "/y", { ts: at(30) })], CONV, 10);
    expect(one.sessions).toBe(1);
    const two = analyzePages([view("a", "/x", { ts: at(0) }), view("a", "/y", { ts: at(31) })], CONV, 10);
    expect(two.sessions).toBe(2);
    expect(find(two, "/x").exits).toBe(1);
  });

  it("bounce_rate is null (not 0) on every page when no visit has any page_leave", () => {
    const r = analyzePages([view("a", "/x"), view("b", "/y")], CONV, 10);
    expect(r.pages.map((p) => p.bounce_rate)).toEqual([null, null]);
    expect(r.bounced_sessions).toBe(0);
  });

  it("bounce_rate is a number once any visit in the window has a page_leave", () => {
    const r = analyzePages([view("a", "/x"), view("b", "/y"), leave("b", "/y", 30)], CONV, 10);
    expect(find(r, "/x").bounce_rate).toBe(0);
    expect(find(r, "/y").bounce_rate).toBe(0);
  });

  it("sorted by sessions desc; rates null when denominator is 0", () => {
    const r = analyzePages([view("a", "/x"), view("b", "/y"), view("c", "/y")], CONV, 10);
    expect(r.pages.map((p) => p.url)).toEqual(["/y", "/x"]);
    expect(r.sessions).toBe(3);
    const z = analyzePages([ev("a", "lead", { url: "/x" })], CONV, 10);
    expect(z.pages).toEqual([]);
  });
});

describe("suggestRetargeting", () => {
  const group = (n: number, url: string, ad: string | null, prefix = "s") =>
    Array.from({ length: n }, (_, i) => view(`${prefix}${url}${ad}${i}`, url, { ad_id: ad }));
  const names = { "111": "Summer Sale" };

  it("empty input and groups under 5 visitors give nothing", () => {
    expect(suggestRetargeting([], CONV, names)).toEqual([]);
    expect(suggestRetargeting(group(4, "/pricing", "111"), CONV, names)).toEqual([]);
  });

  it("5 visitors qualify; text names visitors, ad, page and pricing wording", () => {
    const [s] = suggestRetargeting(group(5, "/pricing", "111"), CONV, names);
    expect(s).toMatchObject({ url: "/pricing", ad_id: "111", ad_name: "Summer Sale", visitors: 5 });
    expect(s.text).toBe('5 visitors from ad "Summer Sale" viewed /pricing and left without converting. Retarget them with a creative that answers price questions (offer, comparison, proof).');
  });

  it("converted sessions are excluded; unique sessions only", () => {
    const evs = [...group(5, "/pricing", "111"), ev("s/pricing111" + "0", "lead"), view("s/pricing111" + "1", "/pricing", { ad_id: "111" })];
    expect(suggestRetargeting(evs, CONV, names)).toEqual([]);   // 5 - 1 converted = 4 < 5
  });

  it("keyword wording by page and fallback", () => {
    const r = suggestRetargeting([...group(5, "/trial", "111"), ...group(5, "/size-guide", "111"), ...group(5, "/demo", "111"), ...group(5, "/shoes", "111")], CONV, names, 10);
    const t = (u: string) => r.find((x) => x.url === u)!.text;
    expect(t("/trial")).toMatch(/trial/i);
    expect(t("/size-guide")).toMatch(/size/i);
    expect(t("/demo")).toMatch(/demo/i);
    expect(t("/shoes")).toMatch(/product/i);
    expect(new Set(r.map((x) => x.text.split("Retarget")[1])).size).toBe(4);
  });

  it("unknown ad name and null ad id are handled; sorted by visitors desc; limit applies", () => {
    const r = suggestRetargeting([...group(5, "/a", null), ...group(7, "/b", "999"), ...group(6, "/c", "111")], CONV, names, 2);
    expect(r.map((x) => x.url)).toEqual(["/b", "/c"]);
    const all = suggestRetargeting([...group(5, "/a", null), ...group(7, "/b", "999")], CONV, names);
    expect(all.find((x) => x.url === "/b")!.ad_name).toBeNull();
    expect(all.find((x) => x.url === "/a")!.ad_id).toBeNull();
    expect(all.find((x) => x.url === "/a")!.text).not.toMatch(/from ad/);
  });

  it("one visitor with two visits to a page counts as one visitor; a converted visit does not exclude the other", () => {
    const day = (d: number) => new Date(Date.UTC(2026, 10, d)).toISOString();
    const evs = [
      ...group(4, "/pricing", "111"),
      view("v", "/pricing", { ad_id: "111", ts: day(1) }), view("v", "/pricing", { ad_id: "111", ts: day(9) }),
    ];
    expect(suggestRetargeting(evs, CONV, names)[0].visitors).toBe(5);
    const conv = [...group(4, "/pricing", "111"), view("v", "/pricing", { ad_id: "111", ts: day(1) }), ev("v", "lead", { ts: day(1) }), view("v", "/pricing", { ad_id: "111", ts: day(9) })];
    expect(suggestRetargeting(conv, CONV, names)[0].visitors).toBe(5);
  });

  it("default limit is 5", () => {
    const evs = ["/a", "/b", "/c", "/d", "/e", "/f"].flatMap((u) => group(5, u, "111"));
    expect(suggestRetargeting(evs, CONV, names)).toHaveLength(5);
  });
});
