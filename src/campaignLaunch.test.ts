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
const IDENTITY_ID = "6650f1c2a1b2c3d4e5f60718";
const LAUNCHED_AT = Date.UTC(2026, 9, 8, 9, 30);

type ToolResult = { isError?: boolean; content: Array<{ type: string; text: string }> };
type AxiosConfig = { method: string; url: string; data?: unknown; timeout: number };

const connectClient = async (): Promise<Client> => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createMcpServer().connect(serverTransport);
  const client = new Client({ name: "campaign-launch-test", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
};

const callTool = async (client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> =>
  (await client.callTool({ name, arguments: args })) as ToolResult;

const flowCalls = (): AxiosConfig[] => mockedAxios.mock.calls.map(([config]) => config as AxiosConfig);

const apiAnswers = (status: number, data: unknown) => mockedAxios.mockResolvedValue({ status, data, headers: {} });

describe("campaign identity and launch tools", () => {
  let client: Client;

  beforeAll(async () => {
    process.env.LGM_API_KEY = "lgmc_test";
    process.env.LGM_DISABLE_TELEMETRY = "true";
    client = await connectClient();
  });

  afterAll(async () => {
    await client.close();
    delete process.env.LGM_API_KEY;
    delete process.env.LGM_DISABLE_TELEMETRY;
  });

  beforeEach(() => {
    mockedAxios.mockReset();
  });

  it("registers set_campaign_identity as an idempotent update and launch_campaign as an outbound, irreversible write", async () => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

    expect(byName.set_campaign_identity.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(byName.launch_campaign.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
  });

  it("points a never-launched campaign to launch_campaign, in resume_campaign and in the instructions", async () => {
    const { tools } = await client.listTools();
    const resume = tools.find((tool) => tool.name === "resume_campaign");

    expect(resume?.description).toContain("a READY campaign that has never been launched is started with launch_campaign");
    expect(client.getInstructions()).toContain("a READY campaign that was never launched is started with launch_campaign");
    expect(client.getInstructions()).not.toContain("must be launched from the LGM app");
  });

  describe("set_campaign_identity", () => {
    it("POSTs the identityId to the campaign settings and answers with the new identity and its email addresses", async () => {
      apiAnswers(200, {
        statusCode: 200,
        data: {
          id: CAMPAIGN_ID,
          name: "Q4 outreach",
          identityId: IDENTITY_ID,
          identityFirstname: "Marie",
          identityLastname: "Martin",
          senderEmailAddressesCount: 2,
          enrich: false,
          status: "READY",
        },
      });

      const result = await callTool(client, "set_campaign_identity", { campaignId: CAMPAIGN_ID, identityId: IDENTITY_ID });

      expect(result.isError).toBeFalsy();
      const [request] = flowCalls();
      expect(request.method).toBe("POST");
      expect(new URL(request.url).pathname).toBe(`/flow/campaigns/${CAMPAIGN_ID}/settings`);
      expect(request.data).toEqual({ identityId: IDENTITY_ID });
      expect(result.content[0].text).toContain("Campaign Identity Updated");
      expect(result.content[0].text).toContain('"name": "Marie Martin"');
      expect(result.content[0].text).toContain('"senderEmailAddresses": 2');
      expect(result.content[0].text).not.toContain("enrich");
    });

    it("explains that a launched campaign keeps its identity, from the code of the refusal", async () => {
      apiAnswers(400, {
        error: "Once started, you can not change identity on a campaign",
        errors: [{ code: "CAMPAIGN_ALREADY_LAUNCHED", message: "The campaign has already been launched", status: "RUNNING" }],
      });

      const result = await callTool(client, "set_campaign_identity", { campaignId: CAMPAIGN_ID, identityId: IDENTITY_ID });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe(
        "Error (400): The identity cannot be changed: The campaign has already been launched — a launched campaign keeps its identity; " +
          "duplicate_campaign creates a draft copy whose identity can be changed",
      );
    });

    it("points to list_identities when the identity is unknown", async () => {
      apiAnswers(404, {
        error: "Identity not found",
        errors: [{ code: "IDENTITY_NOT_FOUND", message: "The identity was not found in the workspace" }],
      });

      const result = await callTool(client, "set_campaign_identity", { campaignId: CAMPAIGN_ID, identityId: IDENTITY_ID });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("The identity was not found in the workspace — use an identityId from list_identities");
    });

    it("passes a refusal without codes through unchanged", async () => {
      apiAnswers(400, { error: '"identityId" is not allowed' });

      const result = await callTool(client, "set_campaign_identity", { campaignId: CAMPAIGN_ID, identityId: IDENTITY_ID });

      expect(result.content[0].text).toBe('Error (400): "identityId" is not allowed');
    });
  });

  describe("launch_campaign", () => {
    it("POSTs to the launch endpoint with a long timeout and reports the launch", async () => {
      apiAnswers(200, { statusCode: 200, data: { id: CAMPAIGN_ID, name: "Q4 outreach", status: "RUNNING", launchedAt: LAUNCHED_AT } });

      const result = await callTool(client, "launch_campaign", { campaignId: CAMPAIGN_ID });

      expect(result.isError).toBeFalsy();
      const [request] = flowCalls();
      expect(request.method).toBe("POST");
      expect(new URL(request.url).pathname).toBe(`/flow/campaigns/${CAMPAIGN_ID}/launch`);
      expect(request.timeout).toBe(120_000);
      expect(result.content[0].text).toContain("Campaign Launched");
      expect(result.content[0].text).toContain(`"launchedAt": "${new Date(LAUNCHED_AT).toISOString()}"`);
    });

    it.each([
      [{ code: "AUDIENCE_MISSING", message: "No audience is selected for the campaign" }, "set_campaign_audience attaches one"],
      [{ code: "AUDIENCE_EMPTY", message: "The audience of the campaign has no lead" }, "add leads to the audience"],
      [
        { code: "SEQUENCE_START_NOT_CONNECTED", message: "The Start block of the sequence is not connected to any step" },
        "the user connects the Start block to the first step in the LGM app",
      ],
      [
        { code: "NO_SENDER_EMAIL_ADDRESS", message: "The campaign has email steps but no sender email address" },
        "the user connects an email address to the identity and selects it as a sender of the campaign in the LGM app",
      ],
      [
        { code: "SENDER_EMAIL_ADDRESS_DISCONNECTED", message: "Some sender email addresses of the campaign are disconnected" },
        "the user reconnects or deselects these email addresses in the LGM app",
      ],
      [
        {
          code: "IDENTITY_NOT_CONNECTED_TO_LINKEDIN",
          message: "The campaign uses LinkedIn (LinkedIn steps or enrichment) but its identity is not connected to LinkedIn",
        },
        "the user reconnects the identity to LinkedIn in the LGM app",
      ],
      [
        { code: "CAMPAIGN_ALREADY_LAUNCHED", message: "The campaign has already been launched", status: "PAUSED" },
        "resume_campaign restarts a paused campaign",
      ],
      [
        { code: "RUNNING_CAMPAIGNS_LIMIT_REACHED", message: "The maximum number of running campaigns of the account is reached" },
        "pausing another running campaign (pause_campaign) frees a slot when list_campaigns shows one; if none is running, the plan of the account allows no running campaign",
      ],
      [{ code: "IDENTITY_PAYMENT_ISSUE", message: "The payment of the identity is not up to date" }, "the payment of the identity is fixed in the LGM app"],
      [{ code: "CRM_NOT_AVAILABLE", message: "CRM sync is not available on this account" }, "set_campaign_crm_sync turns the CRM sync of the campaign off"],
    ])("returns the refusal %j with the tool that fixes it", async (reason, hint) => {
      apiAnswers(400, { error: "The campaign cannot be launched yet", errors: [reason] });

      const result = await callTool(client, "launch_campaign", { campaignId: CAMPAIGN_ID });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(`Error (400): The campaign cannot be launched yet: ${reason.message} — ${hint}`);
    });

    it("lists every reason of a refused launch, with the steps that miss their content", async () => {
      apiAnswers(400, {
        error: "The campaign cannot be launched yet: …",
        errors: [
          {
            code: "STEPS_WITHOUT_CONTENT",
            message: "Some steps have no content yet (message, voice recording or call script)",
            stepIds: ["step-2", "step-4"],
          },
          {
            code: "IDENTITY_NOT_CONNECTED_TO_LINKEDIN",
            message: "The campaign uses LinkedIn (LinkedIn steps or enrichment) but its identity is not connected to LinkedIn",
          },
        ],
      });

      const result = await callTool(client, "launch_campaign", { campaignId: CAMPAIGN_ID });

      expect(result.content[0].text).toBe(
        "Error (400): The campaign cannot be launched yet:\n" +
          "- Some steps have no content yet (message, voice recording or call script) (stepIds: step-2, step-4) — add_campaign_step_message adds a " +
          "missing message (same stepIds as get_campaign_steps); a voice recording or a call script is added in the LGM app\n" +
          "- The campaign uses LinkedIn (LinkedIn steps or enrichment) but its identity is not connected to LinkedIn — the user reconnects the " +
          "identity to LinkedIn in the LGM app, or set_campaign_identity switches to another identity; for a campaign without LinkedIn steps, " +
          "set_campaign_setting can turn autoEnrich off instead",
      );
    });

    it("points a connection request note on a LinkedIn Basic account to another identity", async () => {
      apiAnswers(400, {
        error: "The campaign cannot be launched yet: …",
        errors: [
          {
            code: "LINKEDIN_INVITE_NOTE_NOT_AVAILABLE",
            message: "The sequence sends connection requests with a note, which the LinkedIn Basic account of the identity cannot send",
          },
        ],
      });

      const result = await callTool(client, "launch_campaign", { campaignId: CAMPAIGN_ID });

      expect(result.content[0].text).toContain("— set_campaign_identity switches to an identity with a Premium or Sales Navigator LinkedIn account");
    });

    it("states a plan refusal from its factual reason, not from the upgrade wording of the app", async () => {
      apiAnswers(400, {
        error: "Please upgrade to use A/B testing",
        errors: [{ code: "AB_TESTING_NOT_AVAILABLE", message: "A/B testing is not available on this account" }],
      });

      const result = await callTool(client, "launch_campaign", { campaignId: CAMPAIGN_ID });

      expect(result.content[0].text).toBe("Error (400): The campaign cannot be launched yet: A/B testing is not available on this account");
    });

    it("points to set_campaign_identity when the campaign's identity no longer exists", async () => {
      apiAnswers(404, {
        error: "Identity not found",
        errors: [{ code: "IDENTITY_NOT_FOUND", message: "The identity was not found in the workspace" }],
      });

      const result = await callTool(client, "launch_campaign", { campaignId: CAMPAIGN_ID });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("the campaign's identity no longer exists: set_campaign_identity attaches another one");
    });

    it("reports the launch even when launchedAt cannot be read", async () => {
      apiAnswers(200, { statusCode: 200, data: { id: CAMPAIGN_ID, name: "Q4 outreach", status: "RUNNING", launchedAt: "not a date" } });

      const result = await callTool(client, "launch_campaign", { campaignId: CAMPAIGN_ID });

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain("Campaign Launched");
      expect(result.content[0].text).not.toContain("launchedAt");
    });

    it("keeps the refusal of an API that does not send codes yet", async () => {
      apiAnswers(400, { error: "Your identity has payment problem. Retry your payment please" });

      const result = await callTool(client, "launch_campaign", { campaignId: CAMPAIGN_ID });

      expect(result.content[0].text).toBe("Error (400): Your identity has payment problem. Retry your payment please");
    });

    it("does not retry a 5xx and asks to check the campaign status before launching again", async () => {
      apiAnswers(502, "");

      const result = await callTool(client, "launch_campaign", { campaignId: CAMPAIGN_ID });

      expect(flowCalls()).toHaveLength(1);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe(
        "Error (502): LGM answered with a server error — the launch may have gone through: " +
          "check the campaign's status with list_campaigns before calling launch_campaign again.",
      );
    });

    it("asks to check the campaign status before launching again after a network error", async () => {
      mockedAxios.mockRejectedValue(new Error("socket hang up"));

      const result = await callTool(client, "launch_campaign", { campaignId: CAMPAIGN_ID });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe(
        "Error: socket hang up — the launch may have gone through: " +
          "check the campaign's status with list_campaigns before calling launch_campaign again.",
      );
    });
  });

  describe("resume_campaign and pause_campaign", () => {
    it("points a campaign that was never launched to launch_campaign when asked to resume it", async () => {
      apiAnswers(400, {
        error: "Only a paused campaign can be resumed",
        errors: [{ code: "CAMPAIGN_NOT_PAUSED", message: "The campaign is not paused", status: "READY" }],
      });

      const result = await callTool(client, "resume_campaign", { campaignId: CAMPAIGN_ID });

      expect(result.content[0].text).toBe(
        "Error (400): The campaign cannot be resumed: The campaign is not paused — a campaign that was never launched is started with launch_campaign",
      );
    });

    it("says that a paused campaign is already paused when asked to pause it", async () => {
      apiAnswers(400, {
        error: "Only a running campaign can be paused",
        errors: [{ code: "CAMPAIGN_NOT_RUNNING", message: "The campaign is not running", status: "PAUSED" }],
      });

      const result = await callTool(client, "pause_campaign", { campaignId: CAMPAIGN_ID });

      expect(result.content[0].text).toBe("Error (400): The campaign cannot be paused: The campaign is not running — the campaign is already paused");
    });

    it("points a campaign that was never launched to launch_campaign when asked to pause it", async () => {
      apiAnswers(400, {
        error: "Only a running campaign can be paused",
        errors: [{ code: "CAMPAIGN_NOT_RUNNING", message: "The campaign is not running", status: "READY" }],
      });

      const result = await callTool(client, "pause_campaign", { campaignId: CAMPAIGN_ID });

      expect(result.content[0].text).toBe(
        "Error (400): The campaign cannot be paused: The campaign is not running — the campaign was never launched; launch_campaign starts it",
      );
    });
  });

  it.each([
    ["launch_campaign", { campaignId: CAMPAIGN_ID }],
    ["resume_campaign", { campaignId: CAMPAIGN_ID }],
    ["pause_campaign", { campaignId: CAMPAIGN_ID }],
    ["set_campaign_identity", { campaignId: CAMPAIGN_ID, identityId: IDENTITY_ID }],
  ])("points %s to list_campaigns for an unknown campaign", async (tool, args) => {
    apiAnswers(404, {
      error: "Campaign not found",
      errors: [{ code: "CAMPAIGN_NOT_FOUND", message: "The campaign was not found in the workspace" }],
    });

    const result = await callTool(client, tool, args);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/^Error \(404\): /);
    expect(result.content[0].text).toContain(
      "The campaign was not found in the workspace — use a campaignId from list_campaigns, with the same workspaceId if one was used",
    );
  });
});
