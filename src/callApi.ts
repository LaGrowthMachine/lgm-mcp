/*
 * Copyright 2026 La Growth Machine
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */
import { FLOW_ROUTES } from "./flowCatalogue.generated";

export type FlowRoute = (typeof FLOW_ROUTES)[number];

// Documented routes with an irreversible or outbound effect: call_api_write reaches them only with
// confirm=true, after the consequence below has been surfaced to the user (same lockstep as
// enrich_lead). Prefer the dedicated tool when one exists — it carries a stronger guard-rail.
// ponytail: soft guard (the model can still chain both calls); MCP elicitation once clients support it.
export const CALL_API_SENSITIVE: Record<string, string> = {
  "POST /leads/enrich": "spends credits — prefer enrich_lead, which previews the cost first",
  "POST /leads/status": "ends the lead's running campaign (CRM / Zapier sync) — prefer set_lead_status; needs body.leadId and one campaign id",
  "POST /inbox/linkedin": "sends a real LinkedIn message to the lead — prefer send_linkedin_message",
  "POST /inbox/email": "sends a real email to the lead — prefer send_email_message",
  "POST /inboxWebhooks": "forwards every inbox message to the given URL — make sure the user owns that URL",
  "DELETE /inboxWebhooks/:webhookId": "permanently removes an inbox webhook and its integration",
};

// Routes a dedicated tool already covers. call_api_read / call_api_write are a LAST RESORT: the first call on one of these
// is refused with the tool name; confirm=true overrides only when that tool genuinely lacks a
// parameter the user needs. Keep in sync when adding a tool (the test checks every key resolves).
export const CALL_API_DEDICATED: Record<string, string> = {
  "GET /audiences": "list_audiences",
  "POST /audiences": "create_audience_from_linkedin_url",
  "GET /audiences/:audienceId/detail": "get_audience",
  "GET /audiences/:audienceId/leads": "get_audience_leads",
  "GET /campaigns": "list_campaigns",
  "GET /campaigns/:campaignId/messages": "get_campaign_messages",
  "POST /campaigns/:campaignId/settings":
    "rename_campaign / set_campaign_audience / set_campaign_identity / set_campaign_setting / set_campaign_crm_sync",
  "GET /campaigns/:campaignId/stats": "get_campaign_stats",
  "POST /campaigns/:campaignId/status": "pause_campaign / resume_campaign",
  "GET /conversations/:conversationId/messages": "get_conversation_messages",
  "GET /conversations/search": "search_conversations / get_conversations_to_reply / get_unread_conversations / get_favourite_conversations",
  "GET /credits": "get_credits",
  "GET /identities": "list_identities",
  "POST /inbox/conversations/archive": "archive_conversation",
  "POST /inbox/conversations/snooze": "snooze_conversation",
  "POST /inbox/conversations/unarchive": "unarchive_conversation",
  "POST /inbox/conversations/unsnooze": "unsnooze_conversation",
  "POST /inbox/email": "send_email_message",
  "POST /inbox/linkedin": "send_linkedin_message",
  "POST /leads": "create_lead",
  "GET /leads/:leadId/conversations": "get_lead_conversations",
  "GET /leads/:leadId/logs": "get_lead_logs",
  "POST /leads/enrich": "enrich_lead",
  "GET /leads/enrich/:enrichRequestId": "get_enrich_result",
  "POST /leads/status": "set_lead_status",
  "GET /members": "list_members",
};

// Routes whose dedicated tools raised the timeout to 120s: the API does the work in the request
// (CRM sync, real send) and a client-side timeout on a send that still goes through invites a
// duplicate on retry. Same default here unless the caller passes timeoutSeconds.
export const CALL_API_SLOW = new Set([...Object.keys(CALL_API_SENSITIVE), "POST /campaigns/:campaignId/status"]);

// POST /leads/status: the API's `campaign: "all"` loop returns early with a partial result, and without
// leadId it takes leads[0] of a name search — possibly the wrong lead. set_lead_status exposes only the safe shape.
export const assertLeadStatusBody = (body: Record<string, unknown> | undefined): void => {
  if (typeof body?.leadId !== "string" || typeof body.campaign !== "string" || body.campaign === "all") {
    throw new Error("POST /leads/status via call_api_write needs body.leadId and a single campaign id (not \"all\") — prefer set_lead_status.");
  }
};

// One segment = letters, digits, - and _ only. Rejects `.`, `..`, `%xx`, `?`, `#`, `\`, empty:
// `new URL()` in callFlow would normalise `..` / `%2e%2e`, and `..` would otherwise match a `:param`.
const SEGMENT = /^[A-Za-z0-9_-]+$/;

const matchesTemplate = (template: string, segments: string[]): boolean => {
  const templateSegments = template.slice(1).split("/");
  return (
    templateSegments.length === segments.length &&
    templateSegments.every((part, index) => part.startsWith(":") || part === segments[index])
  );
};

export const resolveCallApiRoute = (method: string, path: string): FlowRoute => {
  const segments = path.split("/");
  if (segments.length < 2 || segments[0] !== "" || !segments.slice(1).every((segment) => SEGMENT.test(segment))) {
    throw new Error(
      `Invalid path "${path}": expected a path relative to /flow such as /campaigns/<id>/stats ` +
        "(letters, digits, - and _ only in each segment; no query string).",
    );
  }
  const route = FLOW_ROUTES.find((candidate) => candidate.method === method && matchesTemplate(candidate.path, segments.slice(1)));
  if (!route) {
    throw new Error(`${method} ${path} is not in the documented LGM API — see the endpoint catalogue in the call_api_read / call_api_write descriptions.`);
  }
  return route;
};

// read=true → the GET routes (call_api_read), false → the others (call_api_write).
export const buildCatalogueText = (read: boolean): string =>
  FLOW_ROUTES.filter((route) => (route.method === "GET") === read).map(
    (route) =>
      `${route.method} ${route.path} — ${route.summary}` +
      (route.query.length ? ` (query: ${route.query.join(", ")})` : "") +
      (route.body.length ? ` (body: ${route.body.join(", ")})` : "") +
      (CALL_API_DEDICATED[`${route.method} ${route.path}`] ? ` [dedicated tool: ${CALL_API_DEDICATED[`${route.method} ${route.path}`]}]` : "") +
      (CALL_API_SENSITIVE[`${route.method} ${route.path}`] ? " [requires confirm=true]" : ""),
  ).join("\n");
