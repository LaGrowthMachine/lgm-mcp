/*
 * Copyright 2026 La Growth Machine
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */
import axios from "axios";
import { seal, open } from "./tokens";

/**
 * Dynamic Client Registration (RFC 7591) sans store : le `client_id` EST un blob signé (enveloppe
 * `client`) qui emballe les `redirect_uris` autorisés du client. /authorize re-valide alors le
 * `redirect_uri` reçu contre ce blob — aucune persistance, multi-replica safe.
 */
export interface ClientRegistrationPayload {
    redirectUris: string[];
    // Nom auto-déclaré au /register (RFC 7591, ex: "Claude", "Codex", "ChatGPT"). Signal ANALYTICS
    // uniquement (spoofable) — jamais utilisé pour une décision de sécurité, l'allowlist des
    // redirect_uris reste le seul garde-fou. Absent sur les client_id émis avant cet ajout.
    clientName?: string;
}

// Le client_id est durable (Claude le réutilise longtemps) ; on lui donne une longue durée de vie.
const CLIENT_ID_TTL_SECONDS = 60 * 60 * 24 * 365 * 5; // 5 ans

/**
 * Allowlist des redirect_uri acceptés à l'enregistrement (DCR). C'est le CONTRÔLE ANTI-PHISHING
 * PRIMAIRE du flux de consentement : l'écran de consentement back ne peut PAS afficher d'identité
 * client vérifiée (l'authstate est opaque pour lgm-apis), donc un redirect attaquant accepté ici
 * permettrait, via un lien envoyé à une victime loggée, de capter SON secret par-connecteur (prise
 * de compte). On NE valide JAMAIS « tout https » par défaut.
 *
 * Approche « domaines connus » : on allowliste les HOSTNAMES des éditeurs de clients qu'on décide de
 * supporter (Claude, ChatGPT, …), pas des URLs exactes — robuste aux changements de chemin de
 * redirect. Configurée par l'env `OAUTH_ALLOWED_REDIRECT_HOSTS` (hostnames séparés par des virgules,
 * ex: `claude.ai,chatgpt.com`). Un redirect passe s'il est en https ET que son hostname égale, ou est
 * un sous-domaine d', un host autorisé. Le host exact d'un nouvel éditeur se lit dans les LOGS PROD
 * (oauth.ts logge le redirect réel au premier /authorize).
 *
 * FAIL-CLOSED : sans hosts configurés, seuls localhost/127.0.0.1 (http, dev) passent ; tout redirect
 * distant est refusé. Le flux DCR reste donc inerte en prod jusqu'à configuration — volontaire
 * (impossible d'« oublier » de durcir avant le flip).
 */
const allowedHosts = (): string[] =>
    (process.env.OAUTH_ALLOWED_REDIRECT_HOSTS || "")
        .split(",")
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean);

const hostnameMatches = (hostname: string, allowedHost: string): boolean =>
    hostname === allowedHost || hostname.endsWith(`.${allowedHost}`);

export const isAllowedRedirectUri = (uri: string): boolean => {
    let url: URL;
    try {
        url = new URL(uri);
    } catch {
        return false;
    }
    // localhost/127.0.0.1 en http : toujours OK (dev), sans configuration.
    if (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) {
        return true;
    }
    if (url.protocol !== "https:") {
        return false;
    }
    const hostname = url.hostname.toLowerCase();
    return allowedHosts().some((allowedHost) => hostnameMatches(hostname, allowedHost));
};

const CLIENT_NAME_MAX_LENGTH = 60;

/** Scelle les redirect_uris validés (+ client_name déclaratif) en un client_id durable. Renvoie null si aucune URI valide. */
export const issueClientId = (redirectUris: string[], clientName?: string): string | null => {
    const validUris = redirectUris.filter(isAllowedRedirectUri);
    if (validUris.length === 0) return null;
    const sanitizedClientName = clientName?.trim().slice(0, CLIENT_NAME_MAX_LENGTH) || undefined;
    return seal<ClientRegistrationPayload>(
        "client",
        { redirectUris: validUris, clientName: sanitizedClientName },
        CLIENT_ID_TTL_SECONDS,
    );
};

/** Ouvre un client_id ; null si falsifié/expiré/format invalide. */
export const parseClientId = (clientId: string): ClientRegistrationPayload | null =>
    open<ClientRegistrationPayload>(clientId, "client");

const isLoopback = (url: URL): boolean =>
    url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");

/**
 * Un redirect_uri présenté à /authorize correspond à un redirect enregistré s'il est identique, OU
 * si les deux sont des loopbacks http de même chemin : les CLI (Claude Code, Codex) enregistrent
 * `http://localhost/callback` sans port et écoutent sur un port éphémère (RFC 8252 §7.3).
 */
export const redirectUriMatches = (registered: string, actual: string): boolean => {
    if (registered === actual) return true;
    try {
        const a = new URL(registered);
        const b = new URL(actual);
        return isLoopback(a) && isLoopback(b) && a.hostname === b.hostname && a.pathname === b.pathname;
    } catch {
        return false;
    }
};

/** Le redirect_uri présenté à /authorize doit appartenir au blob signé du client_id. */
export const clientAllowsRedirectUri = (clientId: string, redirectUri: string): boolean => {
    const registration = parseClientId(clientId);
    if (!registration) return false;
    return registration.redirectUris.some((uri) => redirectUriMatches(uri, redirectUri));
};

/**
 * Client ID Metadata Document (CIMD, draft-ietf-oauth-client-id-metadata-document) : le client_id
 * EST une URL https qui sert un JSON `{ client_id, client_name, redirect_uris, ... }`. Recommandé
 * par Claude et ChatGPT à la place du DCR (un client stable au lieu d'un enregistrement par
 * connexion). Ex: https://chatgpt.com/oauth/client.json, https://claude.ai/oauth/claude-code-client-metadata.
 *
 * Même garde-fou anti-phishing que le DCR : on ne FETCHE le document que si le host du client_id est
 * dans OAUTH_ALLOWED_REDIRECT_HOSTS (sinon n'importe quelle URL nous ferait faire des requêtes
 * sortantes = SSRF), et chaque redirect_uri du document repasse par isAllowedRedirectUri.
 */
export const isClientIdMetadataUrl = (clientId: string): boolean => {
    try {
        const url = new URL(clientId);
        return url.protocol === "https:" && url.hostname !== "localhost";
    } catch {
        return false;
    }
};

// Fetch à chaque /authorize (1 requête par consentement humain, pas par appel de tool) : pas de
// cache tant que le volume ne le justifie pas.
export const fetchClientIdMetadata = async (clientId: string): Promise<ClientRegistrationPayload | null> => {
    let url: URL;
    try {
        url = new URL(clientId);
    } catch {
        return null;
    }
    const hostname = url.hostname.toLowerCase();
    if (!allowedHosts().some((allowedHost) => hostnameMatches(hostname, allowedHost))) return null;
    try {
        const response = await axios.get(clientId, {
            timeout: 5_000,
            maxContentLength: 64 * 1024,
            maxRedirects: 0,
            headers: { Accept: "application/json" },
            validateStatus: () => true,
        });
        if (response.status !== 200 || !response.data || typeof response.data !== "object") return null;
        const doc = response.data as { client_id?: unknown; client_name?: unknown; redirect_uris?: unknown };
        // Le document doit se désigner lui-même (protège contre un JSON arbitraire servi sur le host).
        if (doc.client_id !== clientId) return null;
        const redirectUris = Array.isArray(doc.redirect_uris)
            ? doc.redirect_uris.filter((uri): uri is string => typeof uri === "string" && isAllowedRedirectUri(uri))
            : [];
        if (redirectUris.length === 0) return null;
        return {
            redirectUris,
            clientName: typeof doc.client_name === "string" ? doc.client_name.trim().slice(0, CLIENT_NAME_MAX_LENGTH) : undefined,
        };
    } catch {
        return null;
    }
};
