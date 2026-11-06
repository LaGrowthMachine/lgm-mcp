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

const LEAD_ID = "64f0c2a1b3d4e5f6a7b8c9d0";

type AxiosConfig = { method: string; url: string; data?: unknown };
type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

// Répond comme lgm-apis : solde de crédits sur GET /flow/credits, requête d'enrich acceptée en polling
// sur POST /flow/leads/enrich.
const mockApi = (options: { creditsTotal?: number; enrichStatus?: number; enrichBody?: unknown } = {}): void => {
  mockedAxios.mockImplementation(async (config: AxiosConfig) => {
    const { pathname } = new URL(config.url);
    if (pathname === "/flow/credits") {
      return { status: 200, data: { credits: { total: options.creditsTotal ?? 100, perishable: 0 } }, headers: {} };
    }
    if (pathname === "/flow/leads/enrich" && config.method === "POST") {
      return {
        status: options.enrichStatus ?? 200,
        data: options.enrichBody ?? { statusCode: 200, enrichRequestId: "req_1", status: "pending" },
        headers: {},
      };
    }
    return { status: 404, data: { error: "Not found" }, headers: {} };
  });
};

const enrichCalls = (): AxiosConfig[] =>
  mockedAxios.mock.calls.map(([config]) => config as AxiosConfig).filter((config) => config.url.includes("/flow/leads/enrich"));

const connectClient = async (): Promise<Client> => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createMcpServer().connect(serverTransport);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
  return client;
};

describe("enrich_lead — PHONE_ENRICH", () => {
  let client: Client;
  const callEnrich = async (args: Record<string, unknown>): Promise<ToolResult> =>
    (await client.callTool({ name: "enrich_lead", arguments: args })) as ToolResult;

  beforeAll(async () => {
    process.env.LGM_API_KEY = "lgmc_test";
    process.env.LGM_DISABLE_TELEMETRY = "true";
    client = await connectClient();
  });

  afterAll(() => {
    delete process.env.LGM_API_KEY;
    delete process.env.LGM_DISABLE_TELEMETRY;
  });

  beforeEach(() => {
    mockedAxios.mockReset();
    mockApi();
  });

  it("exposes PHONE_ENRICH in the enrichType schema", async () => {
    const { tools } = await client.listTools();
    const enrichLead = tools.find((tool) => tool.name === "enrich_lead");
    const enrichType = (enrichLead?.inputSchema.properties as Record<string, { enum?: string[] }>).enrichType;
    expect(enrichType.enum).toContain("PHONE_ENRICH");
  });

  it("previews the 20-credit cost against the balance without spending", async () => {
    mockApi({ creditsTotal: 12 });

    const result = await callEnrich({ leadId: LEAD_ID, enrichType: "PHONE_ENRICH" });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('"estimatedCostCredits": 20');
    expect(result.content[0].text).toContain("INSUFFICIENT (need 20, have 12)");
    expect(enrichCalls()).toEqual([]);
  });

  it("refuses PHONE_ENRICH without a leadId, even with firstname+lastname", async () => {
    const result = await callEnrich({ firstname: "Jane", lastname: "Doe", enrichType: "PHONE_ENRICH", confirm: true, acknowledgedCostCredits: 20 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/PHONE_ENRICH requires a leadId/);
    expect(mockedAxios).not.toHaveBeenCalled();
  });

  it("refuses PHONE_ENRICH without any identifier with the leadId message", async () => {
    const result = await callEnrich({ enrichType: "PHONE_ENRICH" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/PHONE_ENRICH requires a leadId/);
  });

  it("refuses to spend when the acknowledged cost is not the phone cost", async () => {
    const result = await callEnrich({ leadId: LEAD_ID, enrichType: "PHONE_ENRICH", confirm: true, acknowledgedCostCredits: 5 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/does not match the actual cost \(20 for PHONE_ENRICH\)/);
    expect(enrichCalls()).toEqual([]);
  });

  it("starts a polling phone enrichment on POST /flow/leads/enrich once confirmed", async () => {
    const result = await callEnrich({ leadId: LEAD_ID, enrichType: "PHONE_ENRICH", confirm: true, acknowledgedCostCredits: 20 });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("Enrich Started (PHONE_ENRICH, ~20 credits)");
    expect(result.content[0].text).toContain('"enrichRequestId": "req_1"');
    expect(enrichCalls()).toHaveLength(1);
    expect(enrichCalls()[0].method).toBe("POST");
    expect(enrichCalls()[0].data).toEqual({ enrichType: "PHONE_ENRICH", mode: "polling", leadId: LEAD_ID });
  });

  it("surfaces an account without phone enrichment as a factual error", async () => {
    mockApi({ enrichStatus: 403, enrichBody: { error: "Phone enrichment is not available during the trial. Please upgrade to enrich phone numbers." } });

    const result = await callEnrich({ leadId: LEAD_ID, enrichType: "PHONE_ENRICH", confirm: true, acknowledgedCostCredits: 20 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Error (403): This feature is not available on your account.");
  });

  it("keeps EMAIL_ENRICH working from firstname+lastname without a leadId", async () => {
    const result = await callEnrich({ firstname: "Jane", lastname: "Doe", companyName: "Acme", confirm: true, acknowledgedCostCredits: 5 });

    expect(result.isError).toBeFalsy();
    expect(enrichCalls()[0].data).toEqual({ enrichType: "EMAIL_ENRICH", mode: "polling", firstname: "Jane", lastname: "Doe", companyName: "Acme" });
  });
});
