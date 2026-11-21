// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import VerdictBadge, { VERDICT_LABEL } from "./VerdictBadge";
import VerdictChips from "./VerdictChips";
import AdActionsTable from "./AdActionsTable";
import WinnersPanel from "./WinnersPanel";
import CopyButton from "./CopyButton";
import RulesForm, { validateRules } from "./RulesForm";
import LeadStatusSelect from "./LeadStatusSelect";
import PagesView from "./PagesView";
import LeadsView from "./LeadsView";
import ActionsView from "./ActionsView";
import { DEFAULT_ACTION_RULES, VERDICTS, type AdAction, type PeriodStats } from "@/lib/actions/types";

const stats: PeriodStats = { spend: 100, impressions: 5000, link_clicks: 100, results: 10, frequency: 2, ctr: 2, cost_per_result: 10 };
const ad = (o: Partial<AdAction> = {}): AdAction => ({
  ad_id: "a1", name: "Ad one", thumbnail_url: "https://img/x.jpg", campaign_id: null, adset_id: null, verdict: "scale", confidence: "high",
  reasons: ["Cost per result is 30% lower."], signals: { frequency: false, ctr_drop: false, cost_rise: false },
  recent: stats, previous: stats, suggestion: "Raise budget by at most 20%.", ...o,
});
const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => vi.unstubAllGlobals());
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("VerdictBadge", () => {
  it("has a label and color for every verdict", () => {
    const seen = new Set<string>();
    for (const v of VERDICTS) {
      const { container, unmount } = render(<VerdictBadge verdict={v} />);
      const el = container.firstElementChild as HTMLElement;
      expect(el.textContent).toBe(VERDICT_LABEL[v]);
      seen.add(el.className.split(" ").find((c) => c.startsWith("bg-"))!);
      unmount();
    }
    expect(VERDICT_LABEL.pause).toBe("Pause");
    expect(VERDICT_LABEL.refresh_creative).toBe("Refresh creative");
    expect(seen.size).toBeGreaterThanOrEqual(4);
  });
  it("chips show counts", () => {
    render(<VerdictChips counts={{ too_early: 1, keep_watch: 2, scale: 3, refresh_creative: 0, pause: 4 }} />);
    expect(screen.getByText(/Scale:/).textContent).toContain("3");
    expect(screen.getByText(/Pause:/).textContent).toContain("4");
  });
});

describe("AdActionsTable and WinnersPanel", () => {
  it("renders ad rows with thumbnail, verdict, confidence, reasons, suggestion", () => {
    render(<AdActionsTable actions={[ad()]} currency="USD" resultLabel="lead" />);
    expect(screen.getByRole("img", { name: "Ad one" })).toHaveAttribute("src", "https://img/x.jpg");
    expect(screen.getByText("Scale")).toBeInTheDocument();
    expect(screen.getByText("High")).toBeInTheDocument();
    expect(screen.getByText(/30% lower/)).toBeInTheDocument();
    expect(screen.getByText(/Raise budget/)).toBeInTheDocument();
  });
  it("empty states", () => {
    const { unmount } = render(<AdActionsTable actions={[]} currency="USD" resultLabel="lead" />);
    expect(screen.getByText(/No ads found/)).toBeInTheDocument();
    unmount();
    render(<WinnersPanel winners={[]} currency="USD" />);
    expect(screen.getByText(/No winners yet/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /copy/i })).toBeNull();
  });
});

describe("CopyButton", () => {
  it("uses navigator.clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<CopyButton text="hello" label="Copy it" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy it" }));
    await waitFor(() => expect(screen.getByText("Copied")).toBeInTheDocument());
    expect(writeText).toHaveBeenCalledWith("hello");
  });
  it("falls back to execCommand when the clipboard API is missing", async () => {
    vi.stubGlobal("navigator", {});
    const exec = vi.fn().mockReturnValue(true);
    (document as unknown as { execCommand: unknown }).execCommand = exec;
    render(<CopyButton text="hello" label="Copy it" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy it" }));
    await waitFor(() => expect(screen.getByText("Copied")).toBeInTheDocument());
    expect(exec).toHaveBeenCalledWith("copy");
  });
  it("shows an error when both paths fail", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("no")) } });
    (document as unknown as { execCommand: unknown }).execCommand = vi.fn().mockReturnValue(false);
    render(<CopyButton text="hello" label="Copy it" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy it" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Could not copy/);
  });
});

describe("RulesForm", () => {
  it("validateRules flags out-of-range, non-numeric and non-integer values", () => {
    const v = Object.fromEntries(Object.entries(DEFAULT_ACTION_RULES).map(([k, n]) => [k, String(n)])) as never;
    expect(validateRules(v).rules).toEqual(DEFAULT_ACTION_RULES);
    const bad = { ...(v as object), frequency_max: "0", window_days: "7.5", ctr_drop_pct: "abc" } as never;
    const { rules, errors } = validateRules(bad);
    expect(rules).toBeNull();
    expect(Object.keys(errors).sort()).toEqual(["ctr_drop_pct", "frequency_max", "window_days"]);
  });
  it("blocks save on invalid input and PUTs valid rules", async () => {
    fetchMock.mockResolvedValue(json({ rules: DEFAULT_ACTION_RULES }));
    const onSaved = vi.fn();
    render(<RulesForm clientId="c1" initial={DEFAULT_ACTION_RULES} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText(/Max frequency/), { target: { value: "99" } });
    fireEvent.click(screen.getByRole("button", { name: "Save rules" }));
    expect(await screen.findByText(/from 1 to 20/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/Max frequency/), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: "Save rules" }));
    await waitFor(() => expect(screen.getByText("Rules saved.")).toBeInTheDocument());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/clients/c1/rules");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ ...DEFAULT_ACTION_RULES, frequency_max: 4 });
    expect(onSaved).toHaveBeenCalled();
  });
  it("shows the server error", async () => {
    fetchMock.mockResolvedValue(json({ error: "Nope" }, 400));
    render(<RulesForm clientId="c1" initial={DEFAULT_ACTION_RULES} />);
    fireEvent.click(screen.getByRole("button", { name: "Save rules" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Nope");
  });
});

describe("LeadStatusSelect", () => {
  it("PUTs the new status", async () => {
    fetchMock.mockResolvedValue(json({ ok: true }));
    render(<LeadStatusSelect clientId="c1" sessionId="s1" status="new" />);
    fireEvent.change(screen.getByLabelText("Lead status"), { target: { value: "qualified" } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/clients/c1/leads");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ session_id: "s1", status: "qualified" });
  });
  it("reverts and shows an error on failure", async () => {
    fetchMock.mockResolvedValue(json({ error: "Denied" }, 403));
    render(<LeadStatusSelect clientId="c1" sessionId="s1" status="new" />);
    fireEvent.change(screen.getByLabelText("Lead status"), { target: { value: "won" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Denied");
    expect(screen.getByLabelText("Lead status")).toHaveValue("new");
  });
});

describe("views", () => {
  const win = { from: "2026-11-01", to: "2026-11-07" };
  it("PagesView: tracking false shows the setup link", async () => {
    fetchMock.mockResolvedValue(json({ window: win, sessions: 0, bounced_sessions: 0, pages: [], retargeting: [], truncated: false, tracking: false }));
    render(<PagesView clientId="c1" />);
    const link = await screen.findByRole("link", { name: /set up tracking/i });
    expect(link).toHaveAttribute("href", "/clients/c1/tracking");
  });
  it("PagesView: table and retargeting; missing tracking treated as true", async () => {
    fetchMock.mockResolvedValue(json({ window: win, sessions: 10, bounced_sessions: 4, truncated: false,
      pages: [{ url: "/pricing", sessions: 10, exits: 5, exit_rate: 50, bounces: 4, bounce_rate: 40, conversions: 1 }],
      retargeting: [{ url: "/pricing", ad_id: null, ad_name: null, visitors: 6, text: "6 visitors viewed pricing and left." }] }));
    render(<PagesView clientId="c1" />);
    expect(await screen.findByText("/pricing")).toBeInTheDocument();
    expect(screen.getByText("50.0%")).toBeInTheDocument();
    expect(screen.getByText("40.0%")).toBeInTheDocument();
    expect(screen.getByText(/6 visitors viewed pricing/)).toBeInTheDocument();
  });
  it("PagesView: error state", async () => {
    fetchMock.mockResolvedValue(json({ error: "Boom" }, 500));
    render(<PagesView clientId="c1" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Boom");
  });
  it("LeadsView: cards, table, Instant Form note", async () => {
    fetchMock.mockResolvedValue(json({ window: win, currency: "USD", total: 4, qualified: 2, won: 1, spend: 100, cost_per_lead: 25, cost_per_qualified_lead: 50, truncated: false, tracking: true,
      leads: [{ session_id: "s1", ts: "2026-11-03T10:00:00Z", ad_id: "a1", ad_name: "Ad one", url: "/lp", status: "new" }] }));
    render(<LeadsView clientId="c1" />);
    expect(await screen.findByText("Ad one")).toBeInTheDocument();
    expect(screen.getByTestId("cost-per-lead")).toHaveTextContent("$25.00");
    expect(screen.getByTestId("cost-per-qualified")).toHaveTextContent("$50.00");
    expect(screen.getByText(/Instant Form leads are not included/)).toBeInTheDocument();
    expect(screen.getByLabelText("Lead status")).toHaveValue("new");
  });
  it("LeadsView: tracking false and empty states", async () => {
    fetchMock.mockResolvedValue(json({ window: win, currency: "USD", leads: [], total: 0, qualified: 0, won: 0, spend: 0, cost_per_lead: null, cost_per_qualified_lead: null, truncated: false, tracking: false }));
    const { unmount } = render(<LeadsView clientId="c1" />);
    expect(await screen.findByText("Tracking not set up")).toBeInTheDocument();
    unmount();
    fetchMock.mockResolvedValue(json({ window: win, currency: "USD", leads: [], total: 0, qualified: 0, won: 0, spend: 0, cost_per_lead: null, cost_per_qualified_lead: null, truncated: false }));
    render(<LeadsView clientId="c1" />);
    expect(await screen.findByText(/No website leads/)).toBeInTheDocument();
    expect(screen.getByTestId("cost-per-lead")).toHaveTextContent("no data");
  });
  it("PagesView: null bounce rate shows No data, not 0.0%", async () => {
    fetchMock.mockResolvedValue(json({ window: win, sessions: 10, bounced_sessions: 0, truncated: false, tracking: true,
      pages: [{ url: "/pricing", sessions: 10, exits: 5, exit_rate: 50, bounces: 0, bounce_rate: null, conversions: 1 }], retargeting: [] }));
    render(<PagesView clientId="c1" />);
    expect(await screen.findByText("/pricing")).toBeInTheDocument();
    expect(screen.getByText("No data")).toBeInTheDocument();
    expect(screen.queryByText("0.0%")).toBeNull();
  });
  it("LeadsView: refreshes the summary after a status change and says ad-attributed", async () => {
    const body = (qualified: number, cpq: number | null) => ({ window: win, currency: "USD", total: 4, attributed_total: 2, qualified, won: 0, spend: 100, cost_per_lead: 50, cost_per_qualified_lead: cpq, truncated: false, tracking: true,
      leads: [{ session_id: "s1", ts: "2026-11-03T10:00:00Z", ad_id: "a1", ad_name: "Ad one", url: "/lp", status: "new" }] });
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
      init?.method === "PUT" ? json({ ok: true }) : json(fixture.current));
    const fixture = { current: body(0, null) };
    render(<LeadsView clientId="c1" />);
    expect(await screen.findByText("Ad one")).toBeInTheDocument();
    expect(screen.getByText("Cost per ad-attributed lead")).toBeInTheDocument();
    expect(screen.getByText("Cost per qualified ad-attributed lead")).toBeInTheDocument();
    expect(screen.getByTestId("leads-qualified")).toHaveTextContent("0");
    fixture.current = body(1, 100);
    fireEvent.change(screen.getByLabelText("Lead status"), { target: { value: "qualified" } });
    await waitFor(() => expect(screen.getByTestId("leads-qualified")).toHaveTextContent("1"));
    expect(screen.getByTestId("cost-per-qualified")).toHaveTextContent("$100.00");
  });
  it("ActionsView: keeps the rules form mounted and shows Rules saved after save", async () => {
    const payload = { currency: "USD", business_type: "lead_gen", result_label: "lead", rules: DEFAULT_ACTION_RULES,
      windows: { recent: win, previous: win }, actions: [ad()], winners: [ad()], counts: { too_early: 0, keep_watch: 0, scale: 1, refresh_creative: 0, pause: 0 } };
    fetchMock.mockImplementation(async (_u: string, init?: RequestInit) => json(init?.method === "PUT" ? { ok: true } : payload));
    render(<ActionsView clientId="c1" />);
    await screen.findByText("Ad one", { selector: "span" });
    fireEvent.click(screen.getByRole("button", { name: "Edit rules" }));
    fireEvent.click(screen.getByRole("button", { name: "Save rules" }));
    await waitFor(() => expect(fetchMock.mock.calls.filter((c) => !c[1]?.method).length).toBeGreaterThanOrEqual(2));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByText("Rules saved.")).toBeInTheDocument();
  });
  it("ActionsView: suggestions note, chips, and rules editor toggle", async () => {
    fetchMock.mockResolvedValue(json({ currency: "USD", business_type: "lead_gen", result_label: "lead", rules: DEFAULT_ACTION_RULES,
      windows: { recent: win, previous: win }, actions: [ad()], winners: [ad()], counts: { too_early: 0, keep_watch: 0, scale: 1, refresh_creative: 0, pause: 0 } }));
    render(<ActionsView clientId="c1" />);
    expect(await screen.findByText("Ad one", { selector: "span" })).toBeInTheDocument();
    expect(screen.getByText(/Nothing is changed in Meta/)).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Copy winners" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit rules" }));
    expect(screen.getByLabelText(/Max frequency/)).toBeInTheDocument();
  });
});

import ApplyConfirm from "./ApplyConfirm";
import ChangeLog from "./ChangeLog";
import type { ActionLogRow } from "@/lib/actions/types";

const logRow = (o: Partial<ActionLogRow> = {}): ActionLogRow => ({
  id: "l1", created_at: new Date().toISOString(), user_id: "u1", ad_id: "a1", ad_name: "Ad one", action: "pause", level: "ad", object_id: "a1",
  before: {}, after: {}, status: "ok", error: null, ...o,
});
const viewPayload = (actions: AdAction[]) => ({ currency: "USD", business_type: "lead_gen", result_label: "lead", rules: DEFAULT_ACTION_RULES,
  windows: { recent: { from: "2026-11-01", to: "2026-11-07" }, previous: { from: "2026-10-25", to: "2026-10-31" } }, actions, winners: [], counts: { too_early: 0, keep_watch: 0, scale: 0, refresh_creative: 0, pause: 0 } });
const setup = (actions: AdAction[], applyGet: unknown, post?: () => Response) => {
  fetchMock.mockImplementation(async (u: string, init?: RequestInit) => {
    if (u.endsWith("/apply")) return init?.method === "POST" ? post!() : json(applyGet);
    return json(viewPayload(actions));
  });
};

describe("Phase 2A apply UI", () => {
  it("ApplyConfirm states the change and needs a second click", () => {
    const onConfirm = vi.fn();
    render(<ApplyConfirm adName="Ad one" action="pause" busy={false} error={null} onConfirm={onConfirm} onCancel={() => {}} />);
    expect(screen.getByRole("dialog")).toHaveTextContent('Pause ad "Ad one" in your live Meta account');
    fireEvent.click(screen.getByRole("button", { name: "Confirm change in Meta" }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });
  it("ChangeLog lists entries and empty state", () => {
    const { unmount } = render(<ChangeLog log={[logRow(), logRow({ id: "l2", status: "error", error: "Boom" })]} />);
    expect(screen.getByText("Applied")).toBeInTheDocument();
    expect(screen.getByText("Boom")).toBeInTheDocument();
    unmount();
    render(<ChangeLog log={[]} />);
    expect(screen.getByText(/No changes made/)).toBeInTheDocument();
  });
  it("shows the right button per verdict and resume after a pause", async () => {
    setup([ad({ ad_id: "p", name: "P", verdict: "pause" }), ad({ ad_id: "s", name: "S", verdict: "scale" }), ad({ ad_id: "r", name: "R", verdict: "keep_watch" }), ad({ ad_id: "k", name: "K", verdict: "keep_watch" })],
      { writes_enabled: true, log: [logRow({ id: "x", ad_id: "r", ad_name: "R" })] });
    render(<ActionsView clientId="c1" isOwner />);
    expect(await screen.findByRole("button", { name: "Pause in Meta" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Raise budget 20%" })).toBeEnabled();
    expect(screen.getAllByRole("button", { name: "Resume" })).toHaveLength(1);
  });
  it("no resume when a later ok entry is not a pause", async () => {
    setup([ad({ ad_id: "r", verdict: "keep_watch" })], { writes_enabled: true, log: [logRow({ id: "n", ad_id: "r", action: "resume" }), logRow({ id: "o", ad_id: "r" })] });
    render(<ActionsView clientId="c1" isOwner />);
    await screen.findByText("Ad one", { selector: "span" });
    await screen.findByText("Recent changes");
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
  });
  it("non-owner sees disabled buttons with a reason", async () => {
    setup([ad({ verdict: "pause" })], { writes_enabled: true, log: [] });
    render(<ActionsView clientId="c1" isOwner={false} />);
    const btn = await screen.findByRole("button", { name: "Pause in Meta" });
    expect(btn).toBeDisabled();
    expect(screen.getByText("Only the agency owner can change ads in Meta.")).toBeInTheDocument();
  });
  it("scale in cooldown is disabled", async () => {
    setup([ad({ verdict: "scale" })], { writes_enabled: true, log: [logRow({ action: "scale", level: "adset" })] });
    render(<ActionsView clientId="c1" isOwner />);
    expect(await screen.findByRole("button", { name: "Raise budget 20%" })).toBeDisabled();
    expect(screen.getByText(/raised in the last 3 days/i)).toBeInTheDocument();
  });
  it("writes disabled shows the not-enabled state and disables buttons", async () => {
    setup([ad({ verdict: "pause" })], { writes_enabled: false, log: [] });
    render(<ActionsView clientId="c1" isOwner />);
    expect((await screen.findAllByText(/Changes in Meta are not enabled/)).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("button", { name: "Pause in Meta" })).toBeDisabled();
  });
  it("confirm flow posts, shows the API note and refreshes", async () => {
    setup([ad({ verdict: "pause" })], { writes_enabled: true, log: [] },
      () => json({ ok: true, action: "pause", ad_id: "a1", level: "ad", object_id: "a1", before: {}, after: {}, note: "Ad paused in Meta." }));
    render(<ActionsView clientId="c1" isOwner />);
    fireEvent.click(await screen.findByRole("button", { name: "Pause in Meta" }));
    const posts = () => fetchMock.mock.calls.filter((c) => c[1]?.method === "POST");
    expect(posts()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Confirm change in Meta" }));
    expect(await screen.findByText("Ad paused in Meta.")).toBeInTheDocument();
    expect(posts()).toHaveLength(1);
    expect(JSON.parse(posts()[0][1].body)).toEqual({ ad_id: "a1", action: "pause" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("shows the API error in the dialog and keeps it open", async () => {
    setup([ad({ verdict: "pause" })], { writes_enabled: true, log: [] }, () => json({ error: "Only owners can apply changes." }, 403));
    render(<ActionsView clientId="c1" isOwner />);
    fireEvent.click(await screen.findByRole("button", { name: "Pause in Meta" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm change in Meta" }));
    expect(await screen.findByRole("alert", {}, { timeout: 2000 })).toHaveTextContent("Only owners can apply changes.");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
