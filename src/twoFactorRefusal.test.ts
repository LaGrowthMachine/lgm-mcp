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

const WORKSPACE_ID = "64f0c2a1b3d4e5f6a7b8c9d0";

type ToolResult = { isError?: boolean; content: Array<{ type: string; text: string }> };
type AxiosConfig = { method: string; url: string; data?: unknown; headers: Record<string, string> };

const connectClient = async (): Promise<Client> => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createMcpServer().connect(serverTransport);
  const client = new Client({ name: "two-factor-refusal-test", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
};

const callTool = async (client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> =>
  (await client.callTool({ name, arguments: args })) as ToolResult;

const flowCalls = (): AxiosConfig[] => mockedAxios.mock.calls.map(([config]) => config as AxiosConfig);

const apiAnswers = (status: number, data: unknown) => mockedAxios.mockResolvedValue({ status, data, headers: {} });

const refusedForStaleProof = () =>
  apiAnswers(403, {
    error: "Two-factor verification required",
    twoFactorRequired: true,
    reason: "impersonate",
    errors: [{ code: "TWO_FACTOR_REQUIRED", message: "Two-factor verification required", reason: "impersonate" }],
  });

const NOT_ENROLLED_MESSAGE =
  "Two-factor authentication is required to reach another workspace. Enable it in the LGM app, under Settings then Security, then try again.";

const refusedForNoEnrolment = () =>
  apiAnswers(403, {
    error: NOT_ENROLLED_MESSAGE,
    errors: [{ code: "TWO_FACTOR_NOT_ENROLLED", message: NOT_ENROLLED_MESSAGE }],
  });

describe("un refus de second facteur sur n importe quel tool", () => {
  let client: Client;

  beforeAll(async () => {
    client = await connectClient();
  });

  beforeEach(() => {
    mockedAxios.mockReset();
  });

  it("dit d appeler verify_two_factor puis de refaire l appel", async () => {
    refusedForStaleProof();

    const result = await callTool(client, "list_campaigns", { workspaceId: WORKSPACE_ID });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("verify_two_factor");
    expect(result.content[0].text).toContain("again unchanged");
  });

  it("presente l expiration de la preuve comme attendue, pour que l assistant redemande un code sans parler de bug", async () => {
    refusedForStaleProof();

    const result = await callTool(client, "list_campaigns", { workspaceId: WORKSPACE_ID });

    expect(result.content[0].text).toContain("expired");
    expect(result.content[0].text).toContain("not a bug");
  });

  it("LGMS2-1644 - presente comme attendue une ecriture refusee alors que les lectures passent, sur un compte a lecture etendue", async () => {
    refusedForStaleProof();

    const result = await callTool(client, "set_lead_status", {
      workspaceId: WORKSPACE_ID,
      leadId: "64b7f0c2a1b2c3d4e5f60718",
      campaignId: "64b7f0c2a1b2c3d4e5f60719",
      status: "INTERESTED",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("extended read access");
    expect(result.content[0].text).toContain("a write refused while reads still work is expected");
  });

  it("vaut pour tout tool, le refus venant de l authentification et non d un controller", async () => {
    refusedForStaleProof();

    const result = await callTool(client, "list_audiences", { workspaceId: WORKSPACE_ID });

    expect(result.content[0].text).toContain("verify_two_factor");
  });

  it("vaut aussi pour les tools qui detaillent leurs propres refus", async () => {
    refusedForStaleProof();

    const result = await callTool(client, "pause_campaign", { workspaceId: WORKSPACE_ID, campaignId: "64f0c2a1b3d4e5f6a7b8c9d1" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("verify_two_factor");
  });

  it("interdit de demander un code quand le compte n est pas enrole", async () => {
    refusedForNoEnrolment();

    const result = await callTool(client, "list_campaigns", { workspaceId: WORKSPACE_ID });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Settings then Security");
    expect(result.content[0].text).toContain("Do NOT ask for a code");
    expect(result.content[0].text).not.toContain("verify_two_factor");
  });

  it.each([
    ["enrich_lead", { workspaceId: WORKSPACE_ID, leadId: "64f0c2a1b3d4e5f6a7b8c9d1", enrichType: "PHONE_ENRICH" }],
    ["enrich_linkedin_post", { workspaceId: WORKSPACE_ID, postUrl: "https://www.linkedin.com/posts/someone_activity-1" }],
  ])("fait passer le refus avant l apercu du cout de %s, qui ne rend plus un solde inconnu", async (tool, args) => {
    refusedForStaleProof();

    const result = await callTool(client, tool, args);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("verify_two_factor");
    expect(result.content[0].text).not.toContain("Balance unknown");
    expect(result.content[0].text).not.toContain("confirmation required");
  });

  it("interdit aussi de demander un code dans l apercu du cout quand le compte n est pas enrole", async () => {
    refusedForNoEnrolment();

    const result = await callTool(client, "enrich_lead", { workspaceId: WORKSPACE_ID, leadId: "64f0c2a1b3d4e5f6a7b8c9d1" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Do NOT ask for a code");
    expect(result.content[0].text).not.toContain("Balance unknown");
  });

  it("garde l apercu sans solde quand /credits tombe pour une autre raison", async () => {
    apiAnswers(500, { error: "Internal error" });

    const result = await callTool(client, "enrich_lead", { workspaceId: WORKSPACE_ID, leadId: "64f0c2a1b3d4e5f6a7b8c9d1" });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("Balance unknown");
  });

  it("laisse les autres refus 403 inchanges", async () => {
    apiAnswers(403, { error: "Something else entirely" });

    const result = await callTool(client, "list_campaigns", { workspaceId: WORKSPACE_ID });

    expect(result.content[0].text).toBe("Error (403): Something else entirely");
  });
});

describe("verify_two_factor", () => {
  let client: Client;

  beforeAll(async () => {
    client = await connectClient();
  });

  beforeEach(() => {
    mockedAxios.mockReset();
  });

  it("poste le code sur /flow/2fa/verify, en visant le workspace demande", async () => {
    apiAnswers(200, { provenAt: 1_700_000_000_000, workspaceId: WORKSPACE_ID });

    await callTool(client, "verify_two_factor", { code: "123456", workspaceId: WORKSPACE_ID });

    const [call] = flowCalls();
    expect(call.method).toBe("POST");
    expect(call.url).toContain("/flow/2fa/verify");
    expect(call.data).toEqual({ code: "123456" });
    expect(call.headers["X-LGM-Workspace"]).toBe(WORKSPACE_ID);
  });

  it("ne fait jamais voyager le code dans l url", async () => {
    apiAnswers(200, { provenAt: 1_700_000_000_000 });

    await callTool(client, "verify_two_factor", { code: "123456", workspaceId: WORKSPACE_ID });

    expect(flowCalls()[0].url).not.toContain("123456");
  });

  it("remonte un code refuse tel quel, sans conseiller de recommencer a l infini", async () => {
    apiAnswers(400, { error: "Two-factor code refused" });

    const result = await callTool(client, "verify_two_factor", { code: "000000", workspaceId: WORKSPACE_ID });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Two-factor code refused");
  });
});
