/*
 * Copyright 2026 La Growth Machine
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */
/**
 * Charges utiles typées des enveloppes OAuth self-encodées (cf. tokens.ts) et leurs durées de vie.
 *
 * Le secret par-connecteur `lgmc_` (résolu à l'exchange du linking_code côté lgm-apis) est emballé
 * dans `code`/`at`/`rt` et ne quitte JAMAIS le serveur MCP : Claude ne détient que des enveloppes
 * chiffrées. Le workspace ciblé n'est jamais dans le token (c'est un param runtime, header).
 */

/** access_token (`at`) — emballe le secret par-connecteur résolu à l'exchange. */
export interface AccessTokenPayload {
    secret: string;
    aud?: string;
}

/** refresh_token (`rt`) — réémet des `at`/`rt` sans relancer tout le handshake. */
export interface RefreshTokenPayload {
    secret: string;
}

/**
 * code d'autorisation (`code`) émis à Claude au retour du consentement. Emballe le secret +
 * le code_challenge PKCE (vérifié à /token) + le redirect_uri de Claude (re-vérifié à /token).
 */
export interface AuthCodePayload {
    secret: string;
    codeChallenge?: string;
    codeChallengeMethod?: string;
    redirectUri: string;
}

/**
 * État porté à travers le bounce de consentement back (`authstate`). Contient tout ce qu'il faut
 * pour, au retour, émettre le `code` vers Claude : son redirect_uri, son state, et le PKCE — ce
 * dernier DOIT survivre tout le trajet authstate → code → /token (sinon PKCE cassé).
 */
export interface AuthStatePayload {
    redirectUri: string;
    state?: string;
    codeChallenge?: string;
    codeChallengeMethod?: string;
    resource?: string;
    clientId?: string;
}

// access_token court (le vrai garde-fou de révocation est par-connecteur côté API) ; refresh long.
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60 * 24; // 24h
export const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 365; // 1 an
export const AUTH_CODE_TTL_SECONDS = 60; // one-shot, échangé immédiatement par Claude
export const AUTH_STATE_TTL_SECONDS = 60 * 10; // le temps du consentement utilisateur
