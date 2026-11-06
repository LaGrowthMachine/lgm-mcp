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

const ID = "64f0c2a1b3d4e5f6a7b8c9d0";
type ToolResult = { content: Array<{ text: string }>; isError?: boolean };

describe("a call that can send or spend twice is never retried on a server error", () => {
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
    mockedAxios.mockResolvedValue({ status: 502, data: "Bad Gateway", headers: {} });
  });

  it.each([
    ["send_linkedin_message", { identityId: ID, memberId: ID, leadId: ID, message: "Hi" }],
    ["send_email_message", { identityId: ID, leadId: ID, html: "<p>Hi</p>", text: "Hi", subject: "Hello" }],
  ])("%s calls once and tells the host the message may have left", async (name, args) => {
    const result = await call(name, args);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("may have been sent");
  });

  it("enrich_linkedin_post calls once", async () => {
    const result = await call("enrich_linkedin_post", { postUrl: "https://www.linkedin.com/posts/a", confirm: true, acknowledgedCostCredits: 1 });
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
  });

  it("enrich_lead calls the enrichment once", async () => {
    const result = await call("enrich_lead", { firstname: "Jane", lastname: "Doe", companyName: "Acme", confirm: true, acknowledgedCostCredits: 5 });
    const enrichCalls = mockedAxios.mock.calls.filter(([config]) => new URL(config.url).pathname === "/flow/leads/enrich");
    expect(enrichCalls).toHaveLength(1);
    expect(result.isError).toBe(true);
  });

  it("a refused send keeps its own message", async () => {
    mockedAxios.mockResolvedValue({ status: 400, data: { error: "Conversation not found" }, headers: {} });
    const result = await call("send_linkedin_message", { identityId: ID, memberId: ID, leadId: ID, message: "Hi" });
    expect(result.content[0].text).toContain("Conversation not found");
    expect(result.content[0].text).not.toContain("may have been sent");
  });
});
