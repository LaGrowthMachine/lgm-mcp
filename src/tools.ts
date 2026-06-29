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
  server.registerTool(name, { ...config, inputSchema: mergedSchema }, wrappedHandler as unknown as ToolCallback<typeof mergedSchema>);
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
        openWorldHint: true,
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
        openWorldHint: true,
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
        "Get the list of leads in a specific audience. Returns lead details including name, company, job title, email, and LinkedIn URL. Supports pagination.",
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
        openWorldHint: true,
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
        openWorldHint: true,
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
        openWorldHint: true,
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
        openWorldHint: true,
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
        "Get all message templates for a specific campaign. Returns the sequence of messages (emails, LinkedIn messages) with their HTML content, type, channel, and order. Useful for reviewing or modifying campaign messaging.",
      inputSchema: {
        campaignId: z
          .string()
          .describe("The campaign ID (24-character hex string)"),
      },
      annotations: {
        title: "Get Campaign Messages",
        readOnlyHint: true,
        openWorldHint: true,
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
        openWorldHint: true,
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
        destructiveHint: true,
        openWorldHint: true,
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
        "Create a new audience (or populate an existing one) by importing leads from a LinkedIn Regular search URL, a Sales Navigator search URL, or a LinkedIn post URL. The `audience` parameter is a NAME, not an ID — if no audience with that name exists, LGM creates one; if it does, leads are added to it. Requires an `identityId` from list_identities; the underlying LinkedIn account must be connected and the LGM widget open during the import. Import runs asynchronously — poll get_audience to check status.",
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
            "LinkedIn Regular search URL, Sales Navigator search URL, or LinkedIn post URL",
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
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
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
        return formatTextContent("Audience Created", data);
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
        openWorldHint: true,
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
        openWorldHint: true,
      },
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
        openWorldHint: true,
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
        openWorldHint: true,
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
        openWorldHint: true,
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
        openWorldHint: true,
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
        destructiveHint: true,
        openWorldHint: true,
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
        destructiveHint: true,
        openWorldHint: true,
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
        destructiveHint: true,
        openWorldHint: true,
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
        destructiveHint: true,
        openWorldHint: true,
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
        openWorldHint: true,
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
          { method: "POST" },
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
          { method: "POST" },
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

  // Tool: get_linkedin_post (enrich a public LinkedIn post from its URL)
  server.registerTool(
    "get_linkedin_post",
    {
      description:
        "Fetch the content and engagement of a public LinkedIn post from its URL. Use this when the user pastes a LinkedIn post link and wants to read it, summarize it, or analyze its reactions (e.g. \"what does this post say?\", \"how did this post perform?\", \"who wrote this?\"). Returns the post text, the author (firstname, lastname, headline, profile url, avatar), reaction counts (total, like, appreciation, empathy, interest, praise, funny), reposts/shares, the canonical shareUrl, the posted date and the post URN. No campaign or identity is needed — pass any LinkedIn post URL.",
      inputSchema: {
        postUrl: z
          .string()
          .describe(
            "The full LinkedIn post URL (e.g. https://www.linkedin.com/posts/<author>_<slug>-activity-<id>-<hash>). Query params like utm_source are tolerated.",
          ),
      },
      annotations: {
        title: "Get LinkedIn Post By URL",
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
      try {
        const data = await callFlow(
          apiKey,
          "/posts/enrich",
          { postUrl: params.postUrl },
          { method: "POST" },
        );
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "get_linkedin_post",
        });
        return formatTextContent("LinkedIn Post", data);
      } catch (error) {
        return handleToolError(error);
      }
    },
  );
};
