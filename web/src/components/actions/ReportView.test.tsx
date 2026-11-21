// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import ReportView from "./ReportView";

const fetchMock = vi.fn();
const stats = { spend: 200, impressions: 9000, link_clicks: 300, results: 20, frequency: 2, ctr: 3.3, cost_per_result: 10 };
beforeEach(() => { vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); fetchMock.mockReset(); });

describe("ReportView", () => {
  it("renders sections and copies the WhatsApp text", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      currency: "USD", business_type: "lead_gen", client_name: "Acme",
      windows: { recent: { from: "2026-11-14", to: "2026-11-20" }, previous: { from: "2026-11-07", to: "2026-11-13" } },
      recent: stats, previous: stats,
      target_checks: [{ metric: "cpl", label: "Cost per lead", value: 10, status: "better" }],
      top_ads: [], bottom_ads: [], next_actions: ["Pause Ad two"], whatsapp_text: "Weekly report for Acme",
    })));
    render(<ReportView clientId="c1" />);
    expect(await screen.findByText("Report for Acme")).toBeInTheDocument();
    expect(screen.getByText("Cost per lead")).toBeInTheDocument();
    expect(screen.getByText("Pause Ad two")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy WhatsApp text" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Weekly report for Acme"));
  });
  it("shows an error", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "No ad account" }), { status: 400 }));
    render(<ReportView clientId="c1" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("No ad account");
  });
});
