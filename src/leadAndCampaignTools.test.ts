/*
 * Copyright 2026 La Growth Machine
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */
import axios from "axios";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "./server";

jest.mock("axios");
const mockedAxios = axios as unknown as jest.Mock;

const CAMPAIGN_ID = "64f0c2a1b3d4e5f6a7b8c9d0";
const LEAD_ID = "64f0c2a1b3d4e5f6a7b8c9d1";

type AxiosConfig = { method: string; url: string; data?: unknown };
type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

const calls = (): AxiosConfig[] => mockedAxios.mock.calls.map(([config]) => config as AxiosConfig);

describe("get_campaign, get_campaign_leads_stats, search_lead, remove_lead_from_audience", () => {
  let client: Client;
  const call = async (name: string, args: Record<string, unknown>): Promise<ToolResult> =>
    (await client.callTool({ name, arguments: args })) as ToolResult;

  beforeAll(async () => {
    process.env.LGM_API_KEY = "lgmc_test";
    process.env.LGM_DISABLE_TELEMETRY = "true";
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await createMcpServer().connect(serverTransport);
    client = new Client({ name: "test", version: "0" });
    await client.connect(clientTransport);
  });

  beforeEach(() => {
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({
      status: 200,
      data: { statusCode: 200, lead: { id: LEAD_ID, firstname: "Jane", note: "private", userId: "u1", enrichData: { raw: 1 }, hubspot: { id: "1" } } },
      headers: {},
    });
  });

  it("refuses a malformed campaign id without calling the API (the API answers 500)", async () => {
    const result = await call("get_campaign", { campaignId: "abc" });
    expect(result.isError).toBe(true);
    expect(calls()).toHaveLength(0);
  });

  it("pages the per-lead stats with getLeadsAfter", async () => {
    await call("get_campaign_leads_stats", { campaignId: CAMPAIGN_ID, getLeadsAfter: LEAD_ID });
    const url = new URL(calls()[0].url);
    expect(url.pathname).toBe(`/flow/campaigns/${CAMPAIGN_ID}/statsleads`);
    expect(url.searchParams.get("getLeadsAfter")).toBe(LEAD_ID);
  });

  it("returns only the described lead fields, with the CRM id taken from the raw CRM payload", async () => {
    const result = await call("search_lead", { email: "jane@acme.com" });
    expect(new URL(calls()[0].url).searchParams.get("email")).toBe("jane@acme.com");
    expect(result.content[0].text).toContain('"firstname": "Jane"');
    expect(result.content[0].text).not.toContain("enrichData");
    expect(result.content[0].text).not.toContain("hubspot");
    expect(result.content[0].text).not.toContain("private");
    expect(result.content[0].text).not.toContain("userId");
    expect(result.content[0].text).toContain('"crmId": "1"');
  });

  it("refuses a name without its company, which the API answers with \"Lead not found\"", async () => {
    const result = await call("search_lead", { firstname: "Jane", lastname: "Doe" });
    expect(result.isError).toBe(true);
    expect(calls()).toHaveLength(0);
  });

  it("removes a lead identified by exactly one exact identifier, crmId sent as crm_id", async () => {
    const result = await call("remove_lead_from_audience", { audience: "DACH VPs", crmId: "123" });
    expect(result.isError).toBeUndefined();
    expect(calls()[0].method).toBe("POST");
    expect(new URL(calls()[0].url).pathname).toBe("/flow/leads/removefromaudience");
    expect(calls()[0].data).toEqual({ audience: "DACH VPs", crm_id: "123" });
  });

  it.each([{}, { proEmail: "jane@acme.com", linkedinUrl: "https://www.linkedin.com/in/jane" }])(
    "refuses to remove without exactly one identifier (%j)",
    async (identifiers) => {
      const result = await call("remove_lead_from_audience", { audience: "DACH VPs", ...identifiers });
      expect(result.isError).toBe(true);
      expect(calls()).toHaveLength(0);
    },
  );
});
