// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import Dashboard from "./Dashboard";
import { defaultTargetsFor, type BusinessType } from "@/lib/metrics";

const fetchMock = vi.fn();
const rows = (rates: Record<string, number | null>, extra = {}) => [{
  id: "1", name: "Row one", thumbnail_url: null, spend: 100, impressions: 1000, link_clicks: 50,
  add_to_cart: 0, purchases: 0, purchase_value: 0, rates, ...extra,
}];
function respond(type: BusinessType, tracking: boolean, rates: Record<string, number | null>) {
  fetchMock.mockResolvedValue(new Response(JSON.stringify({
    currency: "USD", tracking, business_type: type, attribution: "account default",
    rows: rows(rates, { leads: 5, signups: 5, trials: 0, demos: 0, paid: 0 }), totals: { rates }, unattributed: null,
  }), { status: 200 }));
}
const kpi = (label: string) => screen.getByText(label).closest("[data-status]") as HTMLElement;

beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });

describe("Dashboard by business type", () => {
  it("lead_gen: KPI cards are CTR, CPC, CPM, CPL, lead rate; empty target says 'Set a target'", async () => {
    respond("lead_gen", false, { ctr: 5, cpc: 2, cpm: 100, cpl: 20, lead_rate: 10 });
    render(<Dashboard clientId="c1" businessType="lead_gen" targets={{ ...defaultTargetsFor("lead_gen"), cpc: { min: null, max: 1 } }} />);
    await waitFor(() => expect(screen.getAllByText("Cost per lead (CPL)").length).toBeGreaterThan(0));
    const card = (l: string) => screen.getAllByText(l).map((e) => e.closest("[data-status]") as HTMLElement).find((e) => e?.className.includes("rounded border"))!;
    expect(card("Cost per lead (CPL)")).toHaveAttribute("data-status", "no_data");
    expect(within(card("Cost per lead (CPL)")).getByText("Set a target")).toBeInTheDocument();
    expect(within(card("Cost per lead (CPL)")).getByText("$20.00")).toBeInTheDocument();
    expect(card("CPC")).toHaveAttribute("data-status", "off_target");
    expect(screen.queryByText("ROAS (x)")).toBeNull();
    expect(screen.queryByText("Add-to-cart rate (%)")).toBeNull();
    expect(screen.getAllByText("Lead rate (%)").length).toBeGreaterThan(0);
  });

  it("saas_b2b without tracking: CAC, demo rate and cost per trial show 'Tracking not set up'", async () => {
    respond("saas_b2b", false, { ctr: 5, cpc: 2, cpm: 100, cpl: 20, signup_rate: 10, demo_rate: null, cost_per_trial: null, cac: null });
    render(<Dashboard clientId="c1" businessType="saas_b2b" targets={defaultTargetsFor("saas_b2b")} />);
    await waitFor(() => expect(screen.getAllByText("CAC").length).toBeGreaterThan(0));
    const cards = Array.from(document.querySelectorAll("div.group[data-status]"));
    const text = (l: string) => cards.find((c) => c.textContent?.startsWith(l))!.textContent;
    expect(text("CAC")).toContain("Tracking not set up");
    expect(text("Demo rate")).toContain("Tracking not set up");
    expect(text("Cost per trial")).toContain("Tracking not set up");
    expect(text("Cost per signup")).toContain("$20.00");
  });

  it("ecommerce keeps its seven KPI cards", async () => {
    respond("ecommerce", true, { ctr: 5, cpc: 2, cpm: 10, visit_rate: 80, add_to_cart_rate: 14, conversion_rate: 10, roas: 9 });
    render(<Dashboard clientId="c1" businessType="ecommerce" targets={defaultTargetsFor("ecommerce")} />);
    await waitFor(() => expect(screen.getAllByText("ROAS (x)").length).toBeGreaterThan(0));
    expect(document.querySelectorAll("div.group[data-status]")).toHaveLength(7);
  });
});
