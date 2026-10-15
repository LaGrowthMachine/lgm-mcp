/*
 * Copyright 2026 La Growth Machine
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "./server";
import manifest from "../manifest.json";

// Garde de soumission aux annuaires (OpenAI exige readOnly/destructive/openWorld en booléens explicites,
// Anthropic exige title) : openWorldHint=true dès qu'un tool atteint du contenu public ou hors LGM.
// Liste à tenir à jour quand un tool lit/écrit LinkedIn, l'email ou du contenu public hors workspace.
const OPEN_WORLD = new Set([
  "list_public_campaigns",
  "create_audience_from_linkedin_url",
  "create_lead",
  "enrich_lead",
  "enrich_linkedin_post",
  "send_linkedin_message",
  "send_email_message",
  "complete_message_task",
  "pause_campaign",
  "resume_campaign",
  "launch_campaign",
  "set_campaign_crm_sync",
  "call_api_write",
]);

const listTools = async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createMcpServer().connect(serverTransport);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
  return (await client.listTools()).tools;
};

describe("tool annotations — directory submission rules", () => {
  let tools: Awaited<ReturnType<typeof listTools>>;
  beforeAll(async () => {
    tools = await listTools();
  });

  it("every tool sets title + explicit boolean hints", () => {
    const bad = tools.flatMap((t) => {
      const a = t.annotations ?? {};
      const keys = ["readOnlyHint", "destructiveHint", "openWorldHint"] as const;
      const missing: string[] = keys.filter((k) => typeof a[k] !== "boolean");
      if (!a.title) missing.push("title");
      return missing.length ? [`${t.name}: ${missing.join(", ")}`] : [];
    });
    expect(bad).toEqual([]);
  });

  it("reads are never destructive", () => {
    const bad = tools.filter((t) => t.annotations?.readOnlyHint && t.annotations.destructiveHint).map((t) => t.name);
    expect(bad).toEqual([]);
  });

  it("openWorldHint matches the reviewed list of tools reaching outside LGM", () => {
    const actual = tools.filter((t) => t.annotations?.openWorldHint).map((t) => t.name).sort();
    expect(actual).toEqual([...OPEN_WORLD].sort());
  });

  it("manifest.json lists exactly the registered tools", () => {
    expect(manifest.tools.map((t: { name: string }) => t.name).sort()).toEqual(tools.map((t) => t.name).sort());
  });
});
