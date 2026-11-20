// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import PerformanceTable, { type DisplayRow } from "./PerformanceTable";
import KpiCard from "./KpiCard";
import { DEFAULT_TARGETS, defaultTargetsFor, type Targets } from "@/lib/metrics";

const base: DisplayRow = {
  id: "1", name: "Ad one", thumbnail_url: "https://cdn.example/t.jpg",
  spend: 100, impressions: 1000, link_clicks: 50, add_to_cart: 0, purchases: 0, purchase_value: 0,
  rates: { ctr: 5, cpc: 40, cpm: 10, visit_rate: null, add_to_cart_rate: null, conversion_rate: null, roas: 10 },
};

describe("PerformanceTable", () => {
  it("shows empty state for no rows", () => {
    render(<PerformanceTable rows={[]} targets={DEFAULT_TARGETS} currency="INR" level="ad" tracking={false} />);
    expect(screen.getByText("No data for this period")).toBeInTheDocument();
  });

  it("marks cells with status classes", () => {
    const { container } = render(<PerformanceTable rows={[base]} targets={DEFAULT_TARGETS} currency="INR" level="ad" tracking={true} />);
    const cell = (m: string) => container.querySelector(`td[data-metric="${m}"]`)!;
    expect(cell("ctr")).toHaveAttribute("data-status", "on_target");
    expect(cell("ctr").className).toContain("status-on_target");
    expect(cell("cpc")).toHaveAttribute("data-status", "off_target");
    expect(cell("cpc").className).toContain("status-off_target");
    expect(cell("cpm")).toHaveAttribute("data-status", "better");
    expect(cell("cpm").className).toContain("status-better");
    expect(cell("visit_rate")).toHaveAttribute("data-status", "no_data");
    expect(within(cell("visit_rate") as HTMLElement).getByText("no data")).toBeInTheDocument();
    expect(cell("roas")).toHaveAttribute("data-status", "on_target");
  });

  it("renders thumbnails as img with alt and names as literal text", () => {
    const evil = { ...base, name: "<script>x</script>" };
    const { container } = render(<PerformanceTable rows={[evil]} targets={DEFAULT_TARGETS} currency="INR" level="ad" tracking={false} />);
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getAllByText("<script>x</script>").length).toBeGreaterThan(0);
    const img = container.querySelector("img")!;
    expect(img).toHaveAttribute("alt", "<script>x</script>");
  });

  it("tracking not set up shows a message instead of tracking rates", () => {
    render(<PerformanceTable rows={[base]} targets={DEFAULT_TARGETS} currency="INR" level="ad" tracking={false} />);
    expect(screen.getAllByText("Tracking not set up").length).toBeGreaterThan(0);
  });
});

describe("KpiCard", () => {
  it("shows a definition tooltip and status", () => {
    const { container } = render(<KpiCard label="CTR" value="5.00%" status="on_target" definition="Link clicks / impressions." />);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Link clicks / impressions.");
    expect(container.firstElementChild).toHaveAttribute("data-status", "on_target");
  });
});

describe("PerformanceTable by business type", () => {
  const lead: DisplayRow = { ...base, leads: 20, rates: { ctr: 5, cpc: 40, cpm: 10, cpl: 150, lead_rate: 10 } };
  const saas: DisplayRow = {
    ...base, signups: 10, trials: 5, demos: 4, paid: 2,
    rates: { ctr: 5, cpc: 40, cpm: 10, cpl: 10, signup_rate: 5, demo_rate: 2, cost_per_trial: 20, cac: 50 },
  };
  const headers = (c: HTMLElement) => Array.from(c.querySelectorAll("th")).map((h) => h.textContent);

  it("lead_gen shows leads, CPL and lead rate and none of the e-commerce columns", () => {
    const targets: Targets = { ...defaultTargetsFor("lead_gen"), cpl: { min: null, max: 100 }, lead_rate: { min: 8, max: null } };
    const { container } = render(<PerformanceTable rows={[lead]} targets={targets} currency="INR" level="ad" tracking={false} businessType="lead_gen" />);
    const h = headers(container);
    expect(h).toEqual(expect.arrayContaining(["Leads", "Cost per lead (CPL)", "Lead rate (%)"]));
    expect(h).not.toContain("Add to cart");
    expect(h.join("|")).not.toMatch(/ROAS|Purchases|Add-to-cart/);
    const cell = (m: string) => container.querySelector(`td[data-metric="${m}"]`)!;
    expect(cell("cpl")).toHaveAttribute("data-status", "off_target");        // 150 > max 100, lower is better
    expect(cell("lead_rate")).toHaveAttribute("data-status", "on_target");
    expect(screen.getByText("20")).toBeInTheDocument();
  });

  it("empty targets are no_data with a hint to set one, not off target", () => {
    const { container } = render(<PerformanceTable rows={[lead]} targets={defaultTargetsFor("lead_gen")} currency="INR" level="ad" tracking={false} businessType="lead_gen" />);
    const c = container.querySelector('td[data-metric="cpl"]')!;
    expect(c).toHaveAttribute("data-status", "no_data");
    expect(c).toHaveAttribute("title", "Set a target");
    expect(c.className).not.toContain("status-off_target");
  });

  it("saas_b2b shows its columns; tracking-only metrics read 'Tracking not set up' without a site", () => {
    const targets = defaultTargetsFor("saas_b2b");
    const { container, rerender } = render(<PerformanceTable rows={[saas]} targets={targets} currency="USD" level="ad" tracking={true} businessType="saas_b2b" />);
    expect(headers(container)).toEqual(expect.arrayContaining(["Signups", "Trials", "Demos", "Paid", "Cost per signup (CPL)", "Signup rate (%)", "Demo rate (%)", "Cost per trial", "CAC"]));
    expect(container.querySelector('td[data-metric="cac"]')!.textContent).toBe("$50.00");
    rerender(<PerformanceTable rows={[{ ...saas, rates: { ...saas.rates, demo_rate: null, cost_per_trial: null, cac: null } }]} targets={targets} currency="USD" level="ad" tracking={false} businessType="saas_b2b" />);
    for (const m of ["demo_rate", "cost_per_trial", "cac"]) expect(container.querySelector(`td[data-metric="${m}"]`)!.textContent).toBe("Tracking not set up");
    expect(container.querySelector('td[data-metric="cpl"]')!.textContent).toBe("$10.00");
  });

  it("without a business type the e-commerce table is unchanged", () => {
    const { container } = render(<PerformanceTable rows={[base]} targets={DEFAULT_TARGETS} currency="INR" level="ad" tracking={true} />);
    expect(headers(container)).toEqual(expect.arrayContaining(["Add to cart", "Purchases", "ROAS (x)"]));
    expect(container.querySelector('td[data-metric="cpl"]')).toBeNull();
  });
});

describe("KpiCard hint", () => {
  it("shows a custom badge label such as 'Set a target'", () => {
    render(<KpiCard label="CPL" value="$5.00" status="no_data" hint="Set a target" definition="d" />);
    expect(screen.getByText("Set a target")).toBeInTheDocument();
  });
});
