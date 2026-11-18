/*
 * Copyright 2026 La Growth Machine
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */
import axios from "axios";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readFileSync } from "fs";
import { join } from "path";
import { createMcpServer } from "./server";

jest.mock("axios");
const mockedAxios = axios as unknown as jest.Mock;

const ID = "64f0c2a1b3d4e5f6a7b8c9d0";
const LEAD_RECORD = {
  id: ID,
  firstname: "Jane",
  lastname: "Doe",
  companyName: "Acme",
  jobTitle: "VP Sales",
  status: "CONTACTED",
  emailStatus: "VALID",
  proEmail: "jane@acme.com",
  persoEmail: "jane@home.com",
  phone: "+33600000000",
  linkedinUrl: "https://www.linkedin.com/in/jane",
  twitter: "@jane",
  gender: "FEMALE",
  location: "Paris",
  crm_id: "crm1",
  emailFoundBy: "VENDOR",
  customAttribute1: "note",
  customAttribute2: "",
};

// The API bodies, from the presenters of lgm-apis: what each tool must not repeat.
const CASES: Array<[string, Record<string, unknown>, unknown, string[], string[]]> = [
  [
    "list_campaigns",
    {},
    {
      statusCode: 200,
      total: 1,
      campaigns: [
        {
          id: ID,
          name: "Q4",
          status: "RUNNING",
          replyRatePercent: 12,
          userId: "u1",
          launchedByMemberId: "m1",
          accessCode: "SHARE",
          leadsByType: { replied: [ID] },
          identity: { id: ID, firstname: "Jo", lastname: "Do", gender: "F", jobTitle: "CEO", profilePicture: "p.png" },
          audience: { id: ID, name: "DACH", size: 3 },
        },
      ],
    },
    ["Q4", "replyRatePercent", "DACH"],
    ["userId", "launchedByMemberId", "accessCode", "leadsByType", "firstname", "lastname", "gender", "jobTitle", "profilePicture", "statusCode"],
  ],
  [
    "list_audiences",
    {},
    { statusCode: 200, audiences: [{ id: ID, name: "DACH", size: 3, userId: "u1", sourceUrl: "s", sourceListId: "l" }] },
    ["DACH", '"size": 3'],
    ["userId", "sourceUrl", "sourceListId"],
  ],
  [
    "list_identities",
    {},
    {
      statusCode: 200,
      identities: [
        { id: ID, name: "Jo", linkedinConnected: true, location: "Paris", jobTitle: "CEO", companyName: "LGM", companyUrl: "u", linkedinLoginState: "OK" },
      ],
    },
    ['"name": "Jo"', "linkedinConnected"],
    ["location", "jobTitle", "companyName", "companyUrl", "linkedinLoginState"],
  ],
  ["list_members", {}, { statusCode: 200, members: [{ id: ID, name: "Jo", label: "Jo" }] }, ['"name": "Jo"'], ["label"]],
  [
    "list_workspaces",
    {},
    {
      multiWorkspace: false,
      adminAccess: true,
      workspaces: [{ workspaceId: ID, name: "LGM", slug: "lgm", plan: "ULTIMATE", identitiesCount: 2, logo: "l.png", isCurrent: true }],
    },
    ["multiWorkspace", '"name": "LGM"', "isCurrent"],
    ["adminAccess", "slug", "plan", "ULTIMATE", "identitiesCount", "logo"],
  ],
  [
    "get_credits",
    {},
    { statusCode: 200, credits: { total: 10, perishable: 1 }, permissions: { crmAccess: true } },
    ['"total": 10'],
    ["permissions", "crmAccess"],
  ],
  [
    "get_audience_leads",
    { audienceId: ID },
    { statusCode: 200, total: 1, data: [LEAD_RECORD] },
    ['"firstname": "Jane"', "emailStatus", '"total": 1'],
    ["proEmail", "persoEmail", "phone", "linkedinUrl", "twitter", "gender", "location", "crm_id", "emailFoundBy", "customAttribute"],
  ],
  [
    "get_campaign_leads_stats",
    { campaignId: ID },
    { count: 1, hasMore: false, leads: [{ id: ID, firstname: "Jane", email: "jane@acme.com", linkedinUrl: "https://l", replied: 1 }] },
    ['"firstname": "Jane"', "replied"],
    ["jane@acme.com", "linkedinUrl"],
  ],
  [
    "search_lead",
    { email: "jane@acme.com" },
    {
      statusCode: 200,
      lead: {
        ...LEAD_RECORD,
        hubspot: { id: "1" },
        tags: [{ campaignId: ID, campaignName: "Q4", tag: "INTERESTED", outOfOfficeReturnDate: "2026-12-01" }],
        involvedCampaigns: [{ _id: ID, name: "Q4", launchedAt: 1, isPrioritised: true }],
      },
      recentLogs: [{ type: "GOOGLE_REPLY", date: 1, internal: "x" }],
    },
    ['"firstname": "Jane"', "INTERESTED", "GOOGLE_REPLY"],
    ["jane@acme.com", "proEmail", "persoEmail", "phone", "linkedinUrl", "location", "crmId", "customAttribute", "gender", "twitter", "outOfOfficeReturnDate", "launchedAt", "isPrioritised", "internal"],
  ],
  [
    "get_lead_logs",
    { leadId: ID },
    { statusCode: 200, total: 1, data: [{ id: "log1", type: "GOOGLE_SEND_EMAIL", message: "Message A sent to lead by rep@acme.com", stepId: "s1", templateId: "t1", campaignId: ID, createdAt: "2026-11-06" }] },
    ["GOOGLE_SEND_EMAIL", "campaignId", "templateId", '"message": "Message A sent to lead"'],
    ["log1", "stepId", "rep@acme.com"],
  ],
  [
    "get_conversation_messages",
    { conversationId: ID },
    { statusCode: 200, total: 1, data: [{ id: "msg1", content: "Hi", direction: "received", sender: "jane@acme.com", unsafeReason: "L2" }] },
    ["msg1", '"direction": "received"'],
    ["sender", "jane@acme.com", "unsafeReason"],
  ],
  [
    "send_linkedin_message",
    { identityId: ID, memberId: ID, leadId: ID, message: "Hi" },
    { statusCode: 200, lead: { ...LEAD_RECORD, userId: "u1", linkedinId: 42, hubspot: { id: "1" } } },
    ['"firstname": "Jane"'],
    ["userId", "linkedinId", "hubspot", "proEmail", "phone", "gender"],
  ],
  [
    "send_email_message",
    { identityId: ID, leadId: ID, html: "<p>Hi</p>", text: "Hi", subject: "Hello" },
    { statusCode: 200, lead: { ...LEAD_RECORD, userId: "u1", lastActions: {}, campaigns: [] } },
    ['"firstname": "Jane"'],
    ["userId", "lastActions", "campaigns", "proEmail", "phone"],
  ],
  [
    "rename_campaign",
    { campaignId: ID, name: "Q4" },
    { statusCode: 200, data: { id: ID, name: "Q4", identityId: ID, identityFirstname: "Jo", identityLastname: "Do" } },
    ['"name": "Q4"'],
    ["identityId", "identityFirstname", "identityLastname"],
  ],
  [
    "snooze_conversation",
    { conversationId: ID, snoozeUntil: "2026-11-09T09:00:00.000Z" },
    { success: true, data: { conversationId: ID, leadId: ID, snoozed: true, snoozeUntil: "2026-11-09", timestamp: "2026-11-06" } },
    ['"snoozed": true'],
    ["timestamp", "leadId"],
  ],
  [
    "get_enrich_result",
    { enrichRequestId: "req1" },
    {
      statusCode: 200,
      status: "enriched",
      email: "jane@acme.com",
      provider: "VENDOR",
      enrichedAt: 1,
      linkedinProfile: { firstname: "Jane", linkedinId: "42", linkedinPublicId: "jane", profilePicture: "p.png" },
    },
    ["jane@acme.com", '"firstname": "Jane"'],
    ["provider", "VENDOR", "enrichedAt", "linkedinId", "linkedinPublicId", "profilePicture"],
  ],
  [
    "enrich_linkedin_post",
    { postUrl: "https://www.linkedin.com/posts/a", confirm: true, acknowledgedCostCredits: 1 },
    { statusCode: 200, post: { text: "Hello", urn: "urn:1", shareUrn: "urn:2", author: { firstname: "Jane", avatar: "a.png", url: "https://l/jane" } } },
    ["Hello", '"firstname": "Jane"'],
    ["urn", "avatar", "https://l/jane"],
  ],
  [
    "get_campaign_stats",
    { campaignId: ID },
    {
      statusCode: 200,
      engagementStats: {
        campaignId: ID,
        audienceSize: 10,
        replies: { replied: 2 },
        channel: { email: { sent: 5 }, enrich: { enriched: 3, proUpgrade: true, businessUpgrade: false } },
        templates: [
          {
            templateId: "t1",
            name: "Step 1",
            sent: 5,
            note: "secret",
            alternatives: [{ templateId: "t1a", alternative: "A", sent: 3, userId: "u1", id: "s1", audioUrl: "a.mp3", note: "secret" }],
          },
        ],
      },
    },
    ['"audienceSize": 10', '"replied": 2', '"enriched": 3', '"templateId": "t1a"', '"alternative": "A"'],
    ["userId", "proUpgrade", "businessUpgrade", "audioUrl", "secret", "statusCode"],
  ],
  [
    "get_conversations_to_reply",
    {},
    { statusCode: 200, data: [{ id: "c1", leadId: ID, identityId: ID, status: "OPEN", userId: "u1" }], total: 1, hasMore: false, nextToken: null },
    ['"id": "c1"', '"total": 1', "nextToken"],
    ["userId", "statusCode"],
  ],
  [
    "remove_lead_from_audience",
    { audience: "DACH", proEmail: "jane@acme.com" },
    { statusCode: 200 },
    ["DACH"],
    ["jane@acme.com"],
  ],
  [
    "list_public_campaigns",
    { type: "public" },
    { statusCode: 200, campaigns: [{ id: ID, name: "Template", origin: "catalog", tags: ["internal-label"], order: 3 }] },
    ["Template", "catalog"],
    ["internal-label", "order", "statusCode"],
  ],
  [
    "get_audience",
    { audienceId: ID },
    { statusCode: 200, data: { id: ID, name: "DACH", size: 3, createdAt: "2026-01-01", modifiedAt: "2026-01-02" } },
    ["DACH"],
    ["createdAt", "modifiedAt", "statusCode"],
  ],
  [
    "ask_your_outbound",
    { query: "SELECT type FROM logs WHERE date >= CURRENT_DATE()" },
    { rows: [{ type: "GOOGLE_REPLY" }], metadata: { jobId: "job1", bytesProcessed: 1, bytesBilled: 1, estimatedCostUsd: 0.1, durationMs: 1 } },
    ["GOOGLE_REPLY"],
    ["metadata", "jobId", "bytes", "estimatedCostUsd", "durationMs"],
  ],
];

describe("tool responses carry only what the request needs (OpenAI data minimization)", () => {
  let client: Client;
  const text = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const result = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeFalsy();
    return result.content[0].text;
  };
  const apiAnswers = (data: unknown) => mockedAxios.mockResolvedValue({ status: 200, data, headers: {} });

  beforeAll(async () => {
    process.env.LGM_API_KEY = "lgmc_test";
    process.env.LGM_DISABLE_TELEMETRY = "true";
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await createMcpServer().connect(serverTransport);
    client = new Client({ name: "test", version: "0" });
    await client.connect(clientTransport);
  });

  beforeEach(() => mockedAxios.mockReset());

  it.each(CASES)("%s", async (name, args, apiBody, kept, dropped) => {
    apiAnswers(apiBody);
    const output = await text(name, args);
    kept.forEach((value) => expect(output).toContain(value));
    dropped.forEach((value) => expect(output).not.toContain(value));
  });

  it("get_audience_leads adds only the fields the user asked for, empty attributes left out", async () => {
    apiAnswers({ statusCode: 200, total: 1, data: [LEAD_RECORD] });
    const output = await text("get_audience_leads", { audienceId: ID, include: ["proEmail", "customAttributes"] });
    expect(output).toContain("jane@acme.com");
    expect(output).toContain('"customAttribute1": "note"');
    expect(output).not.toContain("customAttribute2");
    expect(output).not.toContain("persoEmail");
  });

  it("no tool relays a whole API body", () => {
    const source = readFileSync(join(__dirname, "tools.ts"), "utf8");
    expect(source.match(/formatTextContent\(\s*"[^"]+",\s*(data|payload)\s*\)/g)).toBeNull();
  });

  it("search_lead returns a requested identifier, without sending `include` to the API", async () => {
    apiAnswers({ statusCode: 200, lead: { ...LEAD_RECORD, hubspot: { id: "crm42" } } });
    const output = await text("search_lead", { leadId: ID, include: ["persoEmail", "crmId"] });
    expect(output).toContain("jane@home.com");
    expect(output).toContain('"crmId": "crm42"');
    expect(output).not.toContain("+33600000000");
    expect(new URL(mockedAxios.mock.calls[0][0].url).searchParams.has("include")).toBe(false);
  });

  it("list_manual_tasks gives a phone number on request only", async () => {
    const lead = { firstname: "Jane", phone: "+33600000000", companyPhone: "+33100000000", proEmail: "jane@acme.com", linkedinUrl: "https://l" };
    apiAnswers({ statusCode: 200, total: 1, data: [{ manualTaskId: "call1", type: "CALL", lead, createdAt: "2026-11-06", identityId: ID }] });
    const withoutPhone = await text("list_manual_tasks", {});
    ["+33600000000", "+33100000000", "jane@acme.com", "linkedinUrl", "createdAt", "identityId"].forEach((value) =>
      expect(withoutPhone).not.toContain(value),
    );
    const withPhone = await text("list_manual_tasks", { include: ["phone"] });
    expect(withPhone).toContain("+33600000000");
    expect(withPhone).not.toContain("+33100000000");
  });

  it("get_campaign_leads_stats adds an email on request", async () => {
    apiAnswers({ count: 1, hasMore: false, leads: [{ id: ID, firstname: "Jane", email: "jane@acme.com", linkedinUrl: "https://l" }] });
    const output = await text("get_campaign_leads_stats", { campaignId: ID, include: ["email"] });
    expect(output).toContain("jane@acme.com");
    expect(output).not.toContain("linkedinUrl");
  });
});
