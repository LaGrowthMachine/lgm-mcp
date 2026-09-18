/*
 * Copyright 2026 La Growth Machine
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */
import { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z, ZodRawShape } from "zod";
import { callFlow, McpFlowError } from "./callFlow";
import { trackMcpEvent } from "./tracking";
import { getApiKey, requestContext } from "./requestContext";
import { BIGQUERY_LOGS_GUIDE } from "./bigqueryGuide";

const resolveApiKey = (extra: { authInfo?: { token?: string } }): string => {
  return getApiKey() || extra?.authInfo?.token || "";
};

// Champ `workspaceId` partagé par TOUS les tools (Model 2). Optionnel et rarement utile : la quasi-
// totalité des comptes n'a qu'un workspace et doit laisser ce champ vide (défaut = workspace racine).
const workspaceIdSchema = {
  workspaceId: z
    .string()
    .optional()
    .describe(
      "Target workspace id (from list_workspaces). OMIT this unless the user has multiple workspaces " +
        "(list_workspaces returns multiWorkspace=true) AND explicitly wants to act in another one. " +
        "Almost every account has a single workspace — leave this empty in the normal case.",
    ),
};

// Enrobe server.registerTool pour rendre chaque tool « workspace-aware » sans dupliquer la plomberie :
// le champ `workspaceId` est ajouté au schema, et sa valeur est poussée dans le requestContext le temps
// du handler — callFlow la lit pour le header X-LGM-Workspace. Les handlers existants restent inchangés.
// ChatGPT n'affiche le bouton « Connect » d'un tool que s'il déclare son schéma d'auth dans `_meta`
// (Apps SDK). Tous nos tools exigent le même OAuth compte-entier ; Claude ignore la clé.
const TOOL_META = { securitySchemes: [{ type: "oauth2", scopes: ["openid", "email", "offline_access"] }] };

const registerWorkspaceAwareTool = <InputArgs extends ZodRawShape>(
  server: McpServer,
  name: string,
  config: { description?: string; title?: string; annotations?: ToolAnnotations; inputSchema: InputArgs },
  handler: ToolCallback<InputArgs>,
): void => {
  const mergedSchema = { ...config.inputSchema, ...workspaceIdSchema };
  const wrappedHandler = (args: Record<string, unknown>, extra: unknown): unknown => {
    const store = requestContext.getStore();
    const workspaceId = typeof args.workspaceId === "string" && args.workspaceId.length > 0 ? args.workspaceId : undefined;
    return requestContext.run({ ...store, workspaceId }, () =>
      (handler as (a: unknown, e: unknown) => unknown)(args, extra),
    );
  };
  server.registerTool(name, { ...config, _meta: TOOL_META, inputSchema: mergedSchema }, wrappedHandler as unknown as ToolCallback<typeof mergedSchema>);
};

const formatTextContent = (
  title: string,
  data: unknown,
): { content: Array<{ type: "text"; text: string }> } => {
  return {
    content: [
      {
        type: "text" as const,
        text: `## ${title}\n\n${JSON.stringify(data, null, 2)}`,
      },
    ],
  };
};

// LGM list filters (identityIds, status, ...) travel as comma-separated query
// strings. Accept arrays for ergonomics and join them; drop empties so callFlow
// omits the param entirely.
const csv = (v?: string[]): string | undefined =>
  v && v.length ? v.join(",") : undefined;

const handleToolError = (
  error: unknown,
): { content: Array<{ type: "text"; text: string }>; isError: true } => {
  if (error instanceof McpFlowError) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Error (${error.statusCode}): ${error.message}`,
        },
      ],
      isError: true,
    };
  }
  const message =
    error instanceof Error ? error.message : "Unknown error occurred";
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
};

// Inbox conversation actions (snooze/archive/...) identify the target by ONE of
// conversationId, the lead's linkedinUrl, or the lead's email. Shared schema + guard.
const conversationTargetSchema = {
  conversationId: z
    .string()
    .optional()
    .describe(
      "The conversation ID (24-char hex), from search_conversations / get_lead_conversations.",
    ),
  linkedinUrl: z
    .string()
    .optional()
    .describe("The lead's LinkedIn profile URL — alternative to conversationId."),
  email: z
    .string()
    .optional()
    .describe("The lead's email — alternative to conversationId."),
};

const requireConversationTarget = (p: {
  conversationId?: string;
  linkedinUrl?: string;
  email?: string;
}): { conversationId?: string; linkedinUrl?: string; email?: string } => {
  if (!p.conversationId && !p.linkedinUrl && !p.email) {
    throw new Error(
      "Provide exactly one of: conversationId, linkedinUrl, or email.",
    );
  }
  return {
    conversationId: p.conversationId,
    linkedinUrl: p.linkedinUrl,
    email: p.email,
  };
};

export const registerTools = (server: McpServer) => {
  // Tool 1: list_campaigns
  registerWorkspaceAwareTool(
    server,
    "list_campaigns",
    {
      description:
        "List all campaigns for the authenticated user. Use this to get an overview of outreach campaigns, their statuses, and key metrics. Supports filtering by status and pagination.",
      inputSchema: {
        status: z
          .string()
          .optional()
          .describe(
            'Filter by campaign status (e.g., "RUNNING", "PAUSED", "READY", "CANCELED")',
          ),
        skip: z
          .number()
          .optional()
          .default(0)
          .describe("Number of campaigns to skip for pagination"),
        limit: z
          .number()
          .optional()
          .default(25)
          .describe("Maximum number of campaigns to return (max 25)"),
        search: z.string().optional().describe("Search campaigns by name"),
      },
      annotations: {
        title: "List Campaigns",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
      try {
        const data = await callFlow(apiKey, "/campaigns", params);
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "list_campaigns",
        });
        return formatTextContent("Campaigns", data);
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // Tool 2: get_campaign_stats
  registerWorkspaceAwareTool(
    server,
    "get_campaign_stats",
    {
      description:
        "Get detailed statistics for a specific campaign. Returns metrics like total leads, acceptance rate, reply rate, and conversion data. Use campaign ID from list_campaigns.",
      inputSchema: {
        campaignId: z
          .string()
          .describe("The campaign ID (24-character hex string)"),
      },
      annotations: {
        title: "Get Campaign Statistics",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
      try {
        const data = await callFlow(
          apiKey,
          `/campaigns/${params.campaignId}/stats`,
        );
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "get_campaign_stats",
        });
        return formatTextContent("Campaign Stats", data);
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // Tool 3: get_audience_leads
  registerWorkspaceAwareTool(
    server,
    "get_audience_leads",
    {
      description:
        "Get the list of leads in a specific audience, with the full lead record. Beyond name, company, job title, LinkedIn, phone and pro email, each lead includes location, industry, shortBio, companyUrl, gender, twitter, persoEmail, relationsCount, enrichStatus, emailStatus, emailFoundBy, signal, crm_id, the names of the audiences the lead belongs to, and customAttribute1 through customAttribute20 — so you can segment (e.g. by location or industry) or check deliverability (emailStatus) directly. Each field is populated according to the lead's enrichment level, so a lead that was not enriched returns fewer values. Supports pagination (skip/limit, max 100).",
      inputSchema: {
        audienceId: z
          .string()
          .describe("The audience ID (24-character hex string)"),
        skip: z
          .number()
          .optional()
          .default(0)
          .describe("Number of leads to skip for pagination"),
        limit: z
          .number()
          .optional()
          .default(25)
          .describe("Maximum number of leads to return (max 100)"),
      },
      annotations: {
        title: "Get Audience Leads",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
      try {
        const data = await callFlow(
          apiKey,
          `/audiences/${params.audienceId}/leads`,
          {
            skip: params.skip,
            limit: params.limit,
          },
        );
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "get_audience_leads",
        });
        return formatTextContent("Audience Leads", data);
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // Tool 4: get_lead_logs
  registerWorkspaceAwareTool(
    server,
    "get_lead_logs",
    {
      description:
        "Get activity logs for a specific lead. Shows all actions taken on the lead: emails sent, LinkedIn messages, connection requests, and their statuses. Useful for understanding engagement history.",
      inputSchema: {
        leadId: z.string().describe("The lead ID (24-character hex string)"),
        identityId: z
          .string()
          .optional()
          .describe("Filter logs by identity ID"),
        skip: z
          .number()
          .optional()
          .default(0)
          .describe("Number of logs to skip for pagination"),
        limit: z
          .number()
          .optional()
          .default(25)
          .describe("Maximum number of logs to return (max 100)"),
      },
      annotations: {
        title: "Get Lead Activity Logs",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
      try {
        const data = await callFlow(apiKey, `/leads/${params.leadId}/logs`, {
          identityId: params.identityId,
          skip: params.skip,
          limit: params.limit,
        });
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "get_lead_logs",
        });
        return formatTextContent("Lead Logs", data);
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // Tool 5: get_lead_conversations
  registerWorkspaceAwareTool(
    server,
    "get_lead_conversations",
    {
      description:
        "Get all conversations with a specific lead across all channels (LinkedIn, email). Shows conversation status, last message preview, and whether the lead has replied. Use this to find conversation IDs for get_conversation_messages.",
      inputSchema: {
        leadId: z.string().describe("The lead ID (24-character hex string)"),
        identityId: z
          .string()
          .optional()
          .describe("Filter conversations by identity ID"),
      },
      annotations: {
        title: "Get Lead Conversations",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
      try {
        const data = await callFlow(
          apiKey,
          `/leads/${params.leadId}/conversations`,
          {
            identityId: params.identityId,
          },
        );
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "get_lead_conversations",
        });
        return formatTextContent("Lead Conversations", data);
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // Tool 6: get_conversation_messages
  registerWorkspaceAwareTool(
    server,
    "get_conversation_messages",
    {
      description:
        "Get all messages in a specific conversation. Returns a timeline of sent and received messages with content, sender, channel, and timestamps. Use conversation ID from get_lead_conversations.",
      inputSchema: {
        conversationId: z
          .string()
          .describe("The conversation ID (24-character hex string)"),
      },
      annotations: {
        title: "Get Conversation Messages",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
      try {
        const data = await callFlow(
          apiKey,
          `/conversations/${params.conversationId}/messages`,
        );
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "get_conversation_messages",
        });
        return formatTextContent("Conversation Messages", data);
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // === Phase 2 Tools ===

  // Tool 7: get_campaign_messages
  registerWorkspaceAwareTool(
    server,
    "get_campaign_messages",
    {
      description:
        "Get all message templates for a specific campaign. Returns the sequence of messages (emails, LinkedIn messages) with their type, channel, and order. Each message exposes two HTML representations: `contentHtml`/`subjectHtml` are the rendered output (read-only), while `newHtml`/`subjectNewHtml` are the editable LGM newHtml source — pass these back into edit_campaign_message to modify a message. Useful for reviewing or modifying campaign messaging.",
      inputSchema: {
        campaignId: z
          .string()
          .describe("The campaign ID (24-character hex string)"),
      },
      annotations: {
        title: "Get Campaign Messages",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
      try {
        const data = await callFlow(
          apiKey,
          `/campaigns/${params.campaignId}/messages`,
        );
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "get_campaign_messages",
        });
        return formatTextContent("Campaign Messages", data);
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // Tool 7b: duplicate_campaign
  registerWorkspaceAwareTool(
    server,
    "duplicate_campaign",
    {
      description:
        "Duplicate an existing campaign. Creates a full copy of the campaign — its sequence and every step's message template (new template IDs) — in a draft (READY) state, without launching it. Use the campaign ID from list_campaigns. After duplicating, use get_campaign_messages on the new campaign to fetch its templates and edit_campaign_message to rewrite them.",
      inputSchema: {
        campaignId: z
          .string()
          .describe("The campaign ID to duplicate (24-character hex string), from list_campaigns"),
      },
      annotations: {
        title: "Duplicate Campaign",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
      try {
        const data = await callFlow(
          apiKey,
          `/campaigns/${params.campaignId}/duplicate`,
          {},
          { method: "POST" },
        );
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "duplicate_campaign",
        });
        return formatTextContent("Campaign Duplicated", data);
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // Tool 7c: edit_campaign_message
  registerWorkspaceAwareTool(
    server,
    "edit_campaign_message",
    {
      description:
        "Replace the content of one campaign step's existing message. Provide the new message as `newHtml` in LGM's newHtml format; for EMAIL steps also pass `subjectNewHtml`. The content is validated server-side and rejected if malformed. Get the campaignId and templateId from get_campaign_messages (templateId = each message's `id`). Typical flow: duplicate_campaign → get_campaign_messages → edit_campaign_message for each step. On a campaign that has already started (RUNNING or PAUSED) the change is NOT retroactive: leads who already received this step keep the message they got; the new content only applies to actions still pending.",
      inputSchema: {
        campaignId: z
          .string()
          .describe("The campaign ID the template belongs to (24-character hex string)"),
        templateId: z
          .string()
          .describe("The template/message ID to edit (24-character hex string), the `id` returned by get_campaign_messages"),
        newHtml: z
          .string()
          .describe(
            "The new message body in LGM newHtml format. Rules: the body is a sequence of block tags (<p>…</p>, <ul><li>…</li></ul>, <h2>…</h2>); wrap all text in blocks; output the whole string on a SINGLE line with NO whitespace between top-level blocks (</p><p>, never </p> <p>). Personalization variables ONLY as <var name=\"firstname\"/> (optionally default=\"there\") — never {{…}}, {…}, %…% or […]. Inline tags: <b> <i> <u> <s>, <br/> (line break inside a paragraph), <a href=\"https://…\" track=\"true\">text</a>, <spin>Hi|Hello</spin> (text only), <signature/> (emails). Escape < as &lt; and & as &amp;. Example email: <p>Hi <var name=\"firstname\" default=\"there\"/>,</p><p/><p>Noticed your work at <var name=\"company\"/>. <a href=\"https://cal.com/me\" track=\"true\">Grab a slot</a>?</p><signature/>",
          ),
        subjectNewHtml: z
          .string()
          .optional()
          .describe(
            "EMAIL steps only: the email subject as a single <p>…</p> with text / <var/> / <spin> (no lists, images, headings or signature). Omit for LinkedIn / Twitter steps.",
          ),
      },
      annotations: {
        title: "Edit Campaign Message",
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
      try {
        const data = await callFlow(
          apiKey,
          `/campaigns/${params.campaignId}/messages/${params.templateId}`,
          {
            newHtml: params.newHtml,
            subjectNewHtml: params.subjectNewHtml,
          },
          { method: "POST" },
        );
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "edit_campaign_message",
        });
        return formatTextContent("Campaign Message Updated", data);
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // Tool 7d: get_campaign_steps
  registerWorkspaceAwareTool(
    server,
    "get_campaign_steps",
    {
      description:
        "List the message-bearing steps of a campaign sequence, in order. Each step returns its `stepId`, `type`, `channel`, `position`, and `hasMessage`/`templateId` telling whether a message is already attached. Use this to find a step's `stepId` and to spot empty steps (`hasMessage: false`) that need a message — then call add_campaign_step_message to fill them. Steps that already have a message are edited with edit_campaign_message (templateId = the step's `templateId`).",
      inputSchema: {
        campaignId: z
          .string()
          .describe("The campaign ID (24-character hex string)"),
      },
      annotations: {
        title: "Get Campaign Steps",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
      try {
        const data = await callFlow(
          apiKey,
          `/campaigns/${params.campaignId}/steps`,
        );
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "get_campaign_steps",
        });
        return formatTextContent("Campaign Steps", data);
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // Tool 7e: add_campaign_step_message
  registerWorkspaceAwareTool(
    server,
    "add_campaign_step_message",
    {
      description:
        "Create a new message and link it to an EMPTY campaign step (a step returned by get_campaign_steps with `hasMessage: false`). Provide the message as `newHtml` in LGM's newHtml format; for EMAIL steps also pass `subjectNewHtml`. The content is validated server-side and rejected if malformed. The step's channel is inferred from the step itself. If the step already has a message, this is rejected — use edit_campaign_message instead. Typical flow: get_campaign_steps → add_campaign_step_message for each empty step. On a campaign that has already started (RUNNING or PAUSED) this is NOT retroactive: leads who already passed this step are not sent the new message; it only applies to actions still pending.",
      inputSchema: {
        campaignId: z
          .string()
          .describe("The campaign ID the step belongs to (24-character hex string)"),
        stepId: z
          .string()
          .describe("The step ID to attach the message to, the `stepId` returned by get_campaign_steps"),
        newHtml: z
          .string()
          .describe(
            "The message body in LGM newHtml format. Rules: the body is a sequence of block tags (<p>…</p>, <ul><li>…</li></ul>, <h2>…</h2>); wrap all text in blocks; output the whole string on a SINGLE line with NO whitespace between top-level blocks (</p><p>, never </p> <p>). Personalization variables ONLY as <var name=\"firstname\"/> (optionally default=\"there\") — never {{…}}, {…}, %…% or […]. Inline tags: <b> <i> <u> <s>, <br/> (line break inside a paragraph), <a href=\"https://…\" track=\"true\">text</a>, <spin>Hi|Hello</spin> (text only), <signature/> (emails). Escape < as &lt; and & as &amp;. Example email: <p>Hi <var name=\"firstname\" default=\"there\"/>,</p><p/><p>Noticed your work at <var name=\"company\"/>. <a href=\"https://cal.com/me\" track=\"true\">Grab a slot</a>?</p><signature/>",
          ),
        subjectNewHtml: z
          .string()
          .optional()
          .describe(
            "EMAIL steps only: the email subject as a single <p>…</p> with text / <var/> / <spin> (no lists, images, headings or signature). Omit for LinkedIn / Twitter steps.",
          ),
      },
      annotations: {
        title: "Add Campaign Step Message",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
      try {
        const data = await callFlow(
          apiKey,
          `/campaigns/${params.campaignId}/steps/${params.stepId}/message`,
          {
            newHtml: params.newHtml,
            subjectNewHtml: params.subjectNewHtml,
          },
          { method: "POST" },
        );
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "add_campaign_step_message",
        });
        return formatTextContent("Campaign Step Message Added", data);
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // Tool 7f: rename_campaign
  registerWorkspaceAwareTool(
    server,
    "rename_campaign",
    {
      description:
        "Rename a campaign. Set a new display name (must be unique across your campaigns — rejected if another campaign already uses it). Get the campaignId from list_campaigns.",
      inputSchema: {
        campaignId: z
          .string()
          .describe("The campaign ID to rename (24-character hex string), from list_campaigns"),
        name: z.string().min(1).describe("The new campaign name"),
      },
      annotations: {
        title: "Rename Campaign",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
      try {
        const data = await callFlow(
          apiKey,
          `/campaigns/${params.campaignId}/settings`,
          { name: params.name },
          { method: "POST" },
        );
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "rename_campaign",
        });
        return formatTextContent("Campaign Renamed", data);
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // Tool 7g: set_campaign_audience
  registerWorkspaceAwareTool(
    server,
    "set_campaign_audience",
    {
      description:
        "Assign (or change) the audience of a campaign that has NOT been started yet (status READY). Rejected once the campaign is running. Get the campaignId from list_campaigns and the audienceId from list_audiences.",
      inputSchema: {
        campaignId: z
          .string()
          .describe("The campaign ID (24-character hex string), from list_campaigns"),
        audienceId: z
          .string()
          .describe("The audience ID to assign (24-character hex string), from list_audiences"),
      },
      annotations: {
        title: "Set Campaign Audience",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
      try {
        const data = await callFlow(
          apiKey,
          `/campaigns/${params.campaignId}/settings`,
          { audienceId: params.audienceId },
          { method: "POST" },
        );
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "set_campaign_audience",
        });
        return formatTextContent("Campaign Audience Updated", data);
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // Tool 7h: set_campaign_auto_enrich
  registerWorkspaceAwareTool(
    server,
    "set_campaign_auto_enrich",
    {
      description:
        "Enable or disable auto-enrichment on a campaign (automatically enrich its leads). Get the campaignId from list_campaigns.",
      inputSchema: {
        campaignId: z
          .string()
          .describe("The campaign ID (24-character hex string), from list_campaigns"),
        enrich: z.boolean().describe("true to enable auto-enrichment, false to disable it"),
      },
      annotations: {
        title: "Set Campaign Auto-Enrich",
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
      try {
        const data = await callFlow(
          apiKey,
          `/campaigns/${params.campaignId}/settings`,
          { enrich: params.enrich },
          { method: "POST" },
        );
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "set_campaign_auto_enrich",
        });
        return formatTextContent("Campaign Auto-Enrich Updated", data);
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // Tool 7i: set_campaign_out_of_office
  registerWorkspaceAwareTool(
    server,
    "set_campaign_out_of_office",
    {
      description:
        "Enable or disable out-of-office auto-rescheduling on a campaign (reschedule actions when a lead is detected out of office). Get the campaignId from list_campaigns.",
      inputSchema: {
        campaignId: z
          .string()
          .describe("The campaign ID (24-character hex string), from list_campaigns"),
        enabled: z.boolean().describe("true to enable out-of-office rescheduling, false to disable it"),
      },
      annotations: {
        title: "Set Campaign Out-Of-Office",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
      try {
        const data = await callFlow(
          apiKey,
          `/campaigns/${params.campaignId}/settings`,
          { autoRescheduleOutOfOffice: params.enabled },
          { method: "POST" },
        );
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "set_campaign_out_of_office",
        });
        return formatTextContent("Campaign Out-Of-Office Updated", data);
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // Tool 7j: set_campaign_crm_sync
  registerWorkspaceAwareTool(
    server,
    "set_campaign_crm_sync",
    {
      description:
        "Enable or disable CRM sync on a campaign for HubSpot and/or Pipedrive. Provide at least one of hubspot / pipedrive. Requires the matching CRM plan permission, and the campaign must be paused (not running) to change it. Get the campaignId from list_campaigns.",
      inputSchema: {
        campaignId: z
          .string()
          .describe("The campaign ID (24-character hex string), from list_campaigns"),
        hubspot: z.boolean().optional().describe("true to enable HubSpot sync, false to disable it"),
        pipedrive: z.boolean().optional().describe("true to enable Pipedrive sync, false to disable it"),
      },
      annotations: {
        title: "Set Campaign CRM Sync",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
      try {
        if (params.hubspot === undefined && params.pipedrive === undefined) {
          throw new Error("Provide at least one of: hubspot, pipedrive.");
        }
        const data = await callFlow(
          apiKey,
          `/campaigns/${params.campaignId}/settings`,
          { hubspot: params.hubspot, pipedrive: params.pipedrive },
          { method: "POST" },
        );
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "set_campaign_crm_sync",
        });
        return formatTextContent("Campaign CRM Sync Updated", data);
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // Tool 7k: set_campaign_skip_rules
  registerWorkspaceAwareTool(
    server,
    "set_campaign_skip_rules",
    {
      description:
        "Enable or disable the 'skip already contacted' rule on a campaign (skip leads you have already reached out to). The campaign must be READY or PAUSED to change it. Get the campaignId from list_campaigns.",
      inputSchema: {
        campaignId: z
          .string()
          .describe("The campaign ID (24-character hex string), from list_campaigns"),
        skipAlreadyContacted: z
          .boolean()
          .describe("true to skip already-contacted leads, false to disable the rule"),
      },
      annotations: {
        title: "Set Campaign Skip Rules",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
      try {
        const data = await callFlow(
          apiKey,
          `/campaigns/${params.campaignId}/settings`,
          { skipAlreadyContacted: params.skipAlreadyContacted },
          { method: "POST" },
        );
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "set_campaign_skip_rules",
        });
        return formatTextContent("Campaign Skip Rules Updated", data);
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // Tool 7l: pause_campaign
  registerWorkspaceAwareTool(
    server,
    "pause_campaign",
    {
      description:
        "Pause a RUNNING campaign: every pending action of its leads is put on hold until the campaign is resumed (same effect as the Pause button in the LGM app). Only a RUNNING campaign can be paused — otherwise the API returns an error stating the current status and nothing is changed. Get the campaignId from list_campaigns. If the call times out, the pause has almost certainly been applied anyway (syncing paused leads to the CRM can take a while): check the campaign status with list_campaigns instead of calling this tool again. Editing a paused campaign (messages via edit_campaign_message / add_campaign_step_message, settings via the set_campaign_* tools) is NOT retroactive: actions already executed are never replayed — leads who already received a step keep the version they got — and the changes only apply to the actions still pending, once the campaign is resumed.",
      inputSchema: {
        campaignId: z
          .string()
          .describe("The campaign ID (24-character hex string), from list_campaigns"),
      },
      annotations: {
        title: "Pause Campaign",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
      try {
        const data = await callFlow(
          apiKey,
          `/campaigns/${params.campaignId}/status`,
          { status: "PAUSED" },
          // La pause synchronise les leads en cours vers le CRM dans la requête : jusqu'à ~1 min sur les
          // grosses campagnes. 120s au lieu du défaut 10s ; un timeout est marqué "may have completed" (cf. callFlow).
          { method: "POST", timeout: 120_000 },
        );
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "pause_campaign",
        });
        return formatTextContent("Campaign Paused", data);
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // Tool 7m: resume_campaign
  registerWorkspaceAwareTool(
    server,
    "resume_campaign",
    {
      description:
        "Resume a PAUSED campaign: its leads pick up their sequence where they stopped (same effect as the Resume button in the LGM app). Only a PAUSED campaign can be resumed — a READY campaign that has never been launched must be launched from the LGM app, not with this tool; any other status returns an error stating the current status and nothing is changed. Resuming is subject to the plan limits (max running campaigns, CRM / custom campaign permissions): the API returns an explicit error if they are exceeded. Edits made while the campaign was paused are not retroactive: they only apply to the actions still pending — nothing is replayed for leads who already went through a step. Get the campaignId from list_campaigns.",
      inputSchema: {
        campaignId: z
          .string()
          .describe("The campaign ID (24-character hex string), from list_campaigns"),
      },
      annotations: {
        title: "Resume Campaign",
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
      try {
        const data = await callFlow(
          apiKey,
          `/campaigns/${params.campaignId}/status`,
          { status: "RUNNING" },
          { method: "POST", timeout: 120_000 },
        );
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "resume_campaign",
        });
        return formatTextContent("Campaign Resumed", data);
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // Tool 8: get_audience
  registerWorkspaceAwareTool(
    server,
    "get_audience",
    {
      description:
        "Get detailed information about a specific audience. Returns name, description, size, type, and import status. Use audience IDs from list_campaigns results.",
      inputSchema: {
        audienceId: z
          .string()
          .describe("The audience ID (24-character hex string)"),
      },
      annotations: {
        title: "Get Audience Details",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
      try {
        const data = await callFlow(
          apiKey,
          `/audiences/${params.audienceId}/detail`,
        );
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "get_audience",
        });
        return formatTextContent("Audience Detail", data);
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // Tool 9: save_identity_preference
  registerWorkspaceAwareTool(
    server,
    "save_identity_preference",
    {
      description:
        'Save a preference for a specific identity. Preferences are key-value pairs organized by category (e.g., "tone", "language", "signature"). Used to personalize AI-generated content for this identity. Max 50 preferences per identity, 500 chars per value.',
      inputSchema: {
        identityId: z
          .string()
          .describe("The identity ID (24-character hex string)"),
        category: z
          .string()
          .describe('Preference category (e.g., "tone", "language", "style")'),
        key: z.string().describe("Preference key within the category"),
        value: z.string().describe("Preference value (max 500 characters)"),
        channel: z
          .string()
          .optional()
          .describe('Optional channel scope (e.g., "linkedin", "email")'),
      },
      annotations: {
        title: "Save Identity Preference",
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
      try {
        const data = await callFlow(
          apiKey,
          `/identities/${params.identityId}/preferences`,
          {
            category: params.category,
            key: params.key,
            value: params.value,
            channel: params.channel,
          },
          { method: "POST" },
        );
        await trackMcpEvent(apiKey, "mcp_preference_saved", {
          toolName: "save_identity_preference",
        });
        return formatTextContent("Preference Saved", data);
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // Tool 10: create_audience_from_linkedin_url
  registerWorkspaceAwareTool(
    server,
    "create_audience_from_linkedin_url",
    {
      description:
        "Create a new audience (or populate an existing one) by importing leads from a LinkedIn Regular search URL, a Sales Navigator search URL, a LinkedIn post URL, or a LinkedIn event URL (imports the event's attendees). The `audience` parameter is a NAME, not an ID — if no audience with that name exists, LGM creates one; if it does, leads are added to it. Requires an `identityId` from list_identities; the underlying LinkedIn account must be connected to LGM during the import. IMPORTANT — LinkedIn event URLs: the identity used MUST itself be registered to that event on LinkedIn, otherwise the import returns 0 attendees. Warn the user of this prerequisite before calling with an event URL. Import runs asynchronously — poll get_audience to check status.",
      inputSchema: {
        audience: z
          .string()
          .min(1)
          .max(100)
          .describe(
            "Name (not ID) of the audience to populate. Creates it if it doesn't exist.",
          ),
        linkedinUrl: z
          .string()
          .url()
          .regex(
            /^https:\/\/(www\.)?linkedin\.com\//,
            "A valid LinkedIn URL is required (must start with https://www.linkedin.com/)",
          )
          .describe(
            "LinkedIn Regular search URL, Sales Navigator search URL, LinkedIn post URL, or LinkedIn event URL (e.g. https://www.linkedin.com/events/…). For an event URL, the identity used must be registered to the event on LinkedIn or the import returns 0 leads.",
          ),
        identityId: z
          .string()
          .describe(
            "Identity to impersonate for the scrape (24-character hex ObjectId). Use list_identities to find it.",
          ),
        linkedinPostCategory: z
          .enum(["like", "comment"])
          .optional()
          .describe(
            "When linkedinUrl is a LinkedIn post, scrape leads by engagement type: 'like' or 'comment'",
          ),
        excludeContactedLeads: z
          .boolean()
          .optional()
          .describe("Exclude leads who have already been contacted"),
        autoImport: z
          .boolean()
          .optional()
          .describe("Auto-import new matching leads going forward"),
      },
      annotations: {
        title: "Create Audience from LinkedIn URL",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
      const isEventUrl = /\/events\//i.test(params.linkedinUrl);
      try {
        const data = await callFlow(
          apiKey,
          "/audiences",
          {
            audience: params.audience,
            linkedinUrl: params.linkedinUrl,
            identityId: params.identityId,
            linkedinPostCategory: params.linkedinPostCategory,
            excludeContactedLeads: params.excludeContactedLeads,
            autoImport: params.autoImport,
          },
          { method: "POST" },
        );
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "create_audience_from_linkedin_url",
        });
        // For LinkedIn event URLs, surface the "identity must be
        // registered to the event" prerequisite in the response — the
        // API will silently return 0 attendees if it isn't, and that
        // failure mode is easy to miss otherwise.
        const payload =
          isEventUrl && typeof data === "object" && data !== null
            ? {
                ...(data as Record<string, unknown>),
                eventUrlPrerequisite:
                  "This is a LinkedIn event URL. The identity used MUST be registered to the event on LinkedIn — otherwise the import completes with 0 attendees. If the count comes back as 0, ask the user to register the identity to the event, then re-run.",
              }
            : data;
        return formatTextContent("Audience Created", payload);
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // Tool 10b: list_audiences
  registerWorkspaceAwareTool(
    server,
    "list_audiences",
    {
      description:
        "List every audience of the authenticated user's workspace. Returns each audience with `id`, `name`, and `leadsCount` (plus other metadata). Reach for this whenever the user asks for their audiences (\"mes audiences\", \"which audiences do I have?\", \"combien de leads dans mon audience X ?\") — it's also the natural follow-up to `create_audience_from_linkedin_url` (which does NOT return the new audience's id) so downstream tools that need an `audienceId` (get_audience, get_audience_leads) can resolve it by name.",
      inputSchema: {},
      annotations: {
        title: "List Audiences",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (_params, extra) => {
      const apiKey = resolveApiKey(extra);
      try {
        const data = await callFlow(apiKey, "/audiences");
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "list_audiences",
        });
        return formatTextContent("Audiences", data);
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // Tool 11: list_identities
  registerWorkspaceAwareTool(
    server,
    "list_identities",
    {
      description:
        "List all connected identities (LinkedIn / email accounts) for the authenticated user. Use the returned identity IDs to call tools that require an `identityId`, like create_audience_from_linkedin_url.",
      inputSchema: {},
      annotations: {
        title: "List Identities",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (_params, extra) => {
      const apiKey = resolveApiKey(extra);
      try {
        const data = await callFlow(apiKey, "/identities");
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "list_identities",
        });
        return formatTextContent("Identities", data);
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // Tool: list_workspaces (registered directly — the discovery tool itself never targets a workspace)
  server.registerTool(
    "list_workspaces",
    {
      description:
        "List the workspaces the authenticated human can act in (Model 2). Returns `multiWorkspace` and a " +
        "`workspaces` array (each with workspaceId, name, slug, plan, identitiesCount, isCurrent). " +
        "If `multiWorkspace` is false the human has a SINGLE workspace: never pass `workspaceId` to any " +
        "tool. Only when `multiWorkspace` is true may you set `workspaceId` (the chosen workspaceId) on " +
        "other tools to act inside that workspace. `isCurrent` marks the workspace acted in by default.",
      inputSchema: {},
      annotations: {
        title: "List Workspaces",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: TOOL_META,
    },
    async (_params, extra) => {
      const apiKey = resolveApiKey(extra);
      try {
        const data = await callFlow(apiKey, "/workspaces");
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "list_workspaces",
        });
        return formatTextContent("Workspaces", data);
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // Tool: create_lead
  registerWorkspaceAwareTool(
    server,
    "create_lead",
    {
      description:
        "Create a lead — or update it in place when it already exists (upsert on the identifier fields). Use whenever the user says \"add this contact\", \"push a lead\", \"create a lead for John Doe at Acme\", or \"update the job title of this lead\". At least ONE identifier is required: `leadId` (updates the existing lead), OR `proEmail` / `persoEmail` / `linkedinUrl` / `twitter` (match then upsert), OR `firstname` + `lastname` plus `companyName` OR `companyUrl` (matches on name+company). Attach the lead to an audience with the optional `audience` param (a NAME, not an id — use list_audiences from the audience tools if you need one). All other profile fields are optional; the ten `customAttribute1`…`customAttribute10` slots accept up to 1000 chars each and are handy for storing personalization notes or AI-generated blurbs on the lead. Use `note` for the free-text note displayed on the lead profile — the one the team reads in the app; passing it replaces the existing note. Set `excludeContactedLeads: true` to skip leads that were already contacted (no-op instead of update).",
      inputSchema: {
        audience: z
          .string()
          .max(100)
          .optional()
          .describe(
            "Optional audience NAME to attach the lead to. Omit to create the lead with no audience.",
          ),
        // Identifiers — at least one is required (validated in handler).
        leadId: z
          .string()
          .optional()
          .describe(
            "Existing lead id (24-char hex ObjectId) — when provided, this is an update on that exact lead.",
          ),
        proEmail: z.string().optional().describe("Professional email"),
        persoEmail: z.string().optional().describe("Personal email"),
        linkedinUrl: z.string().optional().describe("LinkedIn profile URL"),
        twitter: z.string().optional().describe("Twitter / X handle or URL"),
        firstname: z.string().max(255).optional().describe("First name"),
        lastname: z.string().max(255).optional().describe("Last name"),
        companyName: z
          .string()
          .max(255)
          .optional()
          .describe(
            "Company name (also helps disambiguate firstname+lastname matches)",
          ),
        companyUrl: z
          .string()
          .max(255)
          .optional()
          .describe(
            "Company URL (also helps disambiguate firstname+lastname matches)",
          ),
        // Profile fields.
        gender: z.enum(["man", "woman"]).optional().describe("Lead gender"),
        bio: z.string().max(255).optional().describe("Short bio / about text"),
        note: z
          .string()
          .max(1500)
          .optional()
          .describe(
            "Free-text note shown on the lead profile (replaces the existing note).",
          ),
        jobTitle: z.string().max(255).optional().describe("Job title"),
        profilePicture: z
          .string()
          .max(255)
          .optional()
          .describe("URL of the lead's profile picture"),
        industry: z.string().max(255).optional().describe("Industry"),
        phone: z.string().max(255).optional().describe("Phone number"),
        crm_id: z
          .string()
          .max(255)
          .optional()
          .describe("External CRM id for the lead"),
        location: z.string().max(255).optional().describe("Location / city"),
        relationsCount: z
          .number()
          .optional()
          .describe("Number of LinkedIn connections / followers"),
        // Custom attributes — 10 free-form long-text slots (max 1000 chars each).
        customAttribute1: z.string().max(1000).optional(),
        customAttribute2: z.string().max(1000).optional(),
        customAttribute3: z.string().max(1000).optional(),
        customAttribute4: z.string().max(1000).optional(),
        customAttribute5: z.string().max(1000).optional(),
        customAttribute6: z.string().max(1000).optional(),
        customAttribute7: z.string().max(1000).optional(),
        customAttribute8: z.string().max(1000).optional(),
        customAttribute9: z.string().max(1000).optional(),
        customAttribute10: z.string().max(1000).optional(),
        // Options.
        excludeContactedLeads: z
          .boolean()
          .optional()
          .describe(
            "When true, skip leads that have already been contacted (no update). Default: false.",
          ),
      },
      annotations: {
        title: "Create or Update Lead",
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
      // "At least one identifier" invariant from the endpoint doc. Enforced
      // here (not in Zod) because registerTool takes a raw shape, no
      // top-level refine — a clean isError beats a generic API 400.
      const hasNameAndCompany = Boolean(
        params.firstname &&
          params.lastname &&
          (params.companyName || params.companyUrl),
      );
      const hasIdentifier =
        Boolean(
          params.leadId ||
            params.proEmail ||
            params.persoEmail ||
            params.linkedinUrl ||
            params.twitter,
        ) || hasNameAndCompany;
      if (!hasIdentifier) {
        return {
          content: [
            {
              type: "text" as const,
              text: "create_lead requires at least one identifier: leadId, proEmail, persoEmail, linkedinUrl, twitter, OR firstname+lastname together with companyName or companyUrl.",
            },
          ],
          isError: true as const,
        };
      }
      // Strip undefined so the request body stays clean. workspaceId is the
      // wrapper's param — it travels as the X-LGM-Workspace header via the
      // request context, never in the body.
      const body: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(params)) {
        if (k !== "workspaceId" && v !== undefined) body[k] = v;
      }
      try {
        const data = await callFlow(apiKey, "/leads", body, {
          method: "POST",
        });
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "create_lead",
        });
        return formatTextContent("Lead Upserted", data);
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // === Enrichment & credits ===

  // Cost table for the enrich endpoint. Source: LGM API docs (Postman
  // description). Hardcoded so the confirm-gate can show an estimated
  // cost BEFORE the spend; if LGM changes pricing this constant needs
  // to move in lockstep.
  const ENRICH_COSTS = {
    EMAIL_ENRICH: 5,
    LINKEDIN_ENRICH: 1,
    FULL_ENRICH: 5,
  } as const;
  type EnrichType = keyof typeof ENRICH_COSTS;

  // Tool 11e: get_credits
  registerWorkspaceAwareTool(
    server,
    "get_credits",
    {
      description:
        "Return the credit balance for the authenticated account. Returns `total` (all available credits) and `perishable` (credits that expire soon, already counted in `total`). Reach for this whenever the user asks about their balance (\"combien de crédits ?\", \"how many credits do I have?\") or before running a credit-spending action (enrich_lead) to check they have enough.",
      inputSchema: {},
      annotations: {
        title: "Get Credits",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (_params, extra) => {
      const apiKey = resolveApiKey(extra);
      try {
        const data = await callFlow(apiKey, "/credits");
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "get_credits",
        });
        return formatTextContent("Credits Balance", data);
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // Tool 11f: enrich_lead
  registerWorkspaceAwareTool(
    server,
    "enrich_lead",
    {
      description:
        "Enrich a single lead — finds their pro email and/or fills in LinkedIn profile fields on the LGM lead. Spends credits: EMAIL_ENRICH (up to 5 credits, finds pro email + validation status, works from firstname+lastname+company without a leadId) | LINKEDIN_ENRICH (up to 1 credit, refreshes LinkedIn profile fields on the lead, REQUIRES leadId) | FULL_ENRICH (up to 5 credits, both, REQUIRES leadId). Runs in polling mode: returns an `enrichRequestId` — resolve later with get_enrich_result once status=completed. CONFIRMATION LOCKSTEP: first call with `confirm=false` (or omit) to see the estimated cost vs the current balance. Then present the cost to the user and get their explicit approval. THEN re-call with `confirm=true` AND `acknowledgedCostCredits` set to the exact estimated value. The tool REFUSES to spend without both, and refuses if the acknowledged value does not match the calculated one — this makes accidental spend impossible.",
      inputSchema: {
        leadId: z
          .string()
          .optional()
          .describe(
            "Existing lead id (24-char hex ObjectId). REQUIRED for LINKEDIN_ENRICH and FULL_ENRICH. Get one via list_audiences → get_audience_leads, or from a search/inbox tool.",
          ),
        firstname: z
          .string()
          .optional()
          .describe(
            "Lead first name — used when no leadId is available (EMAIL_ENRICH only).",
          ),
        lastname: z
          .string()
          .optional()
          .describe(
            "Lead last name — used when no leadId is available (EMAIL_ENRICH only).",
          ),
        companyName: z
          .string()
          .optional()
          .describe("Company name to improve email matching (with firstname+lastname)."),
        companyUrl: z
          .string()
          .optional()
          .describe("Company URL to improve email matching (with firstname+lastname)."),
        linkedinUrl: z
          .string()
          .max(500)
          .optional()
          .describe("Lead LinkedIn profile URL to improve matching."),
        enrichType: z
          .enum(["EMAIL_ENRICH", "LINKEDIN_ENRICH", "FULL_ENRICH"])
          .optional()
          .default("EMAIL_ENRICH")
          .describe(
            "Drives what is enriched and cost. EMAIL_ENRICH (5 cr, no leadId needed) | LINKEDIN_ENRICH (1 cr, needs leadId) | FULL_ENRICH (5 cr, needs leadId).",
          ),
        confirm: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Set to true to actually spend credits. When false (default) returns a preview only. Requires acknowledgedCostCredits when true.",
          ),
        acknowledgedCostCredits: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "REQUIRED when confirm=true. Must exactly match `estimatedCostCredits` from the dry-run preview. Lockstep guard to prove the cost was surfaced to the user before spending — the tool rejects confirm=true without it, and rejects mismatched values.",
          ),
      },
      annotations: {
        title: "Enrich Lead",
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
      const enrichType = (params.enrichType ?? "EMAIL_ENRICH") as EnrichType;
      const cost = ENRICH_COSTS[enrichType];
      const hasLeadId = Boolean(params.leadId);
      const hasNameMatch = Boolean(params.firstname && params.lastname);

      // Cross-field validation from the endpoint doc.
      if (!hasLeadId && !hasNameMatch) {
        return {
          content: [
            {
              type: "text" as const,
              text: "enrich_lead requires either a leadId or firstname+lastname (plus companyName/companyUrl/linkedinUrl to improve matching).",
            },
          ],
          isError: true as const,
        };
      }
      if (
        (enrichType === "LINKEDIN_ENRICH" || enrichType === "FULL_ENRICH") &&
        !hasLeadId
      ) {
        return {
          content: [
            {
              type: "text" as const,
              text: `${enrichType} requires a leadId — the endpoint returns 400 without it. Look up the lead first (e.g. via get_audience_leads) then re-call with its id.`,
            },
          ],
          isError: true as const,
        };
      }

      // Preview path (confirm=false). Fetch credits so the model can
      // show the user "cost X vs balance Y" verdict. Best-effort — if
      // /credits fails we still render the preview without balance.
      if (!params.confirm) {
        let balance: { total?: number; perishable?: number } | null = null;
        try {
          const raw = (await callFlow(apiKey, "/credits")) as Record<
            string,
            unknown
          >;
          const src =
            raw && typeof raw.credits === "object" && raw.credits !== null
              ? (raw.credits as Record<string, unknown>)
              : raw;
          balance = {
            total: typeof src?.total === "number" ? src.total : undefined,
            perishable:
              typeof src?.perishable === "number" ? src.perishable : undefined,
          };
        } catch {
          balance = null;
        }
        const target = hasLeadId
          ? `leadId=${params.leadId}`
          : `${params.firstname} ${params.lastname}${params.companyName ? ` @ ${params.companyName}` : ""}`;
        const sufficient =
          balance?.total !== undefined ? balance.total >= cost : null;
        const verdict =
          sufficient === null
            ? "Balance unknown — proceed with caution."
            : sufficient
              ? "✅ Sufficient."
              : `❌ INSUFFICIENT (need ${cost}, have ${balance!.total}).`;
        return formatTextContent("Enrich Preview — confirmation required", {
          enrichType,
          estimatedCostCredits: cost,
          costNote:
            "Cost is an upper bound. LGM typically doesn't charge when enrichment finds no data (status not_found).",
          target,
          balance,
          verdict,
          nextStep: `Surface the cost to the user, get explicit approval, then re-call enrich_lead with confirm=true AND acknowledgedCostCredits=${cost}.`,
        });
      }

      // Confirm path — lockstep guard.
      if (params.acknowledgedCostCredits === undefined) {
        return {
          content: [
            {
              type: "text" as const,
              text: `enrich_lead refused to spend: confirm=true requires acknowledgedCostCredits matching the dry-run estimate (${cost} for ${enrichType}). Run with confirm=false first, surface the cost, then re-call with confirm=true AND acknowledgedCostCredits=${cost}.`,
            },
          ],
          isError: true as const,
        };
      }
      if (params.acknowledgedCostCredits !== cost) {
        return {
          content: [
            {
              type: "text" as const,
              text: `enrich_lead refused to spend: acknowledgedCostCredits (${params.acknowledgedCostCredits}) does not match the actual cost (${cost} for ${enrichType}). Re-run confirm=false to see the current preview.`,
            },
          ],
          isError: true as const,
        };
      }

      // Execute — polling mode hardcoded. Sync would routinely time out
      // (callFlow's 10s timeout), and webhook has no receiver in an MCP
      // context.
      const body: Record<string, unknown> = {
        enrichType,
        mode: "polling",
      };
      if (params.leadId) body.leadId = params.leadId;
      if (params.firstname) body.firstname = params.firstname;
      if (params.lastname) body.lastname = params.lastname;
      if (params.companyName) body.companyName = params.companyName;
      if (params.companyUrl) body.companyUrl = params.companyUrl;
      if (params.linkedinUrl) body.linkedinUrl = params.linkedinUrl;

      try {
        const data = await callFlow(apiKey, "/leads/enrich", body, {
          method: "POST",
        });
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "enrich_lead",
        });
        return formatTextContent(
          `Enrich Started (${enrichType}, ~${cost} credits)`,
          {
            response: data,
            nextStep:
              "Poll get_enrich_result with the returned enrichRequestId to retrieve the enriched data once status=completed.",
          },
        );
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // Tool 11g: get_enrich_result
  registerWorkspaceAwareTool(
    server,
    "get_enrich_result",
    {
      description:
        "Retrieve the result of an enrichment request previously started by enrich_lead (polling mode). Returns `status` (pending / enriched / completed / failed / not_found) and, when finished, the enriched data — pro email, perso email, phone, refreshed LinkedIn fields, email validity status. Polling tip: enrichments usually complete in seconds to a minute — wait a beat before polling and avoid tight loops (LGM's rate limit is 50 calls / 10 s).",
      inputSchema: {
        enrichRequestId: z
          .string()
          .describe(
            "The enrichRequestId returned by enrich_lead when it was called with confirm=true.",
          ),
      },
      annotations: {
        title: "Get Enrich Result",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
      try {
        const data = await callFlow(
          apiKey,
          `/leads/enrich/${params.enrichRequestId}`,
        );
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "get_enrich_result",
        });
        return formatTextContent("Enrich Result", data);
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // === Conversations / inbox (all back GET /conversations/search) ===

  // Tool 12: get_conversations_to_reply (specialized)
  registerWorkspaceAwareTool(
    server,
    "get_conversations_to_reply",
    {
      description:
        "List inbox conversations waiting for the user's reply — the lead spoke last and the thread is still open. This is the SDR's daily \"who do I need to answer?\" queue (e.g. \"show me the conversations I need to reply to\", \"what's waiting on me?\"). Returns newest-first conversations with id, leadId, identityId, channel (lastMessageType) and status — but NOT the lead's name or message text. To show the actual exchange, follow up with get_conversation_messages (by conversationId); to resolve who the lead is, use a lead-search tool (by leadId). Optionally narrow to specific identities or to conversations active since a given time.",
      inputSchema: {
        identityIds: z
          .array(z.string())
          .optional()
          .describe(
            "Restrict to these identity IDs (from list_identities). 24-char hex ObjectIds.",
          ),
        since: z
          .number()
          .optional()
          .describe(
            "Only conversations whose last message is at/after this Unix timestamp in milliseconds.",
          ),
        limit: z
          .number()
          .optional()
          .default(25)
          .describe("Maximum number of conversations to return"),
        searchAfter: z
          .string()
          .optional()
          .describe(
            "Pagination cursor: pass the id of the last conversation from the previous page.",
          ),
      },
      annotations: {
        title: "Get Conversations To Reply",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
      try {
        const data = await callFlow(apiKey, "/conversations/search", {
          status: "OPEN",
          leadReplied: true,
          unsubscribed: false,
          identityIds: csv(params.identityIds),
          lastMessageAtFrom: params.since,
          limit: params.limit,
          searchAfter: params.searchAfter,
          sortField: "lastMessageAt",
          sortDirection: -1,
        });
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "get_conversations_to_reply",
        });
        return formatTextContent("Conversations To Reply", data);
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // Tool 13: get_unread_conversations (specialized)
  registerWorkspaceAwareTool(
    server,
    "get_unread_conversations",
    {
      description:
        'List unread inbox conversations (read = false), newest first. Answers "what unread conversations do I have?" and inbox-zero triage. Note: unread is distinct from awaiting-reply — for the latter use get_conversations_to_reply. Returns ids and metadata only (id, leadId, identityId, channel, status), no names or message bodies; hydrate with get_conversation_messages and a lead-search tool.',
      inputSchema: {
        identityIds: z
          .array(z.string())
          .optional()
          .describe(
            "Restrict to these identity IDs (from list_identities). 24-char hex ObjectIds.",
          ),
        since: z
          .number()
          .optional()
          .describe(
            "Only conversations whose last message is at/after this Unix timestamp in milliseconds.",
          ),
        limit: z
          .number()
          .optional()
          .default(25)
          .describe("Maximum number of conversations to return"),
        searchAfter: z
          .string()
          .optional()
          .describe(
            "Pagination cursor: pass the id of the last conversation from the previous page.",
          ),
      },
      annotations: {
        title: "Get Unread Conversations",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
      try {
        const data = await callFlow(apiKey, "/conversations/search", {
          read: false,
          identityIds: csv(params.identityIds),
          lastMessageAtFrom: params.since,
          limit: params.limit,
          searchAfter: params.searchAfter,
          sortField: "lastMessageAt",
          sortDirection: -1,
        });
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "get_unread_conversations",
        });
        return formatTextContent("Unread Conversations", data);
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // Tool 14: get_favourite_conversations (specialized)
  registerWorkspaceAwareTool(
    server,
    "get_favourite_conversations",
    {
      description:
        'List conversations the user has favourited / starred — their priority accounts (e.g. "show my starred conversations", "favourites that replied"). Optionally restrict to conversations where the lead has replied. Returns ids and metadata only (no lead names or message text); hydrate with get_conversation_messages and a lead-search tool.',
      inputSchema: {
        leadReplied: z
          .boolean()
          .optional()
          .describe("Only conversations where the lead has replied"),
        identityIds: z
          .array(z.string())
          .optional()
          .describe(
            "Restrict to these identity IDs (from list_identities). 24-char hex ObjectIds.",
          ),
        limit: z
          .number()
          .optional()
          .default(25)
          .describe("Maximum number of conversations to return"),
        searchAfter: z
          .string()
          .optional()
          .describe(
            "Pagination cursor: pass the id of the last conversation from the previous page.",
          ),
      },
      annotations: {
        title: "Get Favourite Conversations",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
      try {
        const data = await callFlow(apiKey, "/conversations/search", {
          favourite: true,
          leadReplied: params.leadReplied,
          identityIds: csv(params.identityIds),
          limit: params.limit,
          searchAfter: params.searchAfter,
          sortField: "lastMessageAt",
          sortDirection: -1,
        });
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "get_favourite_conversations",
        });
        return formatTextContent("Favourite Conversations", data);
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // Tool 15: search_conversations (generalist)
  registerWorkspaceAwareTool(
    server,
    "search_conversations",
    {
      description:
        "Search and filter the whole conversation inbox across every lead, identity, campaign and audience — the flexible, full-power inbox query. Use it for filter combinations the specialized tools don't cover: free-text (q), by campaign/audience/lead, by channel or message direction, by date windows, or any mix of flags. For common cases PREFER the specialized tools: conversations awaiting your reply → get_conversations_to_reply; unread → get_unread_conversations; favourites → get_favourite_conversations. Returns conversation ids and metadata only (no lead names or message text) — hydrate with get_conversation_messages (the thread) and a lead-search tool (who the lead is). Paginate with limit + searchAfter (pass the last result's id as the cursor).",
      inputSchema: {
        q: z
          .string()
          .optional()
          .describe("Full-text search (e.g. lead or company name)"),
        identityIds: z
          .array(z.string())
          .optional()
          .describe("Filter by identity IDs (from list_identities)"),
        leadIds: z
          .array(z.string())
          .optional()
          .describe("Filter by lead IDs"),
        audienceIds: z
          .array(z.string())
          .optional()
          .describe("Filter by audience IDs"),
        campaignIds: z
          .array(z.string())
          .optional()
          .describe("Filter by campaign IDs (from list_campaigns)"),
        status: z
          .array(z.string())
          .optional()
          .describe(
            "Filter by conversation status. Known values: OPEN, SNOOZED, ARCHIVED.",
          ),
        lastMessageStatus: z
          .array(z.enum(["RECEIVED", "SENT"]))
          .optional()
          .describe(
            "Filter by direction of the last message: RECEIVED (lead spoke last) or SENT (user spoke last).",
          ),
        lastMessageType: z
          .array(z.enum(["EMAIL", "LINKEDIN"]))
          .optional()
          .describe("Filter by channel of the last message: EMAIL or LINKEDIN"),
        lastMessageAtFrom: z
          .number()
          .optional()
          .describe("Last message at/after this Unix timestamp (ms)"),
        lastMessageAtTo: z
          .number()
          .optional()
          .describe("Last message at/before this Unix timestamp (ms)"),
        callCompletedAtFrom: z
          .number()
          .optional()
          .describe("Call completed at/after this Unix timestamp (ms)"),
        callCompletedAtTo: z
          .number()
          .optional()
          .describe("Call completed at/before this Unix timestamp (ms)"),
        leadReplied: z
          .boolean()
          .optional()
          .describe("Only conversations where the lead has replied"),
        unsubscribed: z
          .boolean()
          .optional()
          .describe("Filter by unsubscribed leads"),
        favourite: z
          .boolean()
          .optional()
          .describe("Only favourited / starred conversations"),
        read: z
          .boolean()
          .optional()
          .describe("Filter by read state (false = unread)"),
        limit: z
          .number()
          .optional()
          .default(25)
          .describe("Maximum number of conversations to return"),
        searchAfter: z
          .string()
          .optional()
          .describe(
            "Pagination cursor: pass the id of the last conversation from the previous page.",
          ),
        sortField: z
          .string()
          .optional()
          .describe('Field to sort by (e.g. "lastMessageAt")'),
        sortDirection: z
          .number()
          .optional()
          .describe(
            "Sort direction: -1 for descending (newest first), 1 for ascending.",
          ),
      },
      annotations: {
        title: "Search Conversations",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
      try {
        const data = await callFlow(apiKey, "/conversations/search", {
          q: params.q,
          identityIds: csv(params.identityIds),
          leadIds: csv(params.leadIds),
          audienceIds: csv(params.audienceIds),
          campaignIds: csv(params.campaignIds),
          status: csv(params.status),
          lastMessageStatus: csv(params.lastMessageStatus),
          lastMessageType: csv(params.lastMessageType),
          lastMessageAtFrom: params.lastMessageAtFrom,
          lastMessageAtTo: params.lastMessageAtTo,
          callCompletedAtFrom: params.callCompletedAtFrom,
          callCompletedAtTo: params.callCompletedAtTo,
          leadReplied: params.leadReplied,
          unsubscribed: params.unsubscribed,
          favourite: params.favourite,
          read: params.read,
          limit: params.limit,
          searchAfter: params.searchAfter,
          sortField: params.sortField,
          sortDirection: params.sortDirection,
        });
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "search_conversations",
        });
        return formatTextContent("Conversations Search", data);
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // === Inbox conversation actions (write) ===

  // Tool 16: snooze_conversation
  registerWorkspaceAwareTool(
    server,
    "snooze_conversation",
    {
      description:
        'Snooze a conversation until later — hides it from the active inbox until snoozeUntil, so the user can defer a thread they\'ll handle another day (e.g. "snooze this conversation until Monday 9am", "remind me about this lead next week"). Identify the conversation by conversationId, or by the lead\'s linkedinUrl or email. Reversible with unsnooze_conversation.',
      inputSchema: {
        ...conversationTargetSchema,
        snoozeUntil: z
          .string()
          .optional()
          .describe(
            'ISO 8601 datetime until which to snooze (e.g. "2026-06-12T09:00:00Z"). Omit to snooze without a set wake time.',
          ),
      },
      annotations: {
        title: "Snooze Conversation",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
      try {
        const data = await callFlow(
          apiKey,
          "/inbox/conversations/snooze",
          { ...requireConversationTarget(params), snoozeUntil: params.snoozeUntil },
          { method: "POST" },
        );
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "snooze_conversation",
        });
        return formatTextContent("Conversation Snoozed", data);
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // Tool 17: unsnooze_conversation
  registerWorkspaceAwareTool(
    server,
    "unsnooze_conversation",
    {
      description:
        'Un-snooze a conversation, bringing it back into the active inbox immediately (e.g. "wake up this conversation now", "un-snooze the thread with Jane"). Identify it by conversationId, or the lead\'s linkedinUrl or email.',
      inputSchema: { ...conversationTargetSchema },
      annotations: {
        title: "Unsnooze Conversation",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
      try {
        const data = await callFlow(
          apiKey,
          "/inbox/conversations/unsnooze",
          requireConversationTarget(params),
          { method: "POST" },
        );
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "unsnooze_conversation",
        });
        return formatTextContent("Conversation Unsnoozed", data);
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // Tool 18: archive_conversation
  registerWorkspaceAwareTool(
    server,
    "archive_conversation",
    {
      description:
        'Archive a conversation, removing it from the active inbox (e.g. "archive this thread", "close out this conversation"). Identify it by conversationId, or the lead\'s linkedinUrl or email. Reversible with unarchive_conversation.',
      inputSchema: { ...conversationTargetSchema },
      annotations: {
        title: "Archive Conversation",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
      try {
        const data = await callFlow(
          apiKey,
          "/inbox/conversations/archive",
          requireConversationTarget(params),
          { method: "POST" },
        );
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "archive_conversation",
        });
        return formatTextContent("Conversation Archived", data);
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // Tool 19: unarchive_conversation
  registerWorkspaceAwareTool(
    server,
    "unarchive_conversation",
    {
      description:
        'Restore an archived conversation back to the active inbox (e.g. "unarchive this", "bring this thread back"). Identify it by conversationId, or the lead\'s linkedinUrl or email.',
      inputSchema: { ...conversationTargetSchema },
      annotations: {
        title: "Unarchive Conversation",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
      try {
        const data = await callFlow(
          apiKey,
          "/inbox/conversations/unarchive",
          requireConversationTarget(params),
          { method: "POST" },
        );
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "unarchive_conversation",
        });
        return formatTextContent("Conversation Unarchived", data);
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // === Members & inbox sending ===

  // Tool 20: list_members
  registerWorkspaceAwareTool(
    server,
    "list_members",
    {
      description:
        "List the members (users) of the authenticated LGM account. Returns each member's id, name and label. Use the returned member id as the `memberId` required by send_linkedin_message.",
      inputSchema: {},
      annotations: {
        title: "List Members",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (_params, extra) => {
      const apiKey = resolveApiKey(extra);
      try {
        const data = await callFlow(apiKey, "/members");
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "list_members",
        });
        return formatTextContent("Members", data);
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // Tool 21: send_linkedin_message
  registerWorkspaceAwareTool(
    server,
    "send_linkedin_message",
    {
      description:
        "Send a LinkedIn message (text or voice) to a lead from one of your connected LinkedIn identities — this ACTUALLY sends the message. Use it to reply to or reach a lead on LinkedIn (e.g. \"reply to this lead on LinkedIn: 'Free for a call Tuesday?'\"). Requires identityId (from list_identities) and memberId (from list_members). Target the lead by leadId OR linkedinUrl (exactly one). Provide message (text) OR audioUrl (a hosted MP3 voice note), exactly one. Note: a conversation with this lead + identity must already exist, otherwise the call fails with 'Conversation not found'.",
      inputSchema: {
        identityId: z
          .string()
          .describe(
            "The LinkedIn identity that sends the message (24-char hex, from list_identities).",
          ),
        memberId: z
          .string()
          .describe(
            "The member performing the action (from list_members). Required for attribution/permissions.",
          ),
        leadId: z
          .string()
          .optional()
          .describe("Lead to message — provide leadId OR linkedinUrl, not both."),
        linkedinUrl: z
          .string()
          .optional()
          .describe(
            "Lead's LinkedIn profile URL — provide linkedinUrl OR leadId, not both.",
          ),
        message: z
          .string()
          .optional()
          .describe("Text message to send — provide message OR audioUrl, not both."),
        audioUrl: z
          .string()
          .optional()
          .describe(
            "URL to a hosted voice message (MP3) — provide audioUrl OR message, not both.",
          ),
        attachments: z
          .array(z.string())
          .optional()
          .describe("List of file URLs to attach to the message."),
      },
      annotations: {
        title: "Send LinkedIn Message",
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
      try {
        if (!params.leadId && !params.linkedinUrl) {
          throw new Error("Provide either leadId or linkedinUrl.");
        }
        if (!params.message && !params.audioUrl) {
          throw new Error("Provide either message or audioUrl.");
        }
        const data = await callFlow(
          apiKey,
          "/inbox/linkedin",
          {
            identityId: params.identityId,
            memberId: params.memberId,
            leadId: params.leadId,
            linkedinUrl: params.linkedinUrl,
            message: params.message,
            audioUrl: params.audioUrl,
            attachments: params.attachments,
          },
          // Un envoi réel est plus lent qu'une lecture : 120s au lieu du défaut 10s pour éviter
          // un timeout côté client alors que le message part côté serveur (cf. callFlow).
          { method: "POST", timeout: 120_000 },
        );
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "send_linkedin_message",
        });
        return formatTextContent("LinkedIn Message Sent", data);
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // Tool 22: send_email_message
  registerWorkspaceAwareTool(
    server,
    "send_email_message",
    {
      description:
        'Send an email to a lead from one of your connected email identities — this ACTUALLY sends the email. Use it to reply to or email a lead (e.g. "email this lead to confirm the meeting"). Requires identityId (from list_identities) and both html and text bodies. Target the lead by leadId OR leadEmail (exactly one). For threading, provide exactly one of: replyInLastThread=true (continue the latest thread), replyToMessageId (reply to a specific message), or subject (start a new email). Optional cc/bcc are comma-separated. Note: a conversation with this lead + identity must already exist.',
      inputSchema: {
        identityId: z
          .string()
          .describe(
            "The email identity that sends the message (24-char hex, from list_identities).",
          ),
        leadId: z
          .string()
          .optional()
          .describe("Target lead — provide leadId OR leadEmail, not both."),
        leadEmail: z
          .string()
          .optional()
          .describe("Lead's email address — provide leadEmail OR leadId, not both."),
        html: z.string().describe("HTML version of the email body (required)."),
        text: z.string().describe("Plain-text version of the email body (required)."),
        subject: z
          .string()
          .optional()
          .describe(
            "Email subject. Required when starting a new email (not replying in a thread).",
          ),
        replyInLastThread: z
          .boolean()
          .optional()
          .describe("Reply within the lead's most recent email thread."),
        replyToMessageId: z
          .string()
          .optional()
          .describe("ID of a specific message to reply to."),
        cc: z
          .string()
          .optional()
          .describe("Comma-separated list of CC recipients."),
        bcc: z
          .string()
          .optional()
          .describe("Comma-separated list of BCC recipients."),
      },
      annotations: {
        title: "Send Email Message",
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
      try {
        if (!params.leadId && !params.leadEmail) {
          throw new Error("Provide either leadId or leadEmail.");
        }
        if (
          params.replyInLastThread !== true &&
          !params.replyToMessageId &&
          !params.subject
        ) {
          throw new Error(
            "Provide one of: subject (for a new email), replyToMessageId, or replyInLastThread=true.",
          );
        }
        const data = await callFlow(
          apiKey,
          "/inbox/email",
          {
            message: { html: params.html, text: params.text },
            identityId: params.identityId,
            leadId: params.leadId,
            leadEmail: params.leadEmail,
            replyInLastThread: params.replyInLastThread,
            replyToMessageId: params.replyToMessageId,
            subject: params.subject,
            cc: params.cc,
            bcc: params.bcc,
          },
          // L'envoi d'email résout le threading + deux corps (html/text) : plus lent qu'une
          // lecture. 120s au lieu du défaut 10s pour éviter un timeout client alors que l'email
          // part côté serveur (le retour timeout est explicitement marqué "may have completed").
          { method: "POST", timeout: 120_000 },
        );
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "send_email_message",
        });
        return formatTextContent("Email Message Sent", data);
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // Tool: enrich_linkedin_post (registered directly — enriches a PUBLIC post from its URL,
  // no identity and no workspace resource involved). POST /posts/enrich débite 1 crédit par
  // appel : même lockstep confirm/acknowledgedCostCredits que enrich_lead.
  const LINKEDIN_POST_ENRICH_COST = 1;
  server.registerTool(
    "enrich_linkedin_post",
    {
      description:
        "Fetch the content and engagement of a public LinkedIn post from its URL. SPENDS 1 CREDIT per call. Use this when the user pastes a LinkedIn post link and wants to read it, summarize it, or analyze its reactions (e.g. \"what does this post say?\", \"how did this post perform?\", \"who wrote this?\"). Returns the post text, the author (firstname, lastname, headline, profile url, avatar), reaction counts (total, like, appreciation, empathy, interest, praise, funny), reposts/shares, the canonical shareUrl, the posted date and the post URN. No campaign or identity is needed — pass any LinkedIn post URL. CONFIRMATION LOCKSTEP: first call with `confirm=false` (or omit) to get the cost vs the current balance, present it to the user and get their explicit approval, THEN re-call with `confirm=true` AND `acknowledgedCostCredits=1`. The tool REFUSES to spend without both.",
      inputSchema: {
        postUrl: z
          .string()
          .describe(
            "The full LinkedIn post URL (e.g. https://www.linkedin.com/posts/<author>_<slug>-activity-<id>-<hash>). Query params like utm_source are tolerated.",
          ),
        confirm: z
          .boolean()
          .optional()
          .describe(
            "Set to true to actually spend the credit. When false (default) returns a cost preview only. Requires acknowledgedCostCredits when true.",
          ),
        acknowledgedCostCredits: z
          .number()
          .optional()
          .describe(
            "REQUIRED when confirm=true. Must equal the `estimatedCostCredits` from the preview (1). Lockstep guard to prove the cost was surfaced to the user before spending.",
          ),
      },
      annotations: {
        title: "Enrich LinkedIn Post By URL",
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
      _meta: TOOL_META,
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
      const cost = LINKEDIN_POST_ENRICH_COST;
      if (!params.confirm) {
        let balance: number | null = null;
        try {
          const raw = (await callFlow(apiKey, "/credits")) as Record<string, unknown>;
          const src =
            raw && typeof raw.credits === "object" && raw.credits !== null
              ? (raw.credits as Record<string, unknown>)
              : raw;
          balance = typeof src?.total === "number" ? src.total : null;
        } catch {
          balance = null;
        }
        const verdict =
          balance === null
            ? "Balance unknown — proceed with caution."
            : balance >= cost
              ? "✅ Sufficient."
              : `❌ INSUFFICIENT (need ${cost}, have ${balance}).`;
        return formatTextContent("Enrich LinkedIn Post Preview — confirmation required", {
          postUrl: params.postUrl,
          estimatedCostCredits: cost,
          balance,
          verdict,
          nextStep: `Surface the cost to the user, get explicit approval, then re-call enrich_linkedin_post with confirm=true AND acknowledgedCostCredits=${cost}.`,
        });
      }
      if (params.acknowledgedCostCredits !== cost) {
        return {
          content: [
            {
              type: "text" as const,
              text: `enrich_linkedin_post refused to spend: confirm=true requires acknowledgedCostCredits=${cost} (got ${params.acknowledgedCostCredits ?? "nothing"}). Run with confirm=false first, surface the cost, then re-call with confirm=true AND acknowledgedCostCredits=${cost}.`,
            },
          ],
          isError: true as const,
        };
      }
      try {
        const data = await callFlow(
          apiKey,
          "/posts/enrich",
          { postUrl: params.postUrl },
          { method: "POST" },
        );
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "enrich_linkedin_post",
        });
        return formatTextContent("LinkedIn Post", data);
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // Tool: ask_your_outbound
  registerWorkspaceAwareTool(
    server,
    "ask_your_outbound",
    {
      description: `Execute a read-only BigQuery SELECT over the current LGM workspace's activity logs (one row = one timestamped campaign action per lead). Results are automatically restricted to your workspace — never filter or group by userId.

FIRST, ONCE PER CONVERSATION: call get_bigquery_logs_guide and keep its rules, action types and metric definitions in mind. You do NOT need to call it again for later queries in the same conversation — remember it. The rules below are a summary; the guide is authoritative.

TABLE: write the bare name  logs  — never a project/dataset path, never backticks. A lead has many rows, so business metrics use COUNT(DISTINCT leadId).

HARD RULES (violations are rejected server-side):
- SELECT only; no *, no DML/DDL, no INFORMATION_SCHEMA.
- ALWAYS filter the partition: WHERE date >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY). Column "date" is a DATE (day only); use "createdAt" (TIMESTAMP) only for hour-level delays.
- Rates: always SAFE_DIVIDE(...). Drop tiny volumes with HAVING contacted_leads >= 30.

COLUMNS: date(DATE), createdAt(TIMESTAMP), type, status ('SUCCESS'|'FAILED'), leadId, campaignId, identityId, stepId, templateId, channel, message.

ACTION TYPES:
- Outbound (require status='SUCCESS'): LINKEDIN_ADD_CONTACT (invitation; counts as a real contact only WITH a note, i.e. templateId IS NOT NULL), LINKEDIN_DIRECT_MESSAGE, LINKEDIN_DIRECT_VOICE, GOOGLE_SEND_EMAIL.
- Replies: LINKEDIN_HAS_REPLY, GOOGLE_REPLY.
- Email engagement: GOOGLE_OPENED (opened), GOOGLE_HAS_CLICKED (clicked), GOOGLE_CHECK_BOUNCE (bounced).
- Ignore the *_ON_* types (under-logged) and *_NOT_* / *_NO_REPLY* (campaign-flow condition checks).

VERIFIED METRICS (use exactly):
- contacted = COUNT(DISTINCT IF(status='SUCCESS' AND ((type='LINKEDIN_ADD_CONTACT' AND templateId IS NOT NULL) OR type IN ('LINKEDIN_DIRECT_MESSAGE','LINKEDIN_DIRECT_VOICE','GOOGLE_SEND_EMAIL')), leadId, NULL))
- replied = COUNT(DISTINCT IF(type IN ('LINKEDIN_HAS_REPLY','GOOGLE_REPLY'), leadId, NULL))
- opened = COUNT(DISTINCT IF(type IN ('GOOGLE_OPENED','GOOGLE_HAS_CLICKED'), leadId, NULL)) (a click implies an open)
- clicked = COUNT(DISTINCT IF(type='GOOGLE_HAS_CLICKED', leadId, NULL))
- bounced = COUNT(DISTINCT IF(type='GOOGLE_CHECK_BOUNCE', leadId, NULL))

For funnels, reply-time, or per-step breakdowns, call get_bigquery_logs_guide first.`,
      inputSchema: {
        query: z
          .string()
          .describe(
            "A single read-only BigQuery SELECT over the logical table logs. Must filter on date. No SELECT *, no qualified/backticked table names.",
          ),
      },
      annotations: {
        title: "Ask Your Outbound",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
      try {
        const data = await callFlow(
          apiKey,
          "/mcp/bigquery/query",
          { query: params.query },
          { method: "POST" },
        );
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "ask_your_outbound",
        });
        return formatTextContent("BigQuery Results", data);
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // Tool: get_bigquery_logs_guide
  registerWorkspaceAwareTool(
    server,
    "get_bigquery_logs_guide",
    {
      description:
        "Return the full BigQuery logs guide: schema, verified metric definitions, and ready-to-use example queries (funnels, reply-time, per-campaign/step rates). Read it before writing non-trivial analytics with ask_your_outbound.",
      inputSchema: {},
      annotations: {
        title: "BigQuery Logs Guide",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async () => {
      return {
        content: [{ type: "text" as const, text: BIGQUERY_LOGS_GUIDE }],
      };
    },
  );
};
