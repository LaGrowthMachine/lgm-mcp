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
const WORKSPACE_ID = "64f0c2a1b3d4e5f6a7b8c9d2";
const STEP_ID = "c8e1f2d3-0000-4e5f-9a10-000000000003";
const KEY = { campaignId: CAMPAIGN_ID, stepId: STEP_ID, leadId: LEAD_ID };
const VERSION_PATH = `/flow/campaigns/${CAMPAIGN_ID}/steps/${STEP_ID}/lead-messages/${LEAD_ID}`;

type ToolResult = { content: Array<{ text: string }>; isError?: boolean };
type AxiosCall = { method: string; url: string; data?: Record<string, unknown>; headers: Record<string, string> };

const VERSION = {
  campaignId: CAMPAIGN_ID,
  stepId: STEP_ID,
  leadId: LEAD_ID,
  stepType: "EMAIL_SEND",
  status: "TO_SEND",
  newHtml: '<p>Bonjour <var name="firstname"/></p>',
  subjectNewHtml: null,
  writtenAt: "2026-11-25T10:00:00.000Z",
  endedAt: null,
  sentMessage: null,
  sentSubject: null,
  abTest: false,
};

const answer = (status: number, data: unknown, headers: Record<string, string> = {}) => ({ status, data, headers });
const requestOf = (index: number): AxiosCall => mockedAxios.mock.calls[index][0];
const payloadOf = (result: ToolResult): Record<string, unknown> => JSON.parse(result.content[0].text.replace(/^## .*\n\n/, ""));

describe("the tools that write, read, list and delete the version of a lead on a campaign step", () => {
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
  });

  it("write_lead_message posts the version of the lead to its step, in the chosen workspace, and returns its status", async () => {
    mockedAxios.mockResolvedValue(answer(200, { statusCode: 200, data: VERSION }));

    const result = await call("write_lead_message", {
      ...KEY,
      newHtml: VERSION.newHtml,
      subjectNewHtml: "<p>Une question</p>",
      workspaceId: WORKSPACE_ID,
    });

    expect(result.isError).toBeFalsy();
    const request = requestOf(0);
    expect(request.method).toBe("POST");
    expect(new URL(request.url).pathname).toBe(VERSION_PATH);
    expect(request.data).toEqual({ newHtml: VERSION.newHtml, subjectNewHtml: "<p>Une question</p>" });
    expect(request.headers["X-LGM-Workspace"]).toBe(WORKSPACE_ID);
    expect(payloadOf(result)).toEqual({
      campaignId: CAMPAIGN_ID,
      stepId: STEP_ID,
      leadId: LEAD_ID,
      stepType: "EMAIL_SEND",
      status: "TO_SEND",
      writtenAt: VERSION.writtenAt,
    });
  });

  it("write_lead_message waits for the delay of a rate limit and retries once", async () => {
    mockedAxios
      .mockResolvedValueOnce(answer(429, { error: "Rate limit exceeded", retryAfter: 0 }, { "retry-after": "0" }))
      .mockResolvedValueOnce(answer(200, { statusCode: 200, data: VERSION }));

    const result = await call("write_lead_message", { ...KEY, newHtml: VERSION.newHtml });

    expect(mockedAxios).toHaveBeenCalledTimes(2);
    expect(result.isError).toBeFalsy();
    expect(payloadOf(result).status).toBe("TO_SEND");
  });

  it("write_lead_message returns a second rate limit to the host without a third call", async () => {
    mockedAxios.mockResolvedValue(answer(429, { error: "Rate limit exceeded", retryAfter: 0 }, { "retry-after": "0" }));

    const result = await call("write_lead_message", { ...KEY, newHtml: VERSION.newHtml });

    expect(mockedAxios).toHaveBeenCalledTimes(2);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("429");
    expect(result.content[0].text).toContain("Retry in 0 seconds");
  });

  it("write_lead_message returns a long rate limit at once with its delay, without waiting nor calling again", async () => {
    mockedAxios.mockResolvedValue(answer(429, { error: "Rate limit exceeded", retryAfter: 30 }, { "retry-after": "30" }));

    const result = await call("write_lead_message", { ...KEY, newHtml: VERSION.newHtml });

    expect(mockedAxios).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Retry in 30 seconds");
  });

  it.each([
    ["write_lead_message", { ...KEY, leadId: `x/../../../../../audiences/${CAMPAIGN_ID}`, newHtml: "<p>Hi</p>" }],
    ["delete_lead_message", { ...KEY, leadId: `x/../../../../../audiences/${CAMPAIGN_ID}` }],
    ["get_lead_message", { ...KEY, campaignId: "../leads" }],
  ])("%s refuses an id that is not a 24-character hex id, without calling the API", async (name, args) => {
    const result = await call(name, args);

    expect(mockedAxios).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
  });

  it("write_lead_message relays the refusal of the API with its reason", async () => {
    mockedAxios.mockResolvedValue(answer(400, { error: "This lead has already received this step." }));

    const result = await call("write_lead_message", { ...KEY, newHtml: VERSION.newHtml });

    expect(mockedAxios).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("This lead has already received this step.");
  });

  it("get_lead_message reads the version of the lead with its text and status", async () => {
    mockedAxios.mockResolvedValue(
      answer(200, { statusCode: 200, data: { ...VERSION, status: "SENT", sentMessage: "Bonjour Paul", endedAt: "2026-11-25T11:00:00.000Z" } }),
    );

    const result = await call("get_lead_message", KEY);

    const request = requestOf(0);
    expect(request.method).toBe("GET");
    expect(new URL(request.url).pathname).toBe(VERSION_PATH);
    expect(payloadOf(result)).toMatchObject({ status: "SENT", newHtml: VERSION.newHtml, sentMessage: "Bonjour Paul" });
  });

  it("list_lead_messages pages the versions of a step without their text", async () => {
    mockedAxios.mockResolvedValue(
      answer(200, {
        statusCode: 200,
        data: [{ leadId: LEAD_ID, status: "TO_SEND", writtenAt: VERSION.writtenAt, endedAt: null, abTest: false }],
        total: 12,
        nextCursor: "next-page",
      }),
    );

    const result = await call("list_lead_messages", { campaignId: CAMPAIGN_ID, stepId: STEP_ID, limit: 1, cursor: "this-page" });

    const url = new URL(requestOf(0).url);
    expect(url.pathname).toBe(`/flow/campaigns/${CAMPAIGN_ID}/steps/${STEP_ID}/lead-messages`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ limit: "1", cursor: "this-page" });
    expect(payloadOf(result)).toEqual({
      total: 12,
      nextCursor: "next-page",
      data: [{ leadId: LEAD_ID, status: "TO_SEND", writtenAt: VERSION.writtenAt, endedAt: null, abTest: false }],
    });
  });

  it("delete_lead_message deletes the version of the lead on its step", async () => {
    mockedAxios.mockResolvedValue(answer(200, { statusCode: 200, data: { ...KEY, deleted: true } }));

    const result = await call("delete_lead_message", KEY);

    const request = requestOf(0);
    expect(request.method).toBe("DELETE");
    expect(new URL(request.url).pathname).toBe(VERSION_PATH);
    expect(payloadOf(result)).toEqual({ ...KEY, deleted: true });
  });
});
