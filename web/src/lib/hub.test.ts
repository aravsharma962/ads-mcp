import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { hubFetch, HubError, listAccounts, addAccount, removeAccount, listTools, callTool } from "./hub";

const SECRET = "s3cr3t-hub-value-0123456789abcdef";
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.HUB_URL = "https://hub.example/";
  process.env.HUB_SERVICE_SECRET = SECRET;
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("hubFetch", () => {
  it("sends secret and tenant headers, nothing from the browser", async () => {
    fetchMock.mockResolvedValue(ok([]));
    await hubFetch("t1", "/internal/accounts", { headers: { Cookie: "sb=1", Origin: "https://evil", "X-Tenant-Id": "other", Authorization: "Bearer x" } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://hub.example/internal/accounts");
    const h = new Headers(init.headers);
    expect(h.get("x-hub-secret")).toBe(SECRET);
    expect(h.get("x-tenant-id")).toBe("t1");
    expect(h.get("cookie")).toBeNull();
    expect(h.get("origin")).toBeNull();
    expect(h.get("authorization")).toBeNull();
    expect(init.signal).toBeDefined();
  });

  it("turns error responses into HubError without leaking the secret", async () => {
    fetchMock.mockResolvedValue(ok({ error: `bad ${SECRET} thing` }, 502));
    const err = await hubFetch("t1", "/internal/tools").catch((e) => e);
    expect(err).toBeInstanceOf(HubError);
    expect(err.status).toBe(502);
    expect(err.message).not.toContain(SECRET);
    expect(JSON.stringify(err)).not.toContain(SECRET);
  });

  it("network failure becomes HubError 503", async () => {
    fetchMock.mockRejectedValue(new Error(`connect failed ${SECRET}`));
    const err = await hubFetch("t1", "/internal/tools").catch((e) => e);
    expect(err).toBeInstanceOf(HubError);
    expect(err.status).toBe(503);
    expect(err.message).not.toContain(SECRET);
  });

  it("refuses to run when HUB_URL or secret is missing", async () => {
    delete process.env.HUB_SERVICE_SECRET;
    await expect(hubFetch("t1", "/internal/tools")).rejects.toBeInstanceOf(HubError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an empty tenant id", async () => {
    await expect(hubFetch("", "/internal/tools")).rejects.toBeInstanceOf(HubError);
  });
});

describe("hub helpers", () => {
  it("listAccounts", async () => {
    fetchMock.mockResolvedValue(ok([{ platform: "meta", external_id: "act_1" }]));
    expect(await listAccounts("t1")).toEqual([{ platform: "meta", external_id: "act_1" }]);
  });
  it("addAccount posts account and token", async () => {
    fetchMock.mockResolvedValue(ok({ external_id: "act_1" }, 201));
    expect(await addAccount("t1", "act_1", "tok")).toEqual({ external_id: "act_1" });
    const init = fetchMock.mock.calls[0][1];
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ account: "act_1", token: "tok" });
  });
  it("removeAccount returns false on 404", async () => {
    fetchMock.mockResolvedValue(ok({ error: "not found" }, 404));
    expect(await removeAccount("t1", "act_1")).toBe(false);
    expect(fetchMock.mock.calls[0][0]).toBe("https://hub.example/internal/accounts/act_1");
  });
  it("addAccount error never contains the token", async () => {
    fetchMock.mockResolvedValue(ok({ error: "invalid token EAAB123456789012345678901234567890" }, 400));
    const err = await addAccount("t1", "act_1", "EAAB123456789012345678901234567890").catch((e) => e);
    expect(err.message).not.toContain("EAAB1234567890");
  });
  it("listTools and callTool", async () => {
    fetchMock.mockResolvedValueOnce(ok([{ name: "ads_performance", description: "d", input_schema: {} }]));
    expect((await listTools("t1"))[0].name).toBe("ads_performance");
    fetchMock.mockResolvedValueOnce(ok({ result: { rows: [] } }));
    expect(await callTool("t1", "ads_performance", { a: 1 })).toEqual({ rows: [] });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ name: "ads_performance", arguments: { a: 1 } });
  });
  it("callTool surfaces tool error payload as HubError", async () => {
    fetchMock.mockResolvedValue(ok({ error: "Account not connected" }, 200));
    await expect(callTool("t1", "x", {})).rejects.toThrow("Account not connected");
  });
  it("callTool throws when the tool result itself is an error object (hub returns {result: {error}})", async () => {
    fetchMock.mockResolvedValue(ok({ result: { error: "You do not have access to this account." } }));
    await expect(callTool("t1", "meta_ads_insights", {})).rejects.toThrow("You do not have access to this account.");
  });
  it("callTool does not treat a normal result without error as failure", async () => {
    fetchMock.mockResolvedValue(ok({ result: { rows: [], error: 5 } }));
    expect(await callTool("t1", "x", {})).toEqual({ rows: [], error: 5 });
  });
});
