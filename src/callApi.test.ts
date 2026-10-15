/*
 * Copyright 2026 La Growth Machine
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */
import { CALL_API_DEDICATED, CALL_API_SENSITIVE, CALL_API_SLOW, assertLeadStatusBody, buildCatalogueText, resolveCallApiRoute } from "./callApi";

const CAMPAIGN_ID = "64f0c2a1b3d4e5f6a7b8c9d0";

describe("resolveCallApiRoute — allowlist = documented catalogue", () => {
  it("resolves a concrete path to its template route", () => {
    const route = resolveCallApiRoute("GET", `/campaigns/${CAMPAIGN_ID}/statsleads`);
    expect(route.path).toBe("/campaigns/:campaignId/statsleads");
    expect(route.query).toEqual(["getLeadsAfter", "getLeadsBefore"]);
  });

  it("accepts POST /leads/status", () => {
    expect(resolveCallApiRoute("POST", "/leads/status").path).toBe("/leads/status");
  });

  it.each([
    "/campaigns/../stats",
    "/campaigns/%2e%2e/stats",
    "/campaigns/\\..\\stats",
    "/campaigns?x=1",
    "/campaigns#x",
    "//campaigns",
    "/campaigns/",
    "campaigns",
    "https://evil/x",
    "",
  ])("rejects a malformed path before any lookup: %s", (path) => {
    expect(() => resolveCallApiRoute("GET", path)).toThrow(/Invalid path/);
  });

  it.each(["/manualtasks/call/complete", "/webhook/stripe", "/mcp/bigquery/query", "/tracking/mcp", "/check-email"])(
    "rejects an undocumented path: %s",
    (path) => {
      expect(() => resolveCallApiRoute("POST", path)).toThrow(/not in the documented LGM API/);
    },
  );

  it("rejects a verb not documented for a documented path", () => {
    expect(() => resolveCallApiRoute("DELETE", "/campaigns")).toThrow(/not in the documented LGM API/);
  });

  it("does not let a param segment swallow a longer path", () => {
    expect(() => resolveCallApiRoute("GET", `/campaigns/${CAMPAIGN_ID}/stats/extra`)).toThrow(/not in the documented LGM API/);
  });

  it.each([
    ["POST", "/leads/enrich"],
    ["POST", "/inbox/linkedin"],
    ["POST", "/inbox/email"],
    ["POST", "/inboxWebhooks"],
    ["DELETE", "/inboxWebhooks/whk_1"],
  ])("resolves the sensitive documented route %s %s and flags it for confirmation", (method, path) => {
    const route = resolveCallApiRoute(method, path);
    expect(CALL_API_SENSITIVE[`${route.method} ${route.path}`]).toBeDefined();
  });
});

describe("buildCatalogueText", () => {
  it("lists the GET routes with their known params for call_api_read, and nothing else", () => {
    const text = buildCatalogueText(true);
    expect(text).toContain("GET /campaigns/:campaignId/statsleads — ");
    expect(text).toContain("(query: getLeadsAfter, getLeadsBefore)");
    expect(text.split("\n").every((line) => line.startsWith("GET "))).toBe(true);
  });

  it("lists the other routes for call_api_write, no GET, and marks the sensitive ones", () => {
    const text = buildCatalogueText(false);
    expect(text).not.toMatch(/^GET /m);
    expect(text).toContain("POST /leads/status — ");
    expect(text).toMatch(/POST \/leads\/enrich — .* \[requires confirm=true\]/);
    expect(text).toMatch(/POST \/inboxWebhooks — .* \[requires confirm=true\]/);
    expect(text).toMatch(/POST \/leads\/status — .*\[requires confirm=true\]/);
  });
});

describe("call_api guard-rails", () => {
  it("maps every dedicated-tool route to a documented catalogue route and flags it in the text", () => {
    for (const key of Object.keys(CALL_API_DEDICATED)) {
      const [method, path] = key.split(" ");
      expect(resolveCallApiRoute(method, path.replace(/:[a-zA-Z]+/g, "abc")).path).toBe(path);
    }
    expect(buildCatalogueText(false)).toMatch(/POST \/leads — .*\[dedicated tool: create_lead\]/);
  });

  it("defaults sends, campaign status and lead status to the slow timeout", () => {
    expect(CALL_API_SLOW.has("POST /inbox/email")).toBe(true);
    expect(CALL_API_SLOW.has("POST /campaigns/:campaignId/status")).toBe(true);
    expect(CALL_API_SLOW.has("GET /campaigns")).toBe(false);
  });

  it("rejects POST /leads/status bodies set_lead_status deliberately excludes", () => {
    expect(() => assertLeadStatusBody({ leadId: "a", campaign: "all", status: "INTERESTED" })).toThrow(/single campaign/);
    expect(() => assertLeadStatusBody({ leadId: "a", campaign: ["b"], status: "INTERESTED" })).toThrow();
    expect(() => assertLeadStatusBody({ firstname: "John", campaign: "b", status: "INTERESTED" })).toThrow(/leadId/);
    expect(() => assertLeadStatusBody({ leadId: "a", campaign: "b", status: "INTERESTED" })).not.toThrow();
  });
});
