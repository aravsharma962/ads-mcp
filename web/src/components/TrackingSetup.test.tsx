// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import TrackingSetup from "./TrackingSetup";

const site = { site_key: "sk_abc123", allowed_origins: ["https://shop.example"] };
const health = { eventsLast24h: 12, sessionsMissingAdIds: 2, lastEventAt: "2026-11-20T10:00:00Z" };

describe("TrackingSetup", () => {
  it("shows the copy-paste snippet with the site key and the app origin", () => {
    render(<TrackingSetup clientId="c1" appUrl="https://app.example" initialSite={site} initialHealth={health} canEdit />);
    const snippet = screen.getByTestId("snippet").textContent!;
    expect(snippet).toBe('<script async src="https://app.example/t.js" data-site-key="sk_abc123"></script>');
  });
  it("shows the ad URL parameter template", () => {
    render(<TrackingSetup clientId="c1" appUrl="https://app.example" initialSite={site} initialHealth={health} canEdit />);
    expect(screen.getByTestId("url-params").textContent).toBe("utm_source=facebook&utm_campaign={{campaign.id}}&utm_term={{adset.id}}&utm_content={{ad.id}}");
  });
  it("shows health numbers and the honest-limits note", () => {
    render(<TrackingSetup clientId="c1" appUrl="https://app.example" initialSite={site} initialHealth={health} canEdit={false} />);
    expect(screen.getByText(/Events in the last 24 hours/)).toBeInTheDocument();
    expect(screen.getByTestId("health-events").textContent).toBe("12");
    expect(screen.getByTestId("health-missing").textContent).toBe("2");
    expect(screen.getByText(/differ from Meta Ads Manager/)).toBeInTheDocument();
  });
  it("without a site, owners see a setup form and members a notice", () => {
    const { unmount } = render(<TrackingSetup clientId="c1" appUrl="https://app.example" initialSite={null} initialHealth={null} canEdit />);
    expect(screen.getByRole("button", { name: /create tracking site/i })).toBeInTheDocument();
    unmount();
    render(<TrackingSetup clientId="c1" appUrl="https://app.example" initialSite={null} initialHealth={null} canEdit={false} />);
    expect(screen.getByText(/Only the agency owner/)).toBeInTheDocument();
  });
});
