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
import { TWO_FACTOR_CODE_ELICITATION_TIMEOUT_MS } from "./tools";

jest.mock("axios");
const mockedAxios = axios as unknown as jest.Mock;

const WORKSPACE_ID = "64f0c2a1b3d4e5f6a7b8c9d0";
const CODE = "123456";

type ToolResult = { isError?: boolean; content: Array<{ type: string; text: string }> };
type AxiosConfig = { method: string; url: string; data?: unknown };

const flowCalls = (): AxiosConfig[] => mockedAxios.mock.calls.map(([config]) => config as AxiosConfig);

const TWO_FACTOR_REFUSAL = {
  status: 403,
  headers: {},
  data: {
    error: "Two-factor verification required",
    twoFactorRequired: true,
    reason: "impersonate",
    errors: [{ code: "TWO_FACTOR_REQUIRED", message: "Two-factor verification required", reason: "impersonate" }],
  },
};

// Un client qui sait demander une saisie : il declare la capacite et repond a l'elicitation.
const connectElicitingClient = async (answer: { action: "accept" | "decline" | "cancel"; code?: string }) => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createMcpServer().connect(serverTransport);
  const client = new Client({ name: "eliciting-client", version: "1.0.0" }, { capabilities: { elicitation: {} } });
  const asked: string[] = [];
  client.setRequestHandler(
    (await import("@modelcontextprotocol/sdk/types.js")).ElicitRequestSchema,
    async (request) => {
      asked.push(request.params.message as string);
      return answer.action === "accept"
        ? { action: "accept" as const, content: { code: answer.code } }
        : { action: answer.action };
    },
  );
  await client.connect(clientTransport);
  return { client, asked };
};

const connectPlainClient = async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createMcpServer().connect(serverTransport);
  const client = new Client({ name: "plain-client", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
};

const callTool = async (client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> =>
  (await client.callTool({ name, arguments: args })) as ToolResult;

describe("un client qui sait demander une saisie", () => {
  beforeEach(() => mockedAxios.mockReset());

  it("obtient le code, le prouve, et rejoue l appel : l assistant ne voit pas le refus", async () => {
    const { client, asked } = await connectElicitingClient({ action: "accept", code: CODE });
    mockedAxios
      .mockResolvedValueOnce(TWO_FACTOR_REFUSAL)
      .mockResolvedValueOnce({ status: 200, headers: {}, data: { provenAt: 1 } })
      .mockResolvedValueOnce({ status: 200, headers: {}, data: { campaigns: [] } });

    const result = await callTool(client, "list_campaigns", { workspaceId: WORKSPACE_ID });

    expect(result.isError).toBeFalsy();
    expect(asked).toHaveLength(1);
    const calls = flowCalls();
    expect(calls[0].url).toContain("/flow/campaigns");
    expect(calls[1].url).toContain("/flow/2fa/verify");
    expect(calls[1].data).toEqual({ code: CODE });
    expect(calls[2].url).toContain("/flow/campaigns");
    // Le 4e appel est la telemetrie, qui ne part que si le tool a reussi : elle prouve le rejeu.
    expect(calls[3].url).toContain("/flow/tracking/mcp");
  });

  it("remonte le refus quand l humain decline, sans rien rejouer", async () => {
    const { client } = await connectElicitingClient({ action: "decline" });
    mockedAxios.mockResolvedValue(TWO_FACTOR_REFUSAL);

    const result = await callTool(client, "list_campaigns", { workspaceId: WORKSPACE_ID });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("verify_two_factor");
    expect(flowCalls()).toHaveLength(1);
  });

  it("ne boucle pas quand le workspace refuse encore apres la preuve", async () => {
    const { client } = await connectElicitingClient({ action: "accept", code: CODE });
    mockedAxios
      .mockResolvedValueOnce(TWO_FACTOR_REFUSAL)
      .mockResolvedValueOnce({ status: 200, headers: {}, data: { provenAt: 1 } })
      .mockResolvedValue(TWO_FACTOR_REFUSAL);

    const result = await callTool(client, "list_campaigns", { workspaceId: WORKSPACE_ID });

    expect(result.isError).toBe(true);
    expect(flowCalls()).toHaveLength(3);
  });

  it("remonte un code refuse sans rejouer l appel d origine", async () => {
    const { client } = await connectElicitingClient({ action: "accept", code: "000000" });
    mockedAxios
      .mockResolvedValueOnce(TWO_FACTOR_REFUSAL)
      .mockResolvedValueOnce({ status: 400, headers: {}, data: { error: "Two-factor code refused" } });

    const result = await callTool(client, "list_campaigns", { workspaceId: WORKSPACE_ID });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Two-factor code refused");
    expect(flowCalls()).toHaveLength(2);
  });
});

describe("un client qui ne sait pas demander de saisie", () => {
  beforeEach(() => mockedAxios.mockReset());

  it("retombe sur la consigne rendue a l assistant, sans tenter d elicitation", async () => {
    const client = await connectPlainClient();
    mockedAxios.mockResolvedValue(TWO_FACTOR_REFUSAL);

    const result = await callTool(client, "list_campaigns", { workspaceId: WORKSPACE_ID });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("verify_two_factor");
    expect(flowCalls()).toHaveLength(1);
  });

  it("ne demande pas de formulaire a un client qui ne sait ouvrir qu une url", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await createMcpServer().connect(serverTransport);
    const client = new Client({ name: "url-only-client", version: "1.0.0" }, { capabilities: { elicitation: { url: {} } } });
    const asked = jest.fn();
    client.setRequestHandler((await import("@modelcontextprotocol/sdk/types.js")).ElicitRequestSchema, async () => {
      asked();
      return { action: "cancel" as const };
    });
    await client.connect(clientTransport);
    mockedAxios.mockResolvedValue(TWO_FACTOR_REFUSAL);

    const result = await callTool(client, "list_campaigns", { workspaceId: WORKSPACE_ID });

    expect(asked).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("verify_two_factor");
  });
});

describe("une saisie qui tarde ou qui echoue", () => {
  const LONG_CLIENT_TIMEOUT = { timeout: 2 * TWO_FACTOR_CODE_ELICITATION_TIMEOUT_MS };
  const SLOWER_THAN_THE_SDK_DEFAULT_MS = 90 * 1000;

  const connectClientAnswering = async (answer: () => Promise<{ action: "accept"; content: { code: string } }>) => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await createMcpServer().connect(serverTransport);
    const client = new Client({ name: "slow-client", version: "1.0.0" }, { capabilities: { elicitation: {} } });
    client.setRequestHandler((await import("@modelcontextprotocol/sdk/types.js")).ElicitRequestSchema, answer);
    await client.connect(clientTransport);
    return client;
  };

  const callWithLongTimeout = (client: Client) =>
    client.callTool({ name: "list_campaigns", arguments: { workspaceId: WORKSPACE_ID } }, undefined, LONG_CLIENT_TIMEOUT) as Promise<ToolResult>;

  beforeEach(() => mockedAxios.mockReset());
  afterEach(() => jest.useRealTimers());

  it("laisse a l humain plus d une minute pour sortir son code", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "queueMicrotask", "setImmediate"] });
    const client = await connectClientAnswering(
      () => new Promise((resolve) => setTimeout(() => resolve({ action: "accept", content: { code: CODE } }), SLOWER_THAN_THE_SDK_DEFAULT_MS)),
    );
    mockedAxios
      .mockResolvedValueOnce(TWO_FACTOR_REFUSAL)
      .mockResolvedValueOnce({ status: 200, headers: {}, data: { provenAt: 1 } })
      .mockResolvedValueOnce({ status: 200, headers: {}, data: { campaigns: [] } });

    const pending = callWithLongTimeout(client);
    await jest.advanceTimersByTimeAsync(SLOWER_THAN_THE_SDK_DEFAULT_MS);
    const result = await pending;

    expect(result.isError).toBeFalsy();
    expect(flowCalls()[1].url).toContain("/flow/2fa/verify");
  });

  it("retombe sur la consigne quand la saisie depasse le delai, au lieu d un timeout nu", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "queueMicrotask", "setImmediate"] });
    const client = await connectClientAnswering(() => new Promise(() => undefined));
    mockedAxios.mockResolvedValue(TWO_FACTOR_REFUSAL);

    const pending = callWithLongTimeout(client);
    await jest.advanceTimersByTimeAsync(TWO_FACTOR_CODE_ELICITATION_TIMEOUT_MS + 1000);
    const result = await pending;

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("verify_two_factor");
    expect(flowCalls()).toHaveLength(1);
  });

  it("retombe sur la consigne quand le client repond en erreur", async () => {
    const client = await connectClientAnswering(async () => {
      throw new Error("the client could not show the form");
    });
    mockedAxios.mockResolvedValue(TWO_FACTOR_REFUSAL);

    const result = await callTool(client, "list_campaigns", { workspaceId: WORKSPACE_ID });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("verify_two_factor");
    expect(flowCalls()).toHaveLength(1);
  });
});
