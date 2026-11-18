/*
 * Copyright 2026 La Growth Machine
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readFileSync } from "fs";
import { join } from "path";
import { createMcpServer } from "./server";
import manifest from "../manifest.json";

// Garde de soumission aux annuaires (OpenAI refuse un hint à null, Anthropic exige title).
// openWorldHint=true dès qu'un tool atteint un système hors LGM ou qu'il peut faire partir un message
// vers un lead. Un catalogue borné reste false, même public. Liste à tenir à jour avec les tools.
const OPEN_WORLD = new Set([
  "create_audience_from_linkedin_url",
  "create_lead",
  "enrich_lead",
  "enrich_linkedin_post",
  "send_linkedin_message",
  "send_email_message",
  "complete_call_task",
  "complete_message_task",
  "pause_campaign",
  "resume_campaign",
  "launch_campaign",
  "set_campaign_crm_sync",
  "set_campaign_setting",
  "edit_campaign_message",
  "add_campaign_step_message",
  "set_lead_status",
]);

// OpenAI : « Use false only for additive writes without destructive or irreversible effects », et pouvoir
// annuler ne justifie pas false. Une écriture qui remplace une valeur ou change un état est donc destructive.
const ADDITIVE_WRITES: string[] = [];

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
      const keys = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const;
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

  it("only additive writes escape destructiveHint", () => {
    const writes = tools.filter((t) => !t.annotations?.readOnlyHint);
    expect(writes.filter((t) => !t.annotations?.destructiveHint).map((t) => t.name)).toEqual(ADDITIVE_WRITES);
  });

  it("openWorldHint matches the reviewed list of tools reaching outside LGM", () => {
    const actual = tools.filter((t) => t.annotations?.openWorldHint).map((t) => t.name).sort();
    expect(actual).toEqual([...OPEN_WORLD].sort());
  });

  it("docs/tool-annotations.json justifies each tool's current hints", () => {
    const file = JSON.parse(readFileSync(join(__dirname, "../docs/tool-annotations.json"), "utf8"));
    const current = Object.fromEntries(
      tools.map(({ name, annotations }) => {
        const { title: _title, ...hints } = annotations ?? {};
        return [name, hints];
      }),
    );
    const documented = Object.fromEntries(Object.entries<{ annotations: unknown }>(file).map(([name, entry]) => [name, entry.annotations]));
    expect(documented).toEqual(current);
    const unjustified = Object.entries<Record<string, string>>(file).filter(
      ([, entry]) => !entry.read_only_justification || !entry.open_world_justification || !entry.destructive_justification,
    );
    expect(unjustified.map(([name]) => name)).toEqual([]);
  });

  it("manifest.json lists exactly the registered tools", () => {
    expect(manifest.tools.map((t: { name: string }) => t.name).sort()).toEqual(tools.map((t) => t.name).sort());
  });
});
