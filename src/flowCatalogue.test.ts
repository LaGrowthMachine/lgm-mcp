/*
 * Copyright 2026 La Growth Machine
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */
import { readFileSync } from "fs";
import { buildCatalogue, EXPORT_PATH, PostmanItem } from "../scripts/generate-flow-catalogue";
import { FLOW_ROUTES } from "./flowCatalogue.generated";

const routeKey = (route: { method: string; path: string }): string => `${route.method} ${route.path}`;

describe("flowCatalogue.generated — drift against the committed Postman export", () => {
  const exported = buildCatalogue(JSON.parse(readFileSync(EXPORT_PATH, "utf8")));

  it("contains every route of the committed export (export updated without `npm run generate:catalogue`?)", () => {
    const generated = new Set(FLOW_ROUTES.map(routeKey));
    expect(exported.map(routeKey).filter((key) => !generated.has(key))).toEqual([]);
    expect(FLOW_ROUTES.length).toBeGreaterThanOrEqual(30);
  });

  it.each(["/webhook/stripe", "/mcp/bigquery/query", "/tracking/mcp", "/check-email"])("never lists plumbing route %s", (path) => {
    expect(FLOW_ROUTES.find((route) => route.path === path)).toBeUndefined();
  });
});

describe("buildCatalogue — online doc shape vs Postman v2.1 export shape", () => {
  const url = {
    path: ["flow", "campaigns", ":campaignId", "stats"],
    query: [{ key: "apikey" }, { key: "limit" }],
  };
  const body = { mode: "raw", raw: '{ "status": "PAUSED", // comment\n "url": "https://x" }' };
  const onlineItem: PostmanItem = {
    name: "Stats",
    request: {
      method: "POST",
      url: "https://apiv2.lagrowthmachine.com/flow/campaigns/:campaignId/stats?apikey=x&limit=1",
      urlObject: url,
      description: '<h2 id="x">Campaign stats</h2>\n<p>Details</p>',
      body,
    },
  };
  const exportItem: PostmanItem = {
    name: "Stats",
    request: { method: "POST", url, description: "## Campaign stats\n\nDetails", body },
  };

  it("yields the same route from both shapes, dropping `flow`, `apikey` and JS comments in the example body", () => {
    const [fromOnline] = buildCatalogue({ item: [{ name: "Campaigns", item: [onlineItem] }] });
    const [fromExport] = buildCatalogue({ item: [exportItem] });
    expect(fromOnline).toEqual({
      method: "POST",
      path: "/campaigns/:campaignId/stats",
      query: ["limit"],
      body: ["status", "url"],
      summary: "Campaign stats",
    });
    expect(fromExport).toEqual(fromOnline);
  });

  it("falls back to the item name when there is no description and dedupes method + path", () => {
    const item: PostmanItem = { name: "List identities", request: { method: "GET", url: { path: ["flow", "identities"] } } };
    expect(buildCatalogue({ item: [item, item] })).toEqual([
      { method: "GET", path: "/identities", query: [], body: [], summary: "List identities" },
    ]);
  });
});
