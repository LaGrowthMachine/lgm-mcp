# La Growth Machine MCP server: LinkedIn and email outreach from Claude

Connect La Growth Machine (LGM), the multichannel sales outreach platform, to Claude, ChatGPT, Cursor or Claude Code. Build audiences from Sales Navigator, write and edit campaign sequences, clear your LinkedIn and email inbox, and measure which campaigns turn replies into meetings and pipeline. Built for GTM engineers, RevOps, sales managers and SDR teams.

**Reads and writes.** Read tools run without confirmation. Every write (sending a message, editing a campaign, spending credits) asks you first.

[Add to Claude](https://claude.ai/customize/connectors) · [Help center](https://help.lagrowthmachine.com?utm_source=claude&utm_medium=mcp&utm_campaign=claude-store) · [Privacy policy](https://lagrowthmachine.com/privacy-policy?utm_source=claude&utm_medium=mcp&utm_campaign=claude-store) · [LGM Skills](https://github.com/laGrowthMachine/gtm-system)

## What you can ask Claude

**Build audiences and leads**
- "Create an audience called 'DACH VPs of Sales' from this Sales Navigator search URL, using my main LinkedIn identity."
- "Import everyone who commented on this LinkedIn post into a new audience."
- "Add this LinkedIn profile as a lead in the 'Q4 partners' audience with a note about our last call."
- "Find a pro email for Marie Dupont at Acme." (credit cost is shown and confirmed before spending)

**Write and manage campaigns**
- "Duplicate 'VP Sales Q2', rename it 'VP Sales Q3' and assign the new audience."
- "Show me the sequence of 'DACH Enterprise' and rewrite step 3 so it is shorter and ends with a question."
- "Turn on HubSpot sync and skip already-contacted leads on this campaign, then resume it."

**Handle replies**
- "Which conversations are waiting for my reply? Draft an answer for each."
- "Send a LinkedIn voice message to John Smith from my main identity."
- "Snooze every 'not now' conversation for two weeks and archive the out-of-office ones."
- "Which calls do I have to make? I just reached Jean Dupont, he's interested — close his call task."

**Analyze performance**
- "Compare reply rates and conversions across my running campaigns and flag anything under 10% acceptance."
- "Which step of 'DACH Enterprise' loses the most leads?"
- "Give me the reply rate per step and per channel for the last 30 days." (read-only SQL over your activity logs)

## Who it is for

- **GTM and growth engineers, RevOps**: you run the outbound stack (Clay, HubSpot, La Growth Machine) and want campaign data and actions in the same chat as the rest of your tooling.
- **Heads of sales and team leads**: pipeline contribution per campaign without opening a dashboard.
- **SDRs and AEs**: one place to handle LinkedIn and email conversations and follow-ups.

## Go deeper with LGM Skills

The MCP gives Claude your data. [LGM Skills](https://github.com/laGrowthMachine/gtm-system) give it the method. **Campaign Analyzer** pulls stats and sequences through this MCP and returns prioritised fixes (weak steps, missing follow-ups, targeting mismatches). Segmentation Advisor and Copywriting Coach are next.

> "Analyze my 'VP Sales Q2' campaign and tell me what to improve."

## Tools

### Read (no confirmation needed)

| Tool | Description |
|------|-------------|
| `list_campaigns` | List outreach campaigns, filter by status, name or date |
| `list_public_campaigns` | Public campaign templates to copy, useful when you have no campaigns yet |
| `get_campaign_stats` | Leads contacted, acceptance rate, reply rate, conversions |
| `get_campaign_messages` | Full message sequence with content, channel and step order |
| `get_campaign_steps` | Campaign steps with stepId, channel, order, message attached or not |
| `list_audiences` | Every audience with id, name and lead count |
| `get_audience` | Audience name, size, type and import status |
| `get_audience_leads` | Full lead records: contact, company, role, LinkedIn URL, enrichment and email status, custom attributes |
| `get_lead_logs` | Activity history of a lead across LinkedIn and email |
| `get_lead_conversations` | All conversation threads with a lead |
| `get_conversation_messages` | Complete message thread of a conversation |
| `get_conversations_to_reply` | Inbox conversations waiting for your reply |
| `get_unread_conversations` | Unread inbox conversations, newest first |
| `get_favourite_conversations` | Starred conversations, optionally only those that replied |
| `list_manual_tasks` | Calls to make and custom messages to write, oldest first, with the lead's contact details |
| `search_conversations` | Inbox search by text, identity, campaign, audience, channel, status, dates, flags |
| `list_identities` | Connected LinkedIn and email identities |
| `list_members` | Account members (memberId for LinkedIn sends) |
| `list_workspaces` | Workspaces you can act in |
| `get_credits` | Credit balance (total and perishable) |
| `get_enrich_result` | Result of an enrichment request |
| `get_bigquery_logs_guide` | Schema, metric definitions and example queries for `ask_your_outbound` |
| `ask_your_outbound` | Read-only SQL over your activity logs: funnels, reply rates, per-step breakdowns |

### Write (Claude asks before acting)

| Tool | Description |
|------|-------------|
| `create_audience_from_linkedin_url` | Create or fill an audience from a Sales Navigator search, LinkedIn search, post or event URL |
| `create_lead` | Create or update a lead, attach it to an audience, set custom attributes and notes |
| `enrich_lead` | Find a pro email or phone number, or refresh LinkedIn fields; cost previewed, then confirmed |
| `enrich_linkedin_post` | Fetch a public LinkedIn post's text, author and engagement (1 credit, confirmed first) |
| `duplicate_campaign` | Copy a campaign and its sequence into a new draft |
| `rename_campaign` | Rename a campaign |
| `set_campaign_audience` | Assign or change the audience of a not-yet-started campaign |
| `set_campaign_identity` | Change the identity (LinkedIn account and email sender) of a not-yet-launched campaign |
| `edit_campaign_message` | Replace the content (and subject) of a campaign step |
| `add_campaign_step_message` | Create a message and link it to an empty step |
| `set_campaign_setting` | Enable or disable `autoEnrich`, `outOfOffice`, `skipAlreadyContacted` or `ignoreEmojiOnlyReplies` (the last two need a READY or PAUSED campaign) |
| `set_campaign_crm_sync` | Enable or disable HubSpot / Pipedrive sync on a paused campaign |
| `pause_campaign` | Pause a running campaign; pending actions wait until resumed |
| `resume_campaign` | Resume a paused campaign where each lead stopped |
| `launch_campaign` | Launch a draft campaign; refused with the reasons when something is missing (audience, step content, sender email address, LinkedIn connection) or a plan limit is reached |
| `send_linkedin_message` | Send a LinkedIn text or voice message from a connected identity |
| `send_email_message` | Send an email from a connected email identity (new thread or reply) |
| `snooze_conversation` / `unsnooze_conversation` | Hide a conversation until later, or bring it back |
| `archive_conversation` / `unarchive_conversation` | Remove a conversation from the active inbox, or restore it |
| `save_identity_preference` | Save tone, language and style per identity for AI-written messages |
| `set_lead_status` | Set a lead's qualification tag in one campaign (Interested, Not interested, Wrong target, Call booked) — stops the lead's sequence in that campaign if it is still running |
| `complete_call_task` | Complete a call task: decisive with the lead's answer (stops the lead's sequence) or unreachable (the sequence continues) |
| `complete_message_task` | Complete a custom-message task with your LinkedIn or email message; the campaign sends it to the lead |
| `call_api_read` | Last resort: read any documented GET endpoint of the LGM public API that no dedicated tool covers — a route a dedicated tool covers first points to that tool, confirm=true calls it anyway (allowlist = the public doc) |
| `call_api_write` | Last resort: call any documented POST / DELETE endpoint of the LGM public API that no dedicated tool covers — a route a dedicated tool covers first points to that tool, confirm=true calls it anyway (allowlist = the public doc; endpoints that spend credits, send messages, end a lead's campaign or manage inbox webhooks require `confirm=true` after user approval) |

## Setup

### Claude.ai, Claude Desktop, mobile (recommended)

1. Go to **Customize > Connectors** in Claude and search "La Growth Machine" in the connectors directory.
2. Click **Connect**, approve the connection on LGM, and you are back in Claude. No API key to copy.

### Claude Code, Cursor, Windsurf and other MCP clients

```bash
claude mcp add --transport http --scope user LaGrowthMachine https://mcp.lagrowthmachine.com/mcp
```

Claude Code opens the LGM approval page in your browser on first use (OAuth). Clients without OAuth can pass an API key from [Settings > API](https://app.lagrowthmachine.com/settings/integrations/api):

```bash
claude mcp add --transport http --scope user LaGrowthMachine \
  https://mcp.lagrowthmachine.com/mcp \
  --header "X-LGM-API-KEY: <your-api-key>"
```

Replace `claude mcp add` with your client's equivalent command.

### ChatGPT

1. **Settings > Apps** (developer mode must be enabled by a workspace admin on Business or Enterprise plans).
2. Add an app with the URL `https://mcp.lagrowthmachine.com/mcp` and **OAuth** authentication.
3. Click **Connect** and approve on LGM.

### Claude Desktop extension (.mcpb, API key)

1. Download `lgm-mcp.mcpb` from the [latest release](https://github.com/LaGrowthMachine/lgm-mcp/releases/latest).
2. Double-click to open with Claude Desktop, click **Install**.
3. Paste your LGM API key from [Settings > API](https://app.lagrowthmachine.com/settings/api?utm_source=claude&utm_medium=mcp&utm_campaign=claude-store). The key is stored in the OS keychain.

## FAQ

**Does La Growth Machine have an MCP server?**
Yes. This is the official, open-source (Apache 2.0) MCP server, listed in the Claude connectors directory and usable with any MCP client.

**Can Claude send LinkedIn messages or emails through La Growth Machine?**
Yes, from any identity connected to your LGM account, text or voice on LinkedIn, new thread or reply by email. Claude asks for confirmation before every send.

**Can I create a campaign from scratch?**
Today Claude duplicates an existing campaign, then edits its steps, audience and settings. Creating from a blank sequence is on the roadmap.

**Does it work with HubSpot or Pipedrive?**
Yes. Claude can enable or disable CRM sync per campaign. Deals and contacts stay in your CRM; LGM pushes outreach activity to it.

**Is it free?**
The server is free and open source. You need an active La Growth Machine workspace. Enrichment tools spend LGM credits and always preview the cost first.

**What data leaves my account?**
Your data goes only to your AI client during the conversation. The server sends one first-party analytics event per tool call (tool name only, no content). See Privacy below.

## Privacy

This connector calls the [La Growth Machine](https://lagrowthmachine.com?utm_source=claude&utm_medium=mcp&utm_campaign=claude-store) API on your behalf, over OAuth or your API key. Data is fetched on demand and used only inside your AI conversation. Nothing is stored beyond your credentials (OS keychain for the desktop extension). Your data is not shared with any third party.

Full policy: [lagrowthmachine.com/privacy-policy](https://lagrowthmachine.com/privacy-policy?utm_source=claude&utm_medium=mcp&utm_campaign=claude-store)

### Usage analytics and opt-out

On each tool call the server sends one first-party event to `https://apiv2.lagrowthmachine.com/flow/tracking/mcp`: the event name (`mcp_tool_called`, or `mcp_preference_saved` for `save_identity_preference`) and the tool name. No conversation content, lead data, message bodies or arguments. The request is fire-and-forget and never blocks a result.

Opt out: enable **"Disable usage analytics"** in the extension settings, or set `LGM_DISABLE_TELEMETRY=true` for self-hosted and other clients.

## Support

- Help center: [help.lagrowthmachine.com](https://help.lagrowthmachine.com?utm_source=claude&utm_medium=mcp&utm_campaign=claude-store)
- Issues: [github.com/LaGrowthMachine/lgm-mcp/issues](https://github.com/LaGrowthMachine/lgm-mcp/issues)

## License

Apache 2.0, see [LICENSE](LICENSE). Copyright 2026 La Growth Machine.
