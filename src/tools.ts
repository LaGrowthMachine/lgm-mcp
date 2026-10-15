/*
 * Copyright 2026 La Growth Machine
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */
import { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z, ZodRawShape } from "zod";
import { callFlow, FlowErrorDetail, LGM_API_UNAVAILABLE, McpFlowError } from "./callFlow";
import { trackMcpEvent } from "./tracking";
import { getApiKey, requestContext } from "./requestContext";
import { BIGQUERY_LOGS_GUIDE } from "./bigqueryGuide";
import { CALL_API_DEDICATED, CALL_API_SENSITIVE, CALL_API_SLOW, assertLeadStatusBody, buildCatalogueText, resolveCallApiRoute } from "./callApi";

// ponytail: the 4 qualification tags the ticket asks for. POST /flow/leads/status accepts ~20 more
// (lifecycle, internal tags) — reachable via call_api_write if a user explicitly needs one.
const LEAD_STATUSES = ["INTERESTED", "NOT_INTERESTED", "WRONG_TARGET", "CALL_BOOKED"] as const;

// The two manual task types that /flow can complete (call / custom message). LinkedIn invite notes
// that are too long are also manual tasks in LGM, but have no completion endpoint: never listed.
const MANUAL_TASK_TYPES = ["CALL", "CUSTOM_MESSAGE"] as const;
const CALL_OUTCOMES = ["DECISIVE", "UNREACHABLE"] as const;

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
      "Target workspace id (from list_workspaces). Only relevant on multi-workspace accounts " +
        "(list_workspaces returns multiWorkspace=true), to act in another workspace than the current one. " +
        "Almost every account has a single workspace, in which case this field stays empty.",
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

  registerWorkspaceAwareTool(
    server,
    "list_public_campaigns",
    {
      description: `List ready-made campaigns anyone can copy. Each item has an \`origin\`:
'catalog' (official LGM strategy templates) or 'creators' (use-case
templates shared by LGM Marketing or other LGM users). An id passed to
duplicate_campaign creates the user's campaign — the new copy has no
audience yet (set_campaign_audience) and runs with one of the user's
identities, not necessarily the intended one (set_campaign_identity), before
it is launched with launch_campaign.

## Result sets
\`type: "recommended"\` is a small, pre-curated shortlist (catalog only,
always well-named with a description) and the usual starting point.
\`type: "public"\` is the full list (catalog + creators, names need parsing
— see below); it covers what \`recommended\` does not: more options,
audience profiles the shortlist doesn't fit, and creators use-case
examples (creators campaigns never appear in \`recommended\`).
\`type: "featured"\` exists but its behavior is unverified.

## Field reliability
- \`origin\`: "catalog" (public strategy template) | "creators" (shared
  use-case template). This field, not the name, tells the two apart.
- \`channels\`: NOT reliable for "which channel this sequence messages
  through". It includes silent/passive actions (e.g. a LinkedIn profile
  visit used as a warm-up step, even on an email-only sequence), so it
  does not give the sequence's channel(s) or their order.
- \`tags\` / \`order\`: display-only (catalog ordering / internal labels),
  not meaningful for recommendation logic.
- \`description\`: reliable and often already contains the strategic
  rationale for catalog templates — see below.

## Matching a template to the user
The right template depends on the target audience's channel
presence/behavior and on the user's goal. A short shortlist (1-3 options)
serves the user better than every matching template.

## Public campaigns (origin: "catalog") — strategy templates
Not tied to a specific use case — each represents a sequence ARCHITECTURE
(which channel opens the sequence, how many followups, single vs
multichannel, with or without a voice step).

Step 1 — \`description\`, when non-empty. Most well-formed catalog
templates already carry a human-written rationale, e.g.:
  "Engage first on LinkedIn, fallback using Emails if they haven't
   replied. This sequence is perfect if your audience is quite active on
   LinkedIn."
It maps directly to an audience profile.

Step 2 — \`name\`, when \`description\` is empty or to get the exact
structure. Pattern:
  <Channel1> [> <Channel2> [> <Channel3>]] - <N> Follow-up[s] [(+ 🎤 Voice)]
  <Channel> Only [- <N> Follow-up[s]] [(+ 🎤 Voice)]
A trailing standalone number after "Follow-up(s)" or at the end of the
name is an internal id/version suffix, not data (e.g.
"Email > Linkedin - 3 Follow-ups 1" → 3 followups, not "1").

Examples:
- "LinkedIn > Email - 4 Follow-ups 1" → opens LinkedIn, falls back to
  Email, 4 followups
- "Email > Linkedin - 3 Follow-ups 1" → opens Email, falls back to
  LinkedIn, 3 followups
- "LinkedIn Only - 2 Follow-ups 1" → LinkedIn-only, 2 followups
- "Email > Linkedin > Twitter - 2 Follow-ups 1" → opens Email, then
  LinkedIn, then Twitter, 2 followups

A name that doesn't match this pattern and has no description is low
confidence: its structure is unknown, and it is a last-resort option.

### How templates fit audiences
- Target highly active on LinkedIn → templates that OPEN with LinkedIn.
- Target barely present on LinkedIn → templates that OPEN with Email.
- Target posts a lot on LinkedIn (engaged audience) → templates
  explicitly built for engagement/warming, when available.
- "Only" (single-channel) templates: LinkedIn connection requests are
  frequently never accepted, which leaves those leads unreachable on a
  LinkedIn-only sequence. A multichannel template (X > Y) covers that
  gap, so it is the better fit unless the user has a specific reason to
  stay single-channel.
- Follow-up count: when several templates match on channel order and
  differ only by follow-up count, the choice is the user's (how
  persistent the sequence should be); 2-3 is a sensible mid-range
  default, stated as such.
- Twitter: some templates add Twitter as a third channel. It's a
  low-usage, largely legacy channel for most LGM audiences, relevant only
  when the audience is known to be active there.

## Shared campaigns (origin: "creators") — use-case templates
Built by LGM Marketing or a creator to solve a SPECIFIC use case. Their
main value is the copywriting — duplicating one gives a ready example
message sequence to reuse or adapt, not a structural choice.

\`description\` is frequently empty for these. \`name\` is a first-pass
hint:
- Specific/self-explanatory name (mentions a company, integration,
  objective) → it states the use case.
- Generic or uninformative name (e.g. "test", "Partagée #1", "Campaign
  Shared by X") → not trustworthy; get_campaign_messages on it shows the
  actual use case from the message content. If that still doesn't
  clarify it, a shared campaign with a clear use case is a better fit.

Shared campaigns fit a specific goal or scenario, not a general
channel-targeting question; they are curated examples whose main value is
the messaging to reuse or adapt.

## Two different purposes
Public = the right sequence architecture for the audience.
Shared = the right example message for the goal.
A need that spans both can combine a public template for the structure
with a relevant shared template for messaging inspiration.`,
      inputSchema: {
        type: z
          .enum(["public", "featured", "recommended"])
          .optional()
          .default("public")
          .describe(
            "Which set to return: 'recommended' (small curated catalog shortlist, the usual starting point), 'public' (full list: catalog + creators, default), 'featured' (unverified)",
          ),
      },
      annotations: {
        title: "List Public Campaigns",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
      try {
        const data = await callFlow(apiKey, "/campaigns/public", params);
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "list_public_campaigns",
        });
        return formatTextContent("Public campaigns", data);
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
        "Duplicate a campaign into a new draft (READY) copy — its sequence and every step's message template (new template IDs) — without launching it. Works for the user's own campaigns (id from list_campaigns) as well as catalog and creators templates (id from list_public_campaigns). After duplicating, use get_campaign_messages on the new campaign to fetch its templates and edit_campaign_message to rewrite them.",
      inputSchema: {
        campaignId: z
          .string()
          .describe(
            "The campaign ID to duplicate (24-character hex string), from list_campaigns or list_public_campaigns",
          ),
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

  // Tool 7h: set_campaign_setting
  const CAMPAIGN_BOOLEAN_SETTINGS = {
    autoEnrich: {
      field: "enrich",
      description: "auto-enrichment of the campaign's leads (any status)",
    },
    outOfOffice: {
      field: "autoRescheduleOutOfOffice",
      description: "out-of-office auto-rescheduling: reschedule actions when a lead is detected out of office (any status)",
    },
    skipAlreadyContacted: {
      field: "skipAlreadyContacted",
      description: "skip leads you have already reached out to (campaign must be READY or PAUSED)",
    },
    ignoreEmojiOnlyReplies: {
      field: "ignoreEmojiOnlyReply",
      description:
        "a reply made only of emojis (e.g. 👍) does NOT stop the sequence; when disabled, any reply stops it. New campaigns are created with it enabled; older campaigns may still read false (campaign must be READY or PAUSED)",
    },
  } as const;
  type CampaignBooleanSetting = keyof typeof CAMPAIGN_BOOLEAN_SETTINGS;
  const settingKeys = Object.keys(CAMPAIGN_BOOLEAN_SETTINGS) as [CampaignBooleanSetting, ...CampaignBooleanSetting[]];

  registerWorkspaceAwareTool(
    server,
    "set_campaign_setting",
    {
      description:
        "Enable or disable one boolean setting of a campaign. Settings: " +
        settingKeys.map((k) => `${k} = ${CAMPAIGN_BOOLEAN_SETTINGS[k].description}`).join("; ") +
        ". Get the campaignId from list_campaigns. For CRM sync use set_campaign_crm_sync, for the audience use set_campaign_audience.",
      inputSchema: {
        campaignId: z
          .string()
          .describe("The campaign ID (24-character hex string), from list_campaigns"),
        setting: z.enum(settingKeys).describe("The setting to change"),
        enabled: z.boolean().describe("true to enable the setting, false to disable it"),
      },
      annotations: {
        title: "Set Campaign Setting",
        readOnlyHint: false,
        // autoEnrich spends credits on every lead of the campaign.
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
          { [CAMPAIGN_BOOLEAN_SETTINGS[params.setting].field]: params.enabled },
          { method: "POST" },
        );
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "set_campaign_setting",
          setting: params.setting,
        });
        return formatTextContent("Campaign Setting Updated", data);
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // Tool 7i: set_campaign_crm_sync
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

  // lgm-apis refuses an identity change, a launch, a pause or a resume with one or several reasons in `errors[]`
  // ({ code, message, stepIds? }). Each reason is listed with the tool that fixes it, picked by its code,
  // so the host can recover without parsing the message. A refusal without `errors` passes through unchanged.
  type RefusalHint = string | ((detail: FlowErrorDetail) => string | undefined);
  const CAMPAIGN_NOT_FOUND_HINT = "use a campaignId from list_campaigns, with the same workspaceId if one was used";
  const PLAN_REFUSAL_HINTS: Record<string, RefusalHint> = {
    RUNNING_CAMPAIGNS_LIMIT_REACHED: "pausing another running campaign (pause_campaign) frees a slot when list_campaigns shows one; if none is running, the plan of the account allows no running campaign",
    IDENTITY_PAYMENT_ISSUE: "the payment of the identity is fixed in the LGM app",
    CRM_NOT_AVAILABLE: "set_campaign_crm_sync turns the CRM sync of the campaign off",
  };
  const handleRefusal = (error: unknown, heading: string, hints: Record<string, RefusalHint>) => {
    if (!(error instanceof McpFlowError) || error.details.length === 0) return handleToolError(error);
    const reasons = error.details.map((detail) => {
      const hint = hints[detail.code];
      const fix = typeof hint === "function" ? hint(detail) : hint;
      const stepIds = Array.isArray(detail.stepIds) && detail.stepIds.length ? ` (stepIds: ${detail.stepIds.join(", ")})` : "";
      return `${detail.message}${stepIds}${fix ? ` — ${fix}` : ""}`;
    });
    const text = reasons.length === 1 ? `${heading}: ${reasons[0]}` : `${heading}:\n- ${reasons.join("\n- ")}`;
    return handleToolError(new McpFlowError(text, error.statusCode));
  };

  // Tool 7j: pause_campaign
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
        return handleRefusal(error, "The campaign cannot be paused", {
          CAMPAIGN_NOT_FOUND: CAMPAIGN_NOT_FOUND_HINT,
          CAMPAIGN_NOT_RUNNING: (detail) =>
            detail.status === "PAUSED"
              ? "the campaign is already paused"
              : detail.status === "READY"
                ? "the campaign was never launched; launch_campaign starts it"
                : undefined,
        });
      }
    },
  );

  // Tool 7k: resume_campaign
  registerWorkspaceAwareTool(
    server,
    "resume_campaign",
    {
      description:
        "Resume a PAUSED campaign: its leads pick up their sequence where they stopped (same effect as the Resume button in the LGM app). Only a PAUSED campaign can be resumed — a READY campaign that has never been launched is started with launch_campaign; any other status returns an error stating the current status and nothing is changed. Resuming is subject to the plan limits (max running campaigns, CRM / custom campaign permissions): the API returns an explicit error if they are exceeded. Edits made while the campaign was paused are not retroactive: they only apply to the actions still pending — nothing is replayed for leads who already went through a step. Get the campaignId from list_campaigns.",
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
        return handleRefusal(error, "The campaign cannot be resumed", {
          ...PLAN_REFUSAL_HINTS,
          CAMPAIGN_NOT_FOUND: CAMPAIGN_NOT_FOUND_HINT,
          CAMPAIGN_NOT_PAUSED: (detail) =>
            detail.status === "RUNNING"
              ? "the campaign is already running"
              : detail.status === "READY"
                ? "a campaign that was never launched is started with launch_campaign"
                : undefined,
        });
      }
    },
  );

  // Tool 7l: set_campaign_identity — POST /flow/campaigns/:id/settings { identityId }
  type CampaignSettingsData = {
    id?: string;
    name?: string;
    identityId?: string;
    identityFirstname?: string | null;
    identityLastname?: string | null;
    senderEmailAddressesCount?: number;
  };
  registerWorkspaceAwareTool(
    server,
    "set_campaign_identity",
    {
      description:
        "Change the identity of a campaign that has not been launched yet (status READY): the LinkedIn account and email sender the campaign runs with. " +
        "The campaign then sends its emails from every connected email address of the new identity. " +
        "Rejected once the campaign has been launched. " +
        "Get the campaignId from list_campaigns and the identityId from list_identities. " +
        'Examples: "Utilise l\'identité de Marie pour cette campagne", "Send this campaign from my other LinkedIn account". ' +
        "Confirm intent before calling.",
      inputSchema: {
        campaignId: z
          .string()
          .describe("The campaign ID (24-character hex string), from list_campaigns"),
        identityId: z
          .string()
          .describe("The identity ID to run the campaign with (24-character hex string), from list_identities"),
      },
      annotations: {
        title: "Set Campaign Identity",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
      try {
        const data = await callFlow(
          apiKey,
          `/campaigns/${params.campaignId}/settings`,
          { identityId: params.identityId },
          { method: "POST" },
        );
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "set_campaign_identity",
        });
        const campaign = (data as { data?: CampaignSettingsData } | null)?.data;
        if (!campaign?.identityId) return formatTextContent("Campaign Identity Updated", data);
        return formatTextContent("Campaign Identity Updated", {
          campaignId: campaign.id,
          campaignName: campaign.name,
          identity: {
            id: campaign.identityId,
            name: [campaign.identityFirstname, campaign.identityLastname].filter(Boolean).join(" "),
          },
          senderEmailAddresses: campaign.senderEmailAddressesCount,
        });
      } catch (error) {
        return handleRefusal(error, "The identity cannot be changed", {
          CAMPAIGN_NOT_FOUND: CAMPAIGN_NOT_FOUND_HINT,
          IDENTITY_NOT_FOUND: "use an identityId from list_identities, in the same workspace as the campaign",
          CAMPAIGN_ALREADY_LAUNCHED: "a launched campaign keeps its identity; duplicate_campaign creates a draft copy whose identity can be changed",
        });
      }
    },
  );

  // Tool 7m: launch_campaign — POST /flow/campaigns/:id/launch. No retry: a 5xx may land after the
  // campaign went RUNNING, and a second launch is refused anyway — the status tells what happened.
  registerWorkspaceAwareTool(
    server,
    "launch_campaign",
    {
      description:
        "Launch a campaign that has never been launched (status READY): LGM starts its sequence for the leads of its audience and sends real " +
        "LinkedIn invitations, LinkedIn messages and emails from the campaign's identity (same effect as the Launch button in the LGM app). " +
        "A launched campaign can be paused (pause_campaign) but never goes back to draft. " +
        "LGM checks the campaign first and refuses with every reason at once, each with the tool that fixes it: an audience with leads " +
        "(set_campaign_audience), a Start block connected to the sequence, the content of every step that needs one (a missing message is " +
        "added with add_campaign_step_message, stepIds from get_campaign_steps; a voice recording or a call script in the LGM app), connected " +
        "sender email addresses for email steps, and a LinkedIn connection for LinkedIn steps or auto-enrichment (set_campaign_identity to " +
        "switch identity). " +
        "Once the campaign is complete, the plan limits (running campaigns, billing) are checked. " +
        "A PAUSED campaign is restarted with resume_campaign instead. Get the campaignId from list_campaigns. " +
        "This starts real outreach to prospects: summarize the campaign (name, audience, identity) and get the user's explicit approval before calling.",
      inputSchema: {
        campaignId: z
          .string()
          .describe("The campaign ID (24-character hex string), from list_campaigns"),
      },
      annotations: {
        title: "Launch Campaign",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
      try {
        const data = await callFlow(
          apiKey,
          `/campaigns/${params.campaignId}/launch`,
          {},
          { method: "POST", timeout: 120_000, retries: 0 },
        );
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "launch_campaign",
        });
        const campaign = (data as { data?: { id?: string; name?: string; launchedAt?: number | string | null } } | null)?.data;
        if (!campaign?.id) return formatTextContent("Campaign Launched", data);
        // The campaign is live at this point: an unreadable launchedAt must not turn it into an error.
        const launchedAt = campaign.launchedAt ? new Date(campaign.launchedAt) : undefined;
        return formatTextContent("Campaign Launched", {
          campaignId: campaign.id,
          campaignName: campaign.name,
          ...(launchedAt && !Number.isNaN(launchedAt.getTime()) && { launchedAt: launchedAt.toISOString() }),
        });
      } catch (error) {
        // A timeout, a 5xx or a network error can come after the campaign went RUNNING.
        const unknownOutcome =
          " — the launch may have gone through: check the campaign's status with list_campaigns before calling launch_campaign again.";
        if (!(error instanceof McpFlowError)) {
          return handleToolError(new Error(`${error instanceof Error ? error.message : "Unknown error occurred"}${unknownOutcome}`));
        }
        if (error.statusCode === 408 || error.statusCode >= 500) {
          const cause =
            error.statusCode === 408
              ? "LGM did not answer in time"
              : error.message === LGM_API_UNAVAILABLE
                ? "LGM answered with a server error"
                : error.message;
          return handleToolError(new McpFlowError(`${cause}${unknownOutcome}`, error.statusCode));
        }
        return handleRefusal(error, "The campaign cannot be launched yet", {
          ...PLAN_REFUSAL_HINTS,
          CAMPAIGN_NOT_FOUND: CAMPAIGN_NOT_FOUND_HINT,
          CAMPAIGN_ALREADY_LAUNCHED: (detail) =>
            detail.status === "PAUSED"
              ? "resume_campaign restarts a paused campaign"
              : detail.status === "RUNNING"
                ? "the campaign is already running"
                : undefined,
          IDENTITY_NOT_FOUND: "the campaign's identity no longer exists: set_campaign_identity attaches another one (identityId from list_identities)",
          AUDIENCE_MISSING: "set_campaign_audience attaches one (audienceId from list_audiences)",
          AUDIENCE_EMPTY: "add leads to the audience (create_lead, create_audience_from_linkedin_url), or set_campaign_audience attaches another one",
          SEQUENCE_START_NOT_CONNECTED: "the user connects the Start block to the first step in the LGM app",
          STEPS_WITHOUT_CONTENT:
            "add_campaign_step_message adds a missing message (same stepIds as get_campaign_steps); a voice recording or a call script is added in the LGM app",
          NO_SENDER_EMAIL_ADDRESS:
            "the user connects an email address to the identity and selects it as a sender of the campaign in the LGM app, or set_campaign_identity switches to an identity that has one",
          SENDER_EMAIL_ADDRESS_DISCONNECTED:
            "the user reconnects or deselects these email addresses in the LGM app, or set_campaign_identity switches to an identity whose addresses are connected",
          IDENTITY_NOT_CONNECTED_TO_LINKEDIN:
            "the user reconnects the identity to LinkedIn in the LGM app, or set_campaign_identity switches to another identity; " +
            "for a campaign without LinkedIn steps, set_campaign_setting can turn autoEnrich off instead",
          LINKEDIN_INVITE_NOTE_NOT_AVAILABLE:
            "set_campaign_identity switches to an identity with a Premium or Sales Navigator LinkedIn account, or the user removes the note in the LGM app",
        });
      }
    },
  );

  // Tool 8: get_audience
  registerWorkspaceAwareTool(
    server,
    "get_audience",
    {
      description:
        "Get detailed information about a specific audience. Returns name, description, size, type, and import status. Use the audienceId returned by list_audiences.",
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
        "Create a new audience (or populate an existing one) by importing leads from a LinkedIn Regular search URL, a Sales Navigator search URL, a LinkedIn post URL, or a LinkedIn event URL (imports the event's attendees). The `audience` parameter is a NAME, not an ID — if no audience with that name exists, LGM creates one; if it does, leads are added to it. Requires an `identityId` from list_identities; the underlying LinkedIn account must be connected to LGM during the import. LinkedIn event URLs: only an identity registered to that event on LinkedIn can see its attendees; any other identity imports 0 attendees. Import runs asynchronously — poll get_audience to check status.",
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
            "LinkedIn identity used to run the import (24-character hex ObjectId). Use list_identities to find it.",
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
        "List every audience of the authenticated user's workspace. Returns each audience with `id`, `name`, and `leadsCount` (plus other metadata). Typical requests: \"mes audiences\", \"which audiences do I have?\", \"combien de leads dans mon audience X ?\". It is also the natural follow-up to `create_audience_from_linkedin_url` (which does NOT return the new audience's id) so downstream tools that need an `audienceId` (get_audience, get_audience_leads) can resolve it by name.",
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
        "List the workspaces the signed-in user can act in. Returns `multiWorkspace` and a " +
        "`workspaces` array (each with workspaceId, name, slug, plan, identitiesCount, isCurrent). " +
        "If `multiWorkspace` is false the user has a single workspace and `workspaceId` stays empty on every " +
        "tool. When `multiWorkspace` is true, `workspaceId` (the chosen workspaceId) on other tools targets " +
        "that workspace. `isCurrent` marks the workspace acted in by default.",
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
        "Create a lead — or update it in place when it already exists (upsert on the identifier fields). Use whenever the user says \"add this contact\", \"push a lead\", \"create a lead for John Doe at Acme\", or \"update the job title of this lead\". At least ONE identifier is required: `leadId` (updates the existing lead), OR `proEmail` / `persoEmail` / `linkedinUrl` / `twitter` (match then upsert), OR `firstname` + `lastname` plus `companyName` OR `companyUrl` (matches on name+company). Attach the lead to an audience with the optional `audience` param (a NAME, not an id — use list_audiences from the audience tools if you need one). All other profile fields are optional; the twenty `customAttribute1`…`customAttribute20` slots accept up to 2500 chars each and are handy for storing personalization notes or AI-generated blurbs on the lead. Use `note` for the free-text note displayed on the lead profile — the one the team reads in the app; passing it replaces the existing note. Set `excludeContactedLeads: true` to skip leads that were already contacted (no-op instead of update).",
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
        // Custom attributes — 20 free-form long-text slots (max 2500 chars each).
        customAttribute1: z.string().max(2500).optional(),
        customAttribute2: z.string().max(2500).optional(),
        customAttribute3: z.string().max(2500).optional(),
        customAttribute4: z.string().max(2500).optional(),
        customAttribute5: z.string().max(2500).optional(),
        customAttribute6: z.string().max(2500).optional(),
        customAttribute7: z.string().max(2500).optional(),
        customAttribute8: z.string().max(2500).optional(),
        customAttribute9: z.string().max(2500).optional(),
        customAttribute10: z.string().max(2500).optional(),
        customAttribute11: z.string().max(2500).optional(),
        customAttribute12: z.string().max(2500).optional(),
        customAttribute13: z.string().max(2500).optional(),
        customAttribute14: z.string().max(2500).optional(),
        customAttribute15: z.string().max(2500).optional(),
        customAttribute16: z.string().max(2500).optional(),
        customAttribute17: z.string().max(2500).optional(),
        customAttribute18: z.string().max(2500).optional(),
        customAttribute19: z.string().max(2500).optional(),
        customAttribute20: z.string().max(2500).optional(),
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
        // Matches on LinkedIn / external CRM identifiers.
        openWorldHint: true,
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
    PHONE_ENRICH: 20,
  } as const;
  type EnrichType = keyof typeof ENRICH_COSTS;

  // Tool 11e: get_credits
  registerWorkspaceAwareTool(
    server,
    "get_credits",
    {
      description:
        "Return the credit balance for the authenticated account. Returns `total` (all available credits) and `perishable` (credits that expire soon, already counted in `total`). Typical requests: \"combien de crédits ?\", \"how many credits do I have?\". Also useful before a credit-spending action (enrich_lead, enrich_linkedin_post) to check the balance covers it.",
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
        "Enrich a single lead — finds their pro email or phone number and/or fills in LinkedIn profile fields on the LGM lead. Spends credits: EMAIL_ENRICH (up to 5 credits, finds pro email + validation status, works from firstname+lastname+company without a leadId) | LINKEDIN_ENRICH (up to 1 credit, refreshes LinkedIn profile fields on the lead, REQUIRES leadId) | FULL_ENRICH (up to 5 credits, both, REQUIRES leadId) | PHONE_ENRICH (up to 20 credits, finds the lead's phone number and saves it on the lead, REQUIRES leadId — e.g. \"trouve son numéro de téléphone\", \"get me this lead's phone number\"). Runs in polling mode: returns an `enrichRequestId` — resolve later with get_enrich_result once status=completed. TWO-STEP CONFIRMATION: a call with `confirm=false` (or omitted) returns the estimated cost vs the current balance and spends nothing; this preview exists so the cost can be shown to the user before the confirming call. The confirming call is `confirm=true` AND `acknowledgedCostCredits` set to the exact estimated value. The tool refuses to spend without both, and refuses if the acknowledged value does not match the calculated one, so an accidental spend cannot happen.",
      inputSchema: {
        leadId: z
          .string()
          .optional()
          .describe(
            "Existing lead id (24-char hex ObjectId). REQUIRED for LINKEDIN_ENRICH, FULL_ENRICH and PHONE_ENRICH. Get one via list_audiences → get_audience_leads, or from a search/inbox tool.",
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
          .enum(["EMAIL_ENRICH", "LINKEDIN_ENRICH", "FULL_ENRICH", "PHONE_ENRICH"])
          .optional()
          .default("EMAIL_ENRICH")
          .describe(
            "Drives what is enriched and cost. EMAIL_ENRICH (5 cr, no leadId needed) | LINKEDIN_ENRICH (1 cr, needs leadId) | FULL_ENRICH (5 cr, needs leadId) | PHONE_ENRICH (20 cr, phone number, needs leadId).",
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
            "REQUIRED when confirm=true. Must exactly match `estimatedCostCredits` from the dry-run preview. The tool rejects confirm=true without it, and rejects mismatched values.",
          ),
      },
      annotations: {
        title: "Enrich Lead",
        readOnlyHint: false,
        destructiveHint: true,
        // Queries external enrichment providers and LinkedIn.
        openWorldHint: true,
      },
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
      const enrichType = (params.enrichType ?? "EMAIL_ENRICH") as EnrichType;
      const cost = ENRICH_COSTS[enrichType];
      const hasLeadId = Boolean(params.leadId);
      const hasNameMatch = Boolean(params.firstname && params.lastname);

      // Cross-field validation from the endpoint doc. The leadId-only types
      // are checked first: firstname+lastname would not satisfy them.
      if (
        (enrichType === "LINKEDIN_ENRICH" ||
          enrichType === "FULL_ENRICH" ||
          enrichType === "PHONE_ENRICH") &&
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
        "Retrieve the result of an enrichment request previously started by enrich_lead (polling mode). Returns `status` (pending / enriched / completed / failed / not_found) and, when finished, the enriched data — pro email, perso email, phone, refreshed LinkedIn fields, email validity status. Enrichments usually complete within a minute.",
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
        "List inbox conversations waiting for the user's reply — the lead spoke last and the thread is still open. This is the SDR's daily \"who do I need to answer?\" queue (e.g. \"show me the conversations I need to reply to\", \"what's waiting on me?\"). Returns newest-first conversations with id, leadId, identityId, channel (lastMessageType) and status — but NOT the lead's name or message text. To show the actual exchange, follow up with get_conversation_messages (by conversationId); to resolve who the lead is, use get_audience_leads (the record carries the leadId). Optionally narrow to specific identities or to conversations active since a given time.",
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
            "Pagination cursor — NOT a conversation id. Leave empty on the first call; the response then returns a nextToken (plus hasMore and total). To fetch the next page, pass that nextToken here verbatim, keeping the same filters and sort. Each page returns a new nextToken for the page after it; stop when hasMore is false.",
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
        'List unread inbox conversations (read = false), newest first. Answers "what unread conversations do I have?" and inbox-zero triage. Note: unread is distinct from awaiting-reply — for the latter use get_conversations_to_reply. Returns ids and metadata only (id, leadId, identityId, channel, status), no names or message bodies; hydrate with get_conversation_messages and get_audience_leads.',
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
            "Pagination cursor — NOT a conversation id. Leave empty on the first call; the response then returns a nextToken (plus hasMore and total). To fetch the next page, pass that nextToken here verbatim, keeping the same filters and sort. Each page returns a new nextToken for the page after it; stop when hasMore is false.",
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
        'List conversations the user has favourited / starred — their priority accounts (e.g. "show my starred conversations", "favourites that replied"). Optionally restrict to conversations where the lead has replied. Returns ids and metadata only (no lead names or message text); hydrate with get_conversation_messages and get_audience_leads.',
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
            "Pagination cursor — NOT a conversation id. Leave empty on the first call; the response then returns a nextToken (plus hasMore and total). To fetch the next page, pass that nextToken here verbatim, keeping the same filters and sort. Each page returns a new nextToken for the page after it; stop when hasMore is false.",
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
        "Search and filter the whole conversation inbox across every lead, identity, campaign and audience — the general inbox query, for filter combinations the specialized tools don't cover: free-text (q), by campaign/audience/lead, by channel or message direction, by date windows, or any mix of flags. The specialized tools cover the common cases: conversations awaiting your reply → get_conversations_to_reply; unread → get_unread_conversations; favourites → get_favourite_conversations. Returns conversation ids and metadata only (no lead names or message text) — hydrate with get_conversation_messages (the thread) and get_audience_leads (who the lead is). Paginate with limit + searchAfter: the first call returns a nextToken; pass it as searchAfter (unchanged filters/sort) to get the next page, and repeat with each page's new nextToken while hasMore is true.",
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
            "Pagination cursor — NOT a conversation id. Leave empty on the first call; the response then returns a nextToken (plus hasMore and total). To fetch the next page, pass that nextToken here verbatim, keeping the same filters and sort. Each page returns a new nextToken for the page after it; stop when hasMore is false.",
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
        "Fetch the content and engagement of a public LinkedIn post from its URL. SPENDS 1 CREDIT per call. Applies when a LinkedIn post link is provided to read it, summarize it, or analyze its reactions (e.g. \"what does this post say?\", \"how did this post perform?\", \"who wrote this?\"). Returns the post text, the author (firstname, lastname, headline, profile url, avatar), reaction counts (total, like, appreciation, empathy, interest, praise, funny), reposts/shares, the canonical shareUrl, the posted date and the post URN. No campaign or identity is needed — pass any LinkedIn post URL. TWO-STEP CONFIRMATION: a call with `confirm=false` (or omitted) returns the cost vs the current balance and spends nothing; this preview exists so the cost can be shown to the user before the confirming call, `confirm=true` AND `acknowledgedCostCredits=1`. The tool refuses to spend without both.",
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
            "REQUIRED when confirm=true. Must equal the `estimatedCostCredits` from the preview (1).",
          ),
      },
      annotations: {
        title: "Enrich LinkedIn Post By URL",
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
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
      description: `Execute a read-only BigQuery SELECT over the current LGM workspace's activity logs (one row = one timestamped campaign action per lead). Results are automatically restricted to your workspace (userId is not a column). get_bigquery_logs_guide is the authoritative reference (rules, action types, metric definitions, example queries); the rules below are a summary of it.

TABLE: the logical table is named  logs  (bare name, no project/dataset path, no backticks). A lead has many rows, so business metrics use COUNT(DISTINCT leadId).

SERVER-SIDE VALIDATION (a query that breaks these rules is rejected with an explanatory error):
- SELECT only; no *, no DML/DDL, no INFORMATION_SCHEMA.
- A partition filter is required: WHERE date >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY). Column "date" is a DATE (day only); use "createdAt" (TIMESTAMP) only for hour-level delays.
- Rates use SAFE_DIVIDE(...); HAVING contacted_leads >= 30 drops tiny volumes.

COLUMNS: date(DATE), createdAt(TIMESTAMP), type, status ('SUCCESS'|'FAILED'), leadId, campaignId, identityId, stepId, templateId, channel, message.

ACTION TYPES:
- Outbound (require status='SUCCESS'): LINKEDIN_ADD_CONTACT (invitation; counts as a real contact only WITH a note, i.e. templateId IS NOT NULL), LINKEDIN_DIRECT_MESSAGE, LINKEDIN_DIRECT_VOICE, GOOGLE_SEND_EMAIL.
- Replies: LINKEDIN_HAS_REPLY, GOOGLE_REPLY.
- Email engagement: GOOGLE_OPENED (opened), GOOGLE_HAS_CLICKED (clicked), GOOGLE_CHECK_BOUNCE (bounced).
- The *_ON_* types are under-logged and the *_NOT_* / *_NO_REPLY* types are campaign-flow condition checks; neither is a business metric.

VERIFIED METRICS (reference formulas):
- contacted = COUNT(DISTINCT IF(status='SUCCESS' AND ((type='LINKEDIN_ADD_CONTACT' AND templateId IS NOT NULL) OR type IN ('LINKEDIN_DIRECT_MESSAGE','LINKEDIN_DIRECT_VOICE','GOOGLE_SEND_EMAIL')), leadId, NULL))
- replied = COUNT(DISTINCT IF(type IN ('LINKEDIN_HAS_REPLY','GOOGLE_REPLY'), leadId, NULL))
- opened = COUNT(DISTINCT IF(type IN ('GOOGLE_OPENED','GOOGLE_HAS_CLICKED'), leadId, NULL)) (a click implies an open)
- clicked = COUNT(DISTINCT IF(type='GOOGLE_HAS_CLICKED', leadId, NULL))
- bounced = COUNT(DISTINCT IF(type='GOOGLE_CHECK_BOUNCE', leadId, NULL))

get_bigquery_logs_guide has ready-made queries for funnels, reply-time and per-step breakdowns.`,
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
        "Return the full BigQuery logs guide: schema, verified metric definitions, and ready-to-use example queries (funnels, reply-time, per-campaign/step rates). The reference to read before writing non-trivial analytics with ask_your_outbound.",
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

  // Tool: set_lead_status — POST /flow/leads/status, one campaign per call. The endpoint also accepts
  // campaign 'all', deliberately NOT exposed: its per-campaign loop mutates the requested status and
  // returns early on an already-stopped lead, so multi-campaign results are unreliable.
  registerWorkspaceAwareTool(
    server,
    "set_lead_status",
    {
      description:
        "Set a lead's qualification tag in ONE campaign (what users often call the lead's status): " +
        "INTERESTED or CALL_BOOKED (Won), NOT_INTERESTED or WRONG_TARGET (Lost). " +
        "If the lead's sequence is still running in that campaign, it stops: no further message is sent. " +
        "Get leadId from get_audience_leads, and campaignId from get_lead_logs (the lead's campaigns) or list_campaigns. " +
        "If the user reports the outcome of a call for a lead that has an open call task, use complete_call_task instead: " +
        "it records the call and closes the task. " +
        "Confirm intent before calling.",
      inputSchema: {
        leadId: z.string().describe("The lead ID (24-character hex string)"),
        campaignId: z
          .string()
          .describe("The campaign ID (24-character hex string), from get_lead_logs or list_campaigns. One campaign per call."),
        status: z.enum(LEAD_STATUSES).describe("The qualification tag to set"),
      },
      annotations: {
        title: "Set Lead Status",
        readOnlyHint: false,
        destructiveHint: true,
        // Same tag twice = no-op on the API side, so a retry after a timeout is safe.
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
      try {
        const data = await callFlow(
          apiKey,
          "/leads/status",
          { leadId: params.leadId, status: params.status, campaign: params.campaignId },
          // Ending a campaign for a lead queues CRM / Zapier actions in the request.
          { method: "POST", timeout: 30_000 },
        );
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "set_lead_status",
          status: params.status,
        });
        // EMPTY body = the lead's sequence had already ended in that campaign (every retag): the API
        // awaits the tag write BEFORE that early return, so the tag IS applied. Same outcome for the
        // user as a first tag, hence same title and no caveat: every caveat here leaked into answers.
        if (!data) return formatTextContent("Lead Tagged", { tag: params.status });
        const logs = (data as { logs?: unknown[] }).logs;
        if (!Array.isArray(logs) || logs.length === 0) {
          // `logs: []` = no campaign matched the lead: nothing was written.
          return formatTextContent("Lead Tag Not Applied", {
            reason: "this lead is not in this campaign's audience, the campaign is cancelled, or the campaignId / workspace is wrong",
            hint: "get_lead_logs lists the lead's campaigns; confirm the right one with the user before retrying",
          });
        }
        // Same shape as the retag branch: a model compares tool outputs and turns any extra field of the
        // raw payload (leadUpdated, logs…) missing on a retag into a doubt.
        return formatTextContent("Lead Tagged", { tag: params.status, sequenceStopped: true });
      } catch (error) {
        // A timeout or 5xx may land after the tag write; re-calling is safe (see idempotentHint),
        // unlike the generic "re-read the conversation" guidance meant for sends.
        if (error instanceof McpFlowError && (error.statusCode === 408 || error.statusCode >= 500)) {
          const cause = error.statusCode === 408 ? "LGM did not answer in time" : error.message;
          return handleToolError(
            new McpFlowError(`${cause} — calling set_lead_status again with the same values is safe and returns the outcome.`, error.statusCode),
          );
        }
        return handleToolError(error);
      }
    },
  );

  // === Manual tasks (inbox to-do: calls to make, custom messages to write) ===

  // A completed task leaves list_manual_tasks, which is the way to check a completion whose answer
  // was lost (timeout / 5xx). The API refuses a second completion (400 for a call, 404 for a message
  // whose task is gone), but a message may already be on its way: retries: 0 and no blind re-call.
  // A task belongs to one workspace: the API answers "Manual task not found" for a task of another
  // workspace, and a listing without that workspaceId does not show it, hence the workspaceId reminders.
  const handleTaskCompletionError = (error: unknown, taskType: (typeof MANUAL_TASK_TYPES)[number]) => {
    if (error instanceof McpFlowError && error.statusCode === 404 && /manual task/i.test(error.message)) {
      return handleToolError(
        new McpFlowError(
          `${error.message} — use the manualTaskId of an open ${taskType} task from list_manual_tasks, with the same workspaceId as that listing if one was used.`,
          404,
        ),
      );
    }
    if (error instanceof McpFlowError && (error.statusCode === 408 || error.statusCode >= 500)) {
      const cause = error.statusCode === 408 ? "LGM did not answer in time" : error.message;
      return handleToolError(
        new McpFlowError(
          `${cause} — check list_manual_tasks, with the same workspaceId as this call if one was used, before retrying: if the task is no longer listed, it was completed and must not be completed again.`,
          error.statusCode,
        ),
      );
    }
    return handleToolError(error);
  };

  // Tool: list_manual_tasks — GET /flow/manualtasks
  registerWorkspaceAwareTool(
    server,
    "list_manual_tasks",
    {
      description:
        "List the manual tasks waiting for the user in LGM, oldest first: calls to make (type CALL) and custom messages to write " +
        "(type CUSTOM_MESSAGE, a campaign step that waits for a personalised message before it is sent to the lead). " +
        "Each task comes with its manualTaskId, the lead (name, company, job title, phone, company phone, pro email, LinkedIn URL), " +
        "the campaign and, for a message, the channel to write for (LINKEDIN or EMAIL) and inviteNote " +
        "(true = the note of a LinkedIn connection request) with inviteNoteMaxLength, the most characters that note can have " +
        "(set by the LinkedIn account of the identity, e.g. 300 for Premium, 200 otherwise). " +
        "Only tasks of running campaigns are listed; snoozed tasks are not. " +
        "A completed task leaves the list: after completing tasks, list again from skip=0 instead of moving to the next page. " +
        'Examples: "Quels appels dois-je passer ?" → type=CALL; "Which custom messages are waiting for me?" → type=CUSTOM_MESSAGE; ' +
        '"My task for this lead" → leadId; "Tasks of campaign X" → campaignId. ' +
        "Pass the manualTaskId to complete_call_task or complete_message_task.",
      inputSchema: {
        type: z
          .enum(MANUAL_TASK_TYPES)
          .optional()
          .describe("CALL for calls to make, CUSTOM_MESSAGE for messages to write. Omit for both."),
        leadId: z
          .string()
          .optional()
          .describe("Only this lead's tasks (24-character hex lead id, e.g. from get_audience_leads)."),
        campaignId: z
          .string()
          .optional()
          .describe("Only this campaign's tasks (24-character hex campaign id, from list_campaigns)."),
        skip: z
          .number()
          .int()
          .min(0)
          .max(10000)
          .optional()
          .default(0)
          .describe("Number of tasks to skip for pagination (default 0, max 10000)."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .default(25)
          .describe("Maximum number of tasks to return (default 25, max 100). `total` in the response gives the full count."),
      },
      annotations: {
        title: "List Manual Tasks",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
      try {
        const data = await callFlow(apiKey, "/manualtasks", {
          type: params.type,
          leadId: params.leadId,
          campaignId: params.campaignId,
          skip: params.skip,
          limit: params.limit,
        });
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "list_manual_tasks",
        });
        return formatTextContent("Manual Tasks", data);
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // Tool: complete_call_task — POST /flow/manualtasks/call/complete
  registerWorkspaceAwareTool(
    server,
    "complete_call_task",
    {
      description:
        "Complete a call task once the user has called the lead. " +
        "outcome DECISIVE = the user reached the lead: pass the lead's answer as tag (INTERESTED or CALL_BOOKED = Won, " +
        "NOT_INTERESTED or WRONG_TARGET = Lost); its sequence in that campaign stops and the lead is qualified with it " +
        "(on accounts without lead qualification, it goes to To qualify instead). " +
        "outcome UNREACHABLE = the lead could not be reached: the sequence continues with its next step. " +
        "Get manualTaskId from list_manual_tasks (type CALL). " +
        'Examples: "J\'ai eu Jean Dupont, il est intéressé" → DECISIVE + INTERESTED; "Marie ne répond pas" → UNREACHABLE. ' +
        "To tag a lead that has no call task, use set_lead_status. " +
        "A completed task cannot be reopened — confirm the outcome with the user before calling.",
      inputSchema: {
        manualTaskId: z
          .string()
          .describe("The call task id (24-character hex), from list_manual_tasks with type CALL."),
        outcome: z
          .enum(CALL_OUTCOMES)
          .describe("DECISIVE: the user reached the lead (its sequence stops). UNREACHABLE: no answer (its sequence continues)."),
        tag: z
          .enum(LEAD_STATUSES)
          .optional()
          .describe(
            "The lead's answer, required with DECISIVE and not allowed with UNREACHABLE: " +
              "INTERESTED or CALL_BOOKED (Won), NOT_INTERESTED or WRONG_TARGET (Lost).",
          ),
      },
      annotations: {
        title: "Complete Call Task",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
      try {
        if (params.outcome === "DECISIVE" && !params.tag) {
          throw new Error(
            "tag is required with outcome DECISIVE: ask the user for the lead's answer (INTERESTED, CALL_BOOKED, NOT_INTERESTED or WRONG_TARGET).",
          );
        }
        if (params.outcome === "UNREACHABLE" && params.tag) {
          throw new Error("tag only applies to outcome DECISIVE: call again without tag for an unreachable lead.");
        }
        await callFlow(
          apiKey,
          "/manualtasks/call/complete",
          { manualTaskId: params.manualTaskId, callStatus: params.outcome, tag: params.tag },
          { method: "POST", timeout: 30_000, retries: 0 },
        );
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "complete_call_task",
          outcome: params.outcome,
        });
        return formatTextContent("Call Task Completed", {
          outcome: params.outcome,
          leadSequence: params.outcome === "DECISIVE" ? "stopped in this campaign" : "continues with its next step",
        });
      } catch (error) {
        return handleTaskCompletionError(error, "CALL");
      }
    },
  );

  // Tool: complete_message_task — POST /flow/manualtasks/message/complete
  registerWorkspaceAwareTool(
    server,
    "complete_message_task",
    {
      description:
        "Complete a custom-message task by providing the personalised message for its lead: LGM then sends it to the lead " +
        "through the campaign, on the task's channel, at the campaign's next sending slot. " +
        "Get manualTaskId and the channel from list_manual_tasks (type CUSTOM_MESSAGE). " +
        "LINKEDIN task: message is plain text; when inviteNote is true it is the note of the connection request, at most inviteNoteMaxLength characters. " +
        "EMAIL task: message is the HTML body (<p>…</p>, <br>), with an optional subject " +
        "(the step's subject is kept otherwise), cc and bcc. " +
        'Example: "Écris le message perso pour Marie Martin" → draft it from the lead returned by list_manual_tasks, ' +
        "get the user's approval, then call. " +
        "To message a lead outside a campaign step (e.g. a reply in the inbox), use send_linkedin_message or send_email_message. " +
        "This sends a real message to the lead — confirm the exact text with the user before calling.",
      inputSchema: {
        manualTaskId: z
          .string()
          .describe("The custom-message task id (24-character hex), from list_manual_tasks with type CUSTOM_MESSAGE."),
        message: z
          .string()
          .min(1)
          .describe(
            "The message to send: plain text for a LINKEDIN task (at most inviteNoteMaxLength characters for an invite note), HTML body for an EMAIL task.",
          ),
        subject: z
          .string()
          .optional()
          .describe("EMAIL task only: subject line. Omit to keep the step's subject."),
        cc: z.string().optional().describe("EMAIL task only: comma-separated cc addresses."),
        bcc: z.string().optional().describe("EMAIL task only: comma-separated bcc addresses."),
      },
      annotations: {
        title: "Complete Custom Message Task",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
      try {
        await callFlow(
          apiKey,
          "/manualtasks/message/complete",
          {
            manualTaskId: params.manualTaskId,
            message: params.message,
            subject: params.subject,
            cc: params.cc,
            bcc: params.bcc,
          },
          { method: "POST", timeout: 30_000, retries: 0 },
        );
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "complete_message_task",
        });
        return formatTextContent("Custom Message Task Completed", {
          delivery: "sent to the lead by the campaign at its next sending slot",
        });
      } catch (error) {
        return handleTaskCompletionError(error, "CUSTOM_MESSAGE");
      }
    },
  );

  // Tools: call_api_read / call_api_write — generic escape hatch over the DOCUMENTED public API.
  // Allowlist = the generated catalogue (src/flowCatalogue.generated.ts); anything else is rejected
  // locally, without a request. Split by method because the Anthropic directory rejects a single
  // tool mixing safe and unsafe methods (it could not be annotated read-only or destructive).
  const runCallApi = async (
    toolName: string,
    method: string,
    params: { path: string; payload?: Record<string, unknown>; timeoutSeconds?: number; confirm?: boolean },
    extra: { authInfo?: { token?: string } },
  ) => {
    const apiKey = resolveApiKey(extra);
    try {
      const route = resolveCallApiRoute(method, params.path);
      const key = `${route.method} ${route.path}`;
      const consequence = CALL_API_SENSITIVE[key];
      const dedicated = CALL_API_DEDICATED[key];
      if ((consequence || dedicated) && !params.confirm) {
        return formatTextContent(`${method} ${params.path} — ${dedicated ? `use ${dedicated} instead` : "confirmation required"}`, {
          ...(dedicated && {
            dedicatedTool: dedicated,
            nextStep: `Call ${dedicated}. Re-call ${toolName} with confirm=true only if it genuinely lacks a parameter the user needs.`,
          }),
          ...(consequence && {
            consequence,
            beforeConfirm: "Surface the consequence to the user and get explicit approval before re-calling with confirm=true.",
          }),
        });
      }
      if (route.path === "/leads/status") assertLeadStatusBody(params.payload);
      const data = await callFlow(apiKey, params.path, params.payload, {
        method,
        timeout: params.timeoutSeconds ? params.timeoutSeconds * 1000 : CALL_API_SLOW.has(key) ? 120_000 : undefined,
      });
      await trackMcpEvent(apiKey, "mcp_tool_called", {
        toolName,
        method,
        // Template path (e.g. /campaigns/:campaignId/stats), never the concrete ids.
        path: route.path,
      });
      return formatTextContent(`${method} ${params.path}`, data);
    } catch (error) {
      return handleToolError(error);
    }
  };

  const CALL_API_DOC = "https://documenter.getpostman.com/view/32966764/2sBXqFM2Vv";
  const callApiPathSchema = z
    .string()
    .describe("Endpoint path relative to /flow, with real ids in place of the :params of the catalogue (e.g. /campaigns/64f0c2a1b3d4e5f6a7b8c9d0/statsleads)");

  registerWorkspaceAwareTool(
    server,
    "call_api_read",
    {
      description:
        `Reads any GET endpoint of the documented LGM public API (${CALL_API_DOC}) that no dedicated tool covers — e.g. one campaign's ` +
        "full detail, or per-lead stats of a campaign over a date range. Only the GET endpoints listed below are accepted; any other path " +
        "is rejected without a request. An endpoint marked [dedicated tool: X] is served by X: the first call returns X's name instead of " +
        "data, and confirm=true reads it here anyway. To create, update or delete, see call_api_write.\n\nAvailable endpoints:\n" +
        buildCatalogueText(true),
      inputSchema: {
        path: callApiPathSchema,
        // Zod 4: z.record needs both key and value schemas (the 1-arg form throws at load time).
        query: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe("Query string parameters, named as listed per endpoint in the catalogue"),
        timeoutSeconds: z.number().int().min(1).max(120).optional().describe("Request timeout in seconds (default 10)"),
        confirm: z
          .boolean()
          .optional()
          .describe("true reads an endpoint marked [dedicated tool: X] here anyway, when X lacks a parameter the user needs. Default false"),
      },
      annotations: {
        title: "Read LGM API",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ query, ...params }, extra) => runCallApi("call_api_read", "GET", { ...params, payload: query }, extra),
  );

  registerWorkspaceAwareTool(
    server,
    "call_api_write",
    {
      description:
        `Calls any POST or DELETE endpoint of the documented LGM public API (${CALL_API_DOC}) that no dedicated tool covers — e.g. create ` +
        "an empty audience, remove a lead from audiences, edit an inbox conversation note. Modifies data in the user's LGM account. " +
        "Only the endpoints listed below are accepted; any other path or method is rejected without a request. An endpoint marked " +
        "[requires confirm=true] has an irreversible or outbound effect (spends credits, sends a real message, ends a lead's campaign, " +
        "forwards inbox messages to a URL): the first call returns that consequence without acting, and confirm=true performs it. " +
        "An endpoint marked [dedicated tool: X] is served by X: the first call returns X's name without acting, and confirm=true " +
        "performs it here anyway. To read, see call_api_read. Confirm intent with the user before calling.\n\nAvailable endpoints:\n" +
        buildCatalogueText(false),
      inputSchema: {
        method: z.enum(["POST", "DELETE"]).describe("HTTP method of the endpoint, as listed in the catalogue"),
        path: callApiPathSchema,
        body: z.record(z.string(), z.unknown()).optional().describe("JSON body, with the parameters listed per endpoint in the catalogue"),
        timeoutSeconds: z
          .number()
          .int()
          .min(1)
          .max(120)
          .optional()
          .describe("Request timeout in seconds (default 10; 120 on sends, campaign status and lead status)"),
        confirm: z
          .boolean()
          .optional()
          .describe(
            "true performs an endpoint marked [requires confirm=true] once the user approved the consequence returned by the first call, " +
              "or an endpoint marked [dedicated tool: X] when X lacks a parameter the user needs. Default false",
          ),
      },
      annotations: {
        title: "Write to LGM API",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        // Some catalogue routes send a real LinkedIn message or email, or forward messages to a URL.
        openWorldHint: true,
      },
    },
    async ({ method, body, ...params }, extra) => runCallApi("call_api_write", method, { ...params, payload: body }, extra),
  );
};
