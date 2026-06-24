/*
 * Copyright 2026 La Growth Machine
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from './tools';

export const createMcpServer = (): McpServer => {
    const server = new McpServer(
        {
            name: 'lgm',
            version: '1.0.0',
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
For example: "Montre-moi mes campagnes" means list_campaigns, "Mes leads" means get_audience_leads, "Les stats de ma campagne" means get_campaign_stats.
To create an audience from a LinkedIn / Sales Navigator search URL or a LinkedIn post URL (e.g. "Crée une audience depuis cette URL Sales Nav", "Import these LinkedIn leads into an audience"), call create_audience_from_linkedin_url. If the user hasn't provided an identityId, call list_identities first to find it (e.g. "Liste mes identités", "Which LinkedIn accounts do I have connected?").
For the inbox: "Les conversations à répondre", "Who do I need to reply to?" means get_conversations_to_reply; "Mes conversations non lues" means get_unread_conversations; "Mes favoris" means get_favourite_conversations; any other inbox filtering ("Cherche la conversation où on parlait d'Acme", by campaign/date/channel) means search_conversations. These return conversation ids only — use get_conversation_messages for the thread.
To act on a conversation: "Snooze cette conversation jusqu'à lundi" means snooze_conversation; "Réactive / un-snooze" means unsnooze_conversation; "Archive ce fil" means archive_conversation; "Désarchive" means unarchive_conversation. Each is identified by conversationId, or the lead's linkedinUrl or email.
To send a message: "Réponds à ce lead sur LinkedIn …" means send_linkedin_message (needs identityId from list_identities and memberId from list_members); "Envoie un email à ce lead …" means send_email_message (needs identityId, html + text body, and a lead via leadId or leadEmail). These actually send — confirm intent before calling.
Workspaces: almost every account has a SINGLE workspace — never pass workspaceId and ignore the feature. Only when the user mentions several workspaces (agencies, multi-brand) call list_workspaces; if it returns multiWorkspace=true you may set workspaceId (a value from that list) on any tool to act inside the chosen workspace.`,
        },
    );

    registerTools(server);

    return server;
};
