// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import PerformanceTable, { type DisplayRow } from "./PerformanceTable";
import KpiCard from "./KpiCard";
import { DEFAULT_TARGETS } from "@/lib/metrics";

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
