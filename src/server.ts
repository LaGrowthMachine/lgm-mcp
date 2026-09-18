/*
 * Copyright 2026 La Growth Machine
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */
import { VERSION as version } from "./version";
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from './tools';

export const createMcpServer = (): McpServer => {
    const server = new McpServer(
        {
            name: 'lgm',
            version,
            // Métadonnées affichées par le client (Claude, ChatGPT…) pour le connecteur. `icons` est
            // le mécanisme MCP pour exposer le logo du serveur (réponse `initialize`).
            title: 'La Growth Machine',
            websiteUrl: 'https://lagrowthmachine.com',
            icons: [
                { src: 'https://app.lagrowthmachine.com/favicon.svg', mimeType: 'image/svg+xml', sizes: ['any'] },
                { src: 'https://app.lagrowthmachine.com/favicon.png', mimeType: 'image/png' },
            ],
        },
        {
            instructions: `You are connected to LaGrowthMachine (LGM), a multichannel sales outreach platform.
Use LGM tools whenever the user mentions campaigns, leads, audiences, outreach, prospecting, sequences, or conversations — even without explicitly saying "LGM".
For example: "Montre-moi mes campagnes" means list_campaigns, "Mes leads" means get_audience_leads, "Les stats de ma campagne" means get_campaign_stats, "Mes audiences" / "Which audiences do I have?" means list_audiences.
To create an audience from a LinkedIn / Sales Navigator search URL or a LinkedIn post URL (e.g. "Crée une audience depuis cette URL Sales Nav", "Import these LinkedIn leads into an audience"), call create_audience_from_linkedin_url. If the user hasn't provided an identityId, call list_identities first to find it (e.g. "Liste mes identités", "Which LinkedIn accounts do I have connected?").
To create or update a single lead (e.g. "Ajoute ce contact à l'audience X", "Push this LinkedIn profile as a lead", "Update John Doe's job title", "Crée un lead pour ..."), call create_lead. At least one identifier is required (leadId / proEmail / persoEmail / linkedinUrl / twitter, or firstname+lastname+company). Attach it to an audience via the optional 'audience' name.
Credit balance: "Combien de crédits ?", "How many credits do I have?" → get_credits.
Enrichment: "Enrichis ce lead", "Find his pro email", "Refresh LinkedIn data for X" → enrich_lead. THIS SPENDS CREDITS via a mandatory two-step lockstep: (1) call with confirm=false to see estimated cost vs balance; (2) present the cost to the user and get explicit approval; (3) re-call with confirm=true AND acknowledgedCostCredits=exact-preview-value. The tool REFUSES to spend otherwise. After starting an enrichment, retrieve its result with get_enrich_result using the returned enrichRequestId.
For the inbox: "Les conversations à répondre", "Who do I need to reply to?" means get_conversations_to_reply; "Mes conversations non lues" means get_unread_conversations; "Mes favoris" means get_favourite_conversations; any other inbox filtering ("Cherche la conversation où on parlait d'Acme", by campaign/date/channel) means search_conversations. These return conversation ids only — use get_conversation_messages for the thread.
To act on a conversation: "Snooze cette conversation jusqu'à lundi" means snooze_conversation; "Réactive / un-snooze" means unsnooze_conversation; "Archive ce fil" means archive_conversation; "Désarchive" means unarchive_conversation. Each is identified by conversationId, or the lead's linkedinUrl or email.
To send a message: "Réponds à ce lead sur LinkedIn …" means send_linkedin_message (needs identityId from list_identities and memberId from list_members); "Envoie un email à ce lead …" means send_email_message (needs identityId, html + text body, and a lead via leadId or leadEmail). These actually send — confirm intent before calling.
To read or analyze a LinkedIn post from its URL (e.g. "Que dit ce post ?", "How did this LinkedIn post perform?", "Résume ce post"), call enrich_linkedin_post with the pasted URL — it returns the text, author and reaction counts. THIS SPENDS 1 CREDIT: same lockstep as enrich_lead (confirm=false preview → user approval → confirm=true AND acknowledgedCostCredits=1).
Workspaces: almost every account has a SINGLE workspace — never pass workspaceId and ignore the feature. Only when the user mentions several workspaces (agencies, multi-brand) call list_workspaces; if it returns multiWorkspace=true you may set workspaceId (a value from that list) on any tool to act inside the chosen workspace.
To duplicate a campaign ("Duplique cette campagne", "Clone this campaign"), call duplicate_campaign with the campaignId from list_campaigns — it copies the sequence and every step template into a new draft campaign.
To rewrite a campaign's messages ("Modifie / réécris le message de cette brique", "Change the email of step 2", "Adapte les templates de la campagne"), first call get_campaign_messages to get each step's templateId, then call edit_campaign_message (campaignId + templateId + newHtml, plus subjectNewHtml for emails) to replace the content. A common flow is duplicate_campaign then edit_campaign_message on each step. This modifies the campaign — confirm intent before calling.
To inspect a campaign's sequence structure ("Quelles sont les étapes de la campagne ?", "Show me the steps", "Which steps have no message yet?"), call get_campaign_steps — it lists each message-bearing step with its stepId, channel, order, and whether a message is already attached (hasMessage / templateId).
To add a message to a step that doesn't have one yet ("Ajoute un message à cette étape", "Write the LinkedIn message for step 3", "Remplis les briques vides de la campagne"), call get_campaign_steps first to find the stepId of an empty step (hasMessage=false), then call add_campaign_step_message (campaignId + stepId + newHtml, plus subjectNewHtml for emails) — it creates the message and links it to that step. For a step that ALREADY has a message use edit_campaign_message instead. This modifies the campaign — confirm intent before calling.
To edit a campaign's basic settings, use the atomic tools with the campaignId from list_campaigns: "Renomme cette campagne" / "Rename this campaign" → rename_campaign; "Change l'audience de la campagne" / "Set the audience" (campaign not started yet) → set_campaign_audience with an audienceId from list_audiences; "Active / désactive l'auto-enrichissement" / "Turn auto-enrich on/off" → set_campaign_auto_enrich; "Active / désactive le mode absence (OOO)" / "Enable out-of-office rescheduling" → set_campaign_out_of_office; "Active / désactive la synchro CRM HubSpot/Pipedrive" / "Sync this campaign with my CRM" → set_campaign_crm_sync (campaign must be paused, requires the CRM plan); "Active / désactive skip already contacted" / "Skip already-contacted leads" → set_campaign_skip_rules. These modify the campaign — confirm intent before calling.
To pause or resume a campaign ("Mets cette campagne en pause" / "Pause this campaign" → pause_campaign; "Reprends / relance cette campagne" / "Resume this campaign" → resume_campaign), use the campaignId from list_campaigns. Only a RUNNING campaign can be paused and only a PAUSED one resumed — a READY campaign that was never launched must be launched from the LGM app. If pause_campaign times out, the pause has almost certainly been applied: check the status with list_campaigns instead of calling it again. Editing a paused campaign (messages or settings) is NOT retroactive: nothing is replayed for leads who already went through a step, the changes only apply to actions still pending once resumed — say so to the user when they edit a paused campaign. These modify the campaign — confirm intent before calling.`,
        },
    );

    registerTools(server);

    return server;
};
