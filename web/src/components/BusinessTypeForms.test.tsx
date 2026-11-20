// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

const nav = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: nav.refresh }) }));

import NewClientForm from "./NewClientForm";
import BusinessTypeSelect from "./BusinessTypeSelect";
import TargetsEditor from "./TargetsEditor";
import { defaultTargetsFor } from "@/lib/metrics";

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset().mockResolvedValue(new Response(JSON.stringify({ error: "nope" }), { status: 400 }));
  nav.refresh.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

describe("NewClientForm", () => {
  it("offers the three English business type labels and requires a choice", async () => {
    render(<NewClientForm />);
    const select = screen.getByLabelText("Business type") as HTMLSelectElement;
    expect(select).toBeRequired();
    const labels = Array.from(select.options).map((o) => o.textContent);
    expect(labels).toEqual(expect.arrayContaining(["Lead Generation (clinics, real estate)", "SaaS / B2B Leads", "E-commerce"]));
    expect(select.value).toBe("");                                  // nothing preselected: the user must choose
    fireEvent.change(screen.getByPlaceholderText("Client name"), { target: { value: "Acme" } });
    fireEvent.click(screen.getByRole("button", { name: "Create client" }));
    expect(fetchMock).not.toHaveBeenCalled();                       // blocked by the required select
  });
  it("posts the chosen business_type", async () => {
    render(<NewClientForm />);
    fireEvent.change(screen.getByPlaceholderText("Client name"), { target: { value: "Acme" } });
    fireEvent.change(screen.getByLabelText("Business type"), { target: { value: "saas_b2b" } });
    fireEvent.click(screen.getByRole("button", { name: "Create client" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ name: "Acme", business_type: "saas_b2b" });
    expect(await screen.findByRole("alert")).toHaveTextContent("nope");
  });
});

describe("BusinessTypeSelect", () => {
  it("owner can change the type, which PATCHes the client and refreshes", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ client: {} }), { status: 200 }));
    render(<BusinessTypeSelect clientId="c1" value="ecommerce" canEdit />);
    fireEvent.change(screen.getByLabelText("Business type"), { target: { value: "lead_gen" } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe("/api/clients/c1");
    expect(fetchMock.mock.calls[0][1].method).toBe("PATCH");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ business_type: "lead_gen" });
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
  });
  it("shows the error and does not refresh on failure; non-owners cannot change it", async () => {
    const { unmount } = render(<BusinessTypeSelect clientId="c1" value="ecommerce" canEdit />);
    fireEvent.change(screen.getByLabelText("Business type"), { target: { value: "saas_b2b" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("nope");
    expect(nav.refresh).not.toHaveBeenCalled();
    unmount();
    render(<BusinessTypeSelect clientId="c1" value="ecommerce" canEdit={false} />);
    expect(screen.getByLabelText("Business type")).toBeDisabled();
  });
});

describe("TargetsEditor by business type", () => {
  it("shows only the metrics of the client's type", () => {
    render(<TargetsEditor clientId="c1" businessType="saas_b2b" initial={defaultTargetsFor("saas_b2b")} />);
    for (const l of ["CTR (%)", "CPC", "CPM", "Cost per signup (CPL)", "Signup rate (%)", "Demo rate (%)", "Cost per trial", "CAC"]) expect(screen.getByText(l)).toBeInTheDocument();
    expect(screen.queryByText("ROAS (x)")).toBeNull();
    expect(screen.queryByText("Add-to-cart rate (%)")).toBeNull();
    expect(screen.getByLabelText("CAC max")).toHaveValue("");           // new metrics start empty
  });
  it("saves only the type's metrics", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ targets: { ...defaultTargetsFor("lead_gen"), cpl: { min: null, max: 400 } } }), { status: 200 }));
    render(<TargetsEditor clientId="c1" businessType="lead_gen" initial={defaultTargetsFor("lead_gen")} />);
    fireEvent.change(screen.getByLabelText("Cost per lead (CPL) max"), { target: { value: "400" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body).targets;
    expect(Object.keys(sent).sort()).toEqual(["cpc", "cpl", "cpm", "ctr", "lead_rate"]);
    expect(sent.cpl).toEqual({ min: null, max: 400 });
  });
});
