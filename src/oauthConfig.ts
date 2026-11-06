/*
 * Copyright 2026 La Growth Machine
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

/** URL publique canonique du serveur (issuer OAuth, ressource protégée). */
export const getBase = (): string => process.env.MCP_BASE_URL || "https://mcp.lagrowthmachine.com";

/**
 * Scopes annoncés. Ils ne segmentent PAS les droits (un connecteur = le compte LGM entier) :
 * `openid`/`email` sont exigés par la soumission ChatGPT (userinfo), `offline_access` fait demander
 * un refresh_token aux clients qui ne le font que s'il est annoncé.
 */
export const OAUTH_SCOPES = ["openid", "email", "offline_access"];

/**
 * Audiences acceptées (RFC 8707) : le MCP est servi à la racine ET sur /mcp, l'utilisateur peut
 * saisir l'une ou l'autre comme URL de connecteur. Comparaison sans slash final.
 */
export const isAllowedAudience = (aud: unknown): boolean => {
  if (typeof aud !== "string") return false;
  const base = getBase().replace(/\/+$/, "");
  const candidate = aud.replace(/\/+$/, "");
  return candidate === base || candidate === `${base}/mcp`;
};
