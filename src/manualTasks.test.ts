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

const TASK_ID = "6650f1c2a1b2c3d4e5f60718";
const LEAD_ID = "64f0c2a1b3d4e5f6a7b8c9d0";

type ToolResult = { isError?: boolean; content: Array<{ type: string; text: string }> };
type AxiosConfig = { method: string; url: string; data?: unknown; timeout: number };

const connectClient = async (): Promise<Client> => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createMcpServer().connect(serverTransport);
  const client = new Client({ name: "manual-tasks-test", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
};

const callTool = async (client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> =>
  (await client.callTool({ name, arguments: args })) as ToolResult;

const flowCalls = (): AxiosConfig[] => mockedAxios.mock.calls.map(([config]) => config as AxiosConfig);

describe("manual task tools", () => {
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
    mockedAxios.mockResolvedValue({ status: 200, data: { statusCode: 200, data: [], total: 0 }, headers: {} });
  });

  it("registers the three tools with read / write annotations", async () => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

    expect(byName.list_manual_tasks.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(byName.complete_call_task.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false });
    expect(byName.complete_message_task.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
  });

  it("points set_lead_status to complete_call_task for the outcome of a call, in its description and the instructions", async () => {
    const { tools } = await client.listTools();
    const setLeadStatus = tools.find((tool) => tool.name === "set_lead_status");
    const pointer = "If the user reports the outcome of a call for a lead that has an open call task, use complete_call_task instead";

    expect(setLeadStatus?.description).toContain(pointer);
    expect(client.getInstructions()).toContain(pointer);
  });

  describe("list_manual_tasks", () => {
    it("GETs /flow/manualtasks with the filters and default pagination in the query string", async () => {
      const result = await callTool(client, "list_manual_tasks", { type: "CALL", leadId: LEAD_ID });

      expect(result.isError).toBeFalsy();
      const [request] = flowCalls();
      expect(request.method).toBe("GET");
      const url = new URL(request.url);
      expect(url.pathname).toBe("/flow/manualtasks");
      expect(Object.fromEntries(url.searchParams)).toEqual({ type: "CALL", leadId: LEAD_ID, skip: "0", limit: "25" });
    });

    it("refuses a skip beyond 10000, before any request", async () => {
      const result = await callTool(client, "list_manual_tasks", { skip: 10001 });

      expect(result.isError).toBe(true);
      expect(mockedAxios).not.toHaveBeenCalled();
    });

    it("omits the filters that are not set", async () => {
      await callTool(client, "list_manual_tasks", {});

      const url = new URL(flowCalls()[0].url);
      expect(Object.fromEntries(url.searchParams)).toEqual({ skip: "0", limit: "25" });
    });
  });

  describe("complete_call_task", () => {
    it("POSTs the outcome as callStatus with the tag, without retry, and reports the stopped sequence", async () => {
      const result = await callTool(client, "complete_call_task", { manualTaskId: TASK_ID, outcome: "DECISIVE", tag: "INTERESTED" });

      expect(result.isError).toBeFalsy();
      expect(flowCalls()).toHaveLength(1);
      const [request] = flowCalls();
      expect(request.method).toBe("POST");
      expect(new URL(request.url).pathname).toBe("/flow/manualtasks/call/complete");
      expect(request.data).toEqual({ manualTaskId: TASK_ID, callStatus: "DECISIVE", tag: "INTERESTED" });
      expect(result.content[0].text).toContain("Call Task Completed");
      expect(result.content[0].text).toContain("stopped in this campaign");
    });

    it("sends no tag for an unreachable lead and reports that the sequence continues", async () => {
      const result = await callTool(client, "complete_call_task", { manualTaskId: TASK_ID, outcome: "UNREACHABLE" });

      expect(flowCalls()[0].data).toEqual({ manualTaskId: TASK_ID, callStatus: "UNREACHABLE" });
      expect(result.content[0].text).toContain("continues with its next step");
    });

    it("refuses DECISIVE without the lead's answer, before any request", async () => {
      const result = await callTool(client, "complete_call_task", { manualTaskId: TASK_ID, outcome: "DECISIVE" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("tag is required");
      expect(mockedAxios).not.toHaveBeenCalled();
    });

    it("refuses a tag on an unreachable lead, before any request", async () => {
      const result = await callTool(client, "complete_call_task", { manualTaskId: TASK_ID, outcome: "UNREACHABLE", tag: "INTERESTED" });

      expect(result.isError).toBe(true);
      expect(mockedAxios).not.toHaveBeenCalled();
    });

    it("points to list_manual_tasks when the task is unknown", async () => {
      mockedAxios.mockResolvedValue({ status: 404, data: { error: "Manual task not found" }, headers: {} });

      const result = await callTool(client, "complete_call_task", { manualTaskId: TASK_ID, outcome: "UNREACHABLE" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Manual task not found");
      expect(result.content[0].text).toContain("open CALL task from list_manual_tasks");
      expect(result.content[0].text).toContain("with the same workspaceId as that listing if one was used");
    });

    it("surfaces the refusal of a call task that is already completed", async () => {
      mockedAxios.mockResolvedValue({ status: 400, data: { error: "This call task is already completed" }, headers: {} });

      const result = await callTool(client, "complete_call_task", { manualTaskId: TASK_ID, outcome: "UNREACHABLE" });

      expect(flowCalls()).toHaveLength(1);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("This call task is already completed");
    });

    it("does not retry a 5xx and asks to check list_manual_tasks before any new attempt", async () => {
      mockedAxios.mockResolvedValue({ status: 502, data: "", headers: {} });

      const result = await callTool(client, "complete_call_task", { manualTaskId: TASK_ID, outcome: "UNREACHABLE" });

      expect(flowCalls()).toHaveLength(1);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("check list_manual_tasks, with the same workspaceId as this call if one was used, before retrying");
    });
  });

  describe("complete_message_task", () => {
    it("POSTs the message with the email fields to /flow/manualtasks/message/complete", async () => {
      const result = await callTool(client, "complete_message_task", {
        manualTaskId: TASK_ID,
        message: "<p>Bonjour Marie</p>",
        subject: "Notre échange",
        cc: "boss@acme.com",
      });

      expect(result.isError).toBeFalsy();
      const [request] = flowCalls();
      expect(request.method).toBe("POST");
      expect(new URL(request.url).pathname).toBe("/flow/manualtasks/message/complete");
      expect(request.data).toEqual({ manualTaskId: TASK_ID, message: "<p>Bonjour Marie</p>", subject: "Notre échange", cc: "boss@acme.com" });
      expect(result.content[0].text).toContain("Custom Message Task Completed");
    });

    it("points to list_manual_tasks when the task is not a custom-message task", async () => {
      mockedAxios.mockResolvedValue({ status: 404, data: { error: "This manual task is not a custom message task" }, headers: {} });

      const result = await callTool(client, "complete_message_task", { manualTaskId: TASK_ID, message: "Hello" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("open CUSTOM_MESSAGE task from list_manual_tasks");
      expect(result.content[0].text).toContain("with the same workspaceId as that listing if one was used");
    });

    it("does not point to list_manual_tasks when the 404 is not about the task", async () => {
      mockedAxios.mockResolvedValue({ status: 404, data: { error: "Conversation not found" }, headers: {} });

      const result = await callTool(client, "complete_message_task", { manualTaskId: TASK_ID, message: "Hello" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Conversation not found");
      expect(result.content[0].text).not.toContain("list_manual_tasks");
    });

    it("surfaces the refusal of an invite note longer than LinkedIn allows", async () => {
      mockedAxios.mockResolvedValue({
        status: 400,
        data: { error: "The LinkedIn invitation note of this identity can only have 200 characters" },
        headers: {},
      });

      const result = await callTool(client, "complete_message_task", { manualTaskId: TASK_ID, message: "a".repeat(201) });

      expect(flowCalls()).toHaveLength(1);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("can only have 200 characters");
    });
  });
});
