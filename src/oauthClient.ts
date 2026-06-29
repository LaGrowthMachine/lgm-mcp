/*
 * Copyright 2026 La Growth Machine
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */
import { seal, open } from "./tokens";

/**
 * Dynamic Client Registration (RFC 7591) sans store : le `client_id` EST un blob signé (enveloppe
 * `client`) qui emballe les `redirect_uris` autorisés du client. /authorize re-valide alors le
 * `redirect_uri` reçu contre ce blob — aucune persistance, multi-replica safe.
 */
export interface ClientRegistrationPayload {
    redirectUris: string[];
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

/** Scelle les redirect_uris validés en un client_id durable. Renvoie null si aucune URI valide. */
export const issueClientId = (redirectUris: string[]): string | null => {
    const validUris = redirectUris.filter(isAllowedRedirectUri);
    if (validUris.length === 0) return null;
    return seal<ClientRegistrationPayload>("client", { redirectUris: validUris }, CLIENT_ID_TTL_SECONDS);
};

/** Ouvre un client_id ; null si falsifié/expiré/format invalide. */
export const parseClientId = (clientId: string): ClientRegistrationPayload | null =>
    open<ClientRegistrationPayload>(clientId, "client");

/** Le redirect_uri présenté à /authorize doit appartenir au blob signé du client_id. */
export const clientAllowsRedirectUri = (clientId: string, redirectUri: string): boolean => {
    const registration = parseClientId(clientId);
    if (!registration) return false;
    return registration.redirectUris.includes(redirectUri);
};
