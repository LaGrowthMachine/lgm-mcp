/*
 * Copyright 2026 La Growth Machine
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */
import crypto from "crypto";
import express from "express";
import axios from "axios";
import { getApiUrl } from "./requestContext";
import { seal, open } from "./tokens";
import {
  AuthCodePayload,
  AuthStatePayload,
  RefreshTokenPayload,
  AUTH_CODE_TTL_SECONDS,
  AUTH_STATE_TTL_SECONDS,
} from "./oauthEnvelopes";
import { issueTokensForSecret } from "./oauthTokens";
import {
  issueClientId,
  parseClientId,
  redirectUriMatches,
  isClientIdMetadataUrl,
  fetchClientIdMetadata,
} from "./oauthClient";
import { resolveAccessToken } from "./accessToken";
import { OAUTH_SCOPES, getBase, isAllowedAudience } from "./oauthConfig";

const router = express.Router();

interface AuthCodeEntry {
  clientId: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  expiresAt: number;
}

// In-memory store: code → { clientId (email), PKCE data, expiresAt }
const authCodes = new Map<string, AuthCodeEntry>();

setInterval(() => {
  const now = Date.now();
  for (const [code, data] of authCodes.entries()) {
    if (data.expiresAt < now) authCodes.delete(code);
  }
}, 60_000);

function verifyPkce(verifier: string, challenge: string, method: string): boolean {
  if (method === "S256") {
    const hash = crypto.createHash("sha256").update(verifier).digest("base64url");
    return hash === challenge;
  }
  return verifier === challenge; // plain
}

type ApiKeyCheckResult =
  | { ok: true }
  | { ok: false; reason: 'invalid_key' | 'service_unavailable' | 'email_mismatch' | 'bad_request' };

async function validateApiKey(apiKey: string, clientId: string): Promise<ApiKeyCheckResult> {
  const url = `${getApiUrl()}/flow/check-email?email=${encodeURIComponent(clientId)}`;
  try {
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: 5_000,
      validateStatus: () => true,
    });
    console.error(`[OAuth] GET /flow/check-email → ${response.status}`);
    if (response.status >= 500) return { ok: false, reason: 'service_unavailable' };
    if (response.status === 400) return { ok: false, reason: 'bad_request' };
    if (response.status >= 401) return { ok: false, reason: 'invalid_key' };
    if (response.data?.valid !== true) return { ok: false, reason: 'email_mismatch' };
    return { ok: true };
  } catch (err) {
    console.error(`[OAuth] /flow/check-email request failed:`, err);
    return { ok: false, reason: 'service_unavailable' };
  }
}

// Les client_id DCR sont des blobs signés de plusieurs centaines de caractères : illisibles et
// inutiles en entier dans les logs. Le préfixe suffit à corréler les requêtes d'un même client.
const shortClientId = (clientId?: string): string => (clientId ? `${clientId.slice(0, 16)}…` : "");

const KNOWN_LLM_HOSTS: Array<{ llm: string; hosts: string[] }> = [
  { llm: "claude", hosts: ["claude.ai", "claude.com", "anthropic.com"] },
  { llm: "chatgpt", hosts: ["chatgpt.com", "openai.com"] },
];

const matchKnownLlmHost = (hostname: string): string | undefined => {
  const matches = (host: string): boolean => hostname === host || hostname.endsWith(`.${host}`);
  return KNOWN_LLM_HOSTS.find((entry) => entry.hosts.some(matches))?.llm;
};

// Origin (scheme+host) d'un Referer, sans path ni query : assez pour identifier la surface,
// sans embarquer d'URL de page potentiellement sensible.
const parseRefererOrigin = (referer?: string): string | undefined => {
  if (!referer) return undefined;
  try {
    return new URL(referer).origin.toLowerCase();
  } catch {
    return undefined;
  }
};

// client_name DCR → llm. Déclaratif (spoofable) mais fiable en pratique pour l'ANALYTICS : observé
// en prod `Claude` (claude.ai), `Codex` (CLI OpenAI, redirect localhost + UA vide), `ChatGPT`.
// Fallback : slug du nom déclaré, pour voir apparaître les nouveaux clients dans les dashboards.
const matchKnownClientName = (clientName?: string): string | undefined => {
  const name = clientName?.trim().toLowerCase();
  if (!name) return undefined;
  if (name.includes("claude") && name.includes("code")) return "claude-code";
  if (name.includes("claude")) return "claude";
  if (name.includes("codex")) return "codex";
  if (name.includes("chatgpt") || name.includes("openai")) return "chatgpt";
  const slug = name.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  return slug || undefined;
};

// Identifie le LLM client, du signal le plus vérifié au plus déclaratif :
// 1. HOST du redirect_uri (validé contre l'allowlist au /register puis au /authorize)
// 2. Origin du Referer à l'arrivée sur /authorize (fourni par le navigateur) — rattrape les
//    webviews à redirect localhost
// 3. client_name du DCR (auto-déclaré, scellé dans le client_id) — rattrape les CLI (Codex,
//    Claude Code) qui n'ont ni redirect distant ni Referer
// Le User-Agent est volontairement ignoré ici : pendant l'OAuth c'est celui du navigateur de
// l'humain ou d'une stack HTTP générique (python-httpx, aiohttp), jamais celui du client MCP.
const detectLlm = (params: { redirectUri: string; refererOrigin?: string; clientName?: string }): string => {
  let redirectHostname = "";
  try {
    redirectHostname = new URL(params.redirectUri).hostname.toLowerCase();
  } catch {
    return "unknown";
  }
  const llmFromRedirect = matchKnownLlmHost(redirectHostname);
  if (llmFromRedirect) return llmFromRedirect;

  if (params.refererOrigin) {
    try {
      const llmFromReferer = matchKnownLlmHost(new URL(params.refererOrigin).hostname);
      if (llmFromReferer) return llmFromReferer;
    } catch {
      // Referer malformé : on continue avec les signaux suivants.
    }
  }

  const llmFromClientName = matchKnownClientName(params.clientName);
  if (llmFromClientName) return llmFromClientName;

  if (redirectHostname === "localhost" || redirectHostname === "127.0.0.1") return "local";
  return redirectHostname;
};

// Page de consentement servie par le FRONT (lgm-web-app, route /oauth/consent) : session + design
// natifs, elle mint via POST /connectionsv1/mcp puis 302 vers le `callback` qu'on lui passe.
// Pilotée par l'env MCP_CONSENT_URL (ex: https://oauth2.preview.lgmfeatureenv7.com/oauth/consent).
const getConsentUrl = () =>
  process.env.MCP_CONSENT_URL || `${getApiUrl()}/oauth/consent`;

// OAuth 2.0 Protected Resource Metadata (RFC 9728). Le MCP est servi à la racine ET sur /mcp ;
// les clients (Claude, ChatGPT) exigent que `resource` soit EXACTEMENT l'URL saisie par l'utilisateur,
// d'où une métadonnée par ressource : `/.well-known/oauth-protected-resource` (racine) et
// `/.well-known/oauth-protected-resource/mcp` (path-suffixé, RFC 9728 §3).
const protectedResourceMetadata = (resource: string) => ({
  resource,
  authorization_servers: [getBase()],
  bearer_methods_supported: ["header"],
  scopes_supported: OAUTH_SCOPES,
});
router.get("/.well-known/oauth-protected-resource", (_req, res) => {
  res.json(protectedResourceMetadata(getBase()));
});
router.get("/.well-known/oauth-protected-resource/mcp", (_req, res) => {
  res.json(protectedResourceMetadata(`${getBase()}/mcp`));
});

// OAuth 2.0 Authorization Server Metadata (RFC 8414)
const authorizationServerMetadata = (base: string) => ({
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    // Client public + PKCE (flux par-connecteur). Cette instance n'a aucun client legacy
    // client_secret_post → on annonce "none" : c'est ce qui « allume » DCR côté Claude/ChatGPT.
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    // `offline_access` annoncé → les clients demandent un refresh_token (ChatGPT perd l'accès à
    // l'expiration sinon) ; `openid`/`email` + userinfo_endpoint sont exigés par la soumission ChatGPT.
    scopes_supported: OAUTH_SCOPES,
    userinfo_endpoint: `${base}/userinfo`,
    // CIMD (client_id = URL de métadonnées) : méthode recommandée par Claude et ChatGPT, cf. oauthClient.ts.
    client_id_metadata_document_supported: true,
});
router.get("/.well-known/oauth-authorization-server", (_req, res) => {
  res.json(authorizationServerMetadata(getBase()));
});
router.get("/.well-known/openid-configuration", (_req, res) => {
  res.json(authorizationServerMetadata(getBase()));
});

// UserInfo (OIDC §5.3) — exigence de la soumission ChatGPT : `email` + `email_verified: true`.
// Le bearer est l'access_token MCP ; l'identité vient de lgm-apis (GET /flow/me, authentifié avec le
// secret par-connecteur).
router.get("/userinfo", async (req, res) => {
  const authHeader = req.headers["authorization"];
  const bearer = typeof authHeader === "string" && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
  if (!bearer) {
    res.set("WWW-Authenticate", 'Bearer error="invalid_token"');
    res.status(401).json({ error: "invalid_token" });
    return;
  }
  const { apiKey } = resolveAccessToken(bearer);
  try {
    const response = await axios.get(`${getApiUrl()}/flow/me`, {
      headers: { Authorization: `Bearer ${apiKey}`, "x-lgm-integration": "mcp" },
      timeout: 5_000,
      validateStatus: () => true,
    });
    const { id, email } = (response.data as { id?: unknown; email?: unknown } | undefined) ?? {};
    if (response.status !== 200 || typeof email !== "string") {
      console.error(`[OAuth] /userinfo upstream status=${response.status}`);
      res.status(response.status === 401 ? 401 : 503).json({ error: response.status === 401 ? "invalid_token" : "server_error" });
      return;
    }
    res.json({
      sub: typeof id === "string" && id ? id : crypto.createHash("sha256").update(email.toLowerCase()).digest("hex").slice(0, 32),
      email,
      email_verified: true,
    });
  } catch (e) {
    console.error(`[OAuth] /userinfo request failed:`, e);
    res.status(503).json({ error: "server_error" });
  }
});

// POST /register — Dynamic Client Registration (RFC 7591). Stateless : le client_id renvoyé est
// un blob signé des redirect_uris validés (cf. oauthClient.ts). Aucun client_secret (client public,
// PKCE). Non encore annoncé dans les métadonnées (flip avec la chaîne authorize/callback complète).
router.post("/register", (req, res) => {
  const body = (req.body || {}) as { redirect_uris?: unknown; client_name?: unknown };
  const redirectUris = Array.isArray(body.redirect_uris)
    ? body.redirect_uris.filter((uri): uri is string => typeof uri === "string")
    : [];

  console.error(
    `[OAuth] /register client_name=${String(body.client_name ?? "")} redirect_uris=${redirectUris.length} ua="${req.headers["user-agent"] || ""}"`,
  );

  if (redirectUris.length === 0) {
    res.status(400).json({ error: "invalid_redirect_uri", error_description: "At least one redirect_uri is required" });
    return;
  }

  const clientId = issueClientId(redirectUris, typeof body.client_name === "string" ? body.client_name : undefined);
  if (!clientId) {
    res.status(400).json({ error: "invalid_redirect_uri", error_description: "No redirect_uri passed the allowlist" });
    return;
  }

  res.status(201).json({
    client_id: clientId,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  });
});

// GET /authorize — handler async (fetch CIMD) : Express 4 ne rattrape pas un rejet async, d'où le
// wrapper, sinon une erreur (ex. LGM_TOKEN_SECRET absent) tue le process.
router.get("/authorize", (req, res) => {
  authorize(req, res).catch((e) => {
    console.error(`[OAuth] /authorize failed:`, e);
    if (!res.headersSent) res.status(500).json({ error: "server_error" });
  });
});
const authorize = async (req: express.Request, res: express.Response): Promise<void> => {
  const {
    redirect_uri,
    state,
    client_id,
    code_challenge,
    code_challenge_method,
    resource,
  } = req.query as Record<string, string>;

  console.error(`[OAuth] /authorize client_id=${shortClientId(client_id)} code_challenge_method=${code_challenge_method}`);

  if (!redirect_uri || !client_id) {
    res.status(400).json({
      error: "invalid_request",
      error_description: "redirect_uri and client_id are required",
    });
    return;
  }

  // `resource` (RFC 8707) : audience demandée par le client. Refusée si ce n'est pas l'un de NOS
  // endpoints MCP — sinon un token émis pour un autre serveur nous serait présenté.
  if (resource && !isAllowedAudience(resource)) {
    res.status(400).json({ error: "invalid_target", error_description: "resource is not served by this server" });
    return;
  }

  // New flow: the client_id is either a DCR signed blob or a CIMD URL (fetched, cf. oauthClient.ts).
  // The redirect_uri must be one it registered, then we bounce to the back consent page carrying a
  // sealed authstate (redirect_uri/state/PKCE survive the round-trip). Non-DCR client_ids (legacy
  // email) fall through to the master-key path below.
  const registration = isClientIdMetadataUrl(client_id)
    ? await fetchClientIdMetadata(client_id)
    : parseClientId(client_id);
  if (isClientIdMetadataUrl(client_id) && !registration) {
    res.status(400).json({ error: "invalid_client", error_description: "client_id metadata document unavailable or not allowed" });
    return;
  }
  if (registration) {
    if (!registration.redirectUris.some((uri) => redirectUriMatches(uri, redirect_uri))) {
      res.status(400).json({ error: "invalid_request", error_description: "redirect_uri not registered for this client" });
      return;
    }
    // Surface d'où arrive l'humain (claude.ai, chatgpt.com…) — seul point du flow où le navigateur
    // porte encore ce signal ; scellé dans l'authstate pour la détection llm à l'exchange.
    const refererOrigin = parseRefererOrigin(req.headers.referer);
    console.error(`[OAuth] /authorize referer_origin=${refererOrigin || ""}`);
    const authstate = seal<AuthStatePayload>(
      "authstate",
      {
        redirectUri: redirect_uri,
        state,
        codeChallenge: code_challenge,
        codeChallengeMethod: code_challenge_method || "S256",
        resource,
        clientId: client_id,
        refererOrigin,
        clientName: registration.clientName,
      },
      AUTH_STATE_TTL_SECONDS,
    );
    const consentUrl = new URL(getConsentUrl());
    consentUrl.searchParams.set("authstate", authstate);
    // La page de consentement (front) renvoie ici après le mint : on lui passe notre URL de callback
    // pour qu'elle n'ait rien à hardcoder. authstate reste opaque pour elle.
    consentUrl.searchParams.set("callback", `${getBase()}/authorize/callback`);
    // redirect_uri du CLIENT (déjà validé contre le client_id) — la page l'affiche comme "source" et
    // destination, et avertit si le host n'est pas reconnu. C'est un signal fiable (vs client_name
    // auto-déclaré). NON opaque : c'est l'URL publique du client, juste pour information/affichage.
    consentUrl.searchParams.set("client_redirect", redirect_uri);
    console.error(`[OAuth] /authorize → consent bounce to ${consentUrl.origin}${consentUrl.pathname}`);
    res.redirect(consentUrl.toString());
    return;
  }

  // Legacy flow (client_id = email, in-memory code, master key validated at /token) — unchanged.
  const code = crypto.randomBytes(32).toString("hex");
  authCodes.set(code, {
    clientId: client_id,
    codeChallenge: code_challenge,
    codeChallengeMethod: code_challenge_method || "S256",
    expiresAt: Date.now() + 60_000,
  });

  const url = new URL(redirect_uri);
  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);
  console.error(`[OAuth] /authorize → redirect to ${url.origin}${url.pathname}`);
  res.redirect(url.toString());
};

// GET /authorize/callback — retour du consentement back avec un linking_code one-time. On l'échange
// server-to-server contre le secret par-connecteur, qu'on scelle dans un `code` one-shot remis à
// Claude sur SON redirect_uri (PKCE re-vérifié plus tard à /token). Le secret ne touche aucun navigateur.
router.get("/authorize/callback", async (req, res) => {
  const { authstate, linking_code, error } = req.query as Record<string, string>;

  const statePayload = open<AuthStatePayload>(authstate, "authstate");
  if (!statePayload) {
    res.status(400).json({ error: "invalid_request", error_description: "invalid or expired authstate" });
    return;
  }

  const redirectBackToClient = (params: Record<string, string>): void => {
    const url = new URL(statePayload.redirectUri);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
    if (statePayload.state) url.searchParams.set("state", statePayload.state);
    res.redirect(url.toString());
  };

  if (error) {
    console.error(`[OAuth] /authorize/callback consent error=${error}`);
    redirectBackToClient({ error });
    return;
  }
  if (!linking_code) {
    redirectBackToClient({ error: "invalid_request" });
    return;
  }

  try {
    const exchangeResponse = await axios.post(
      `${getApiUrl()}/connectionsv1/mcp/exchange`,
      {
        linkingCode: linking_code,
        llm: detectLlm({
          redirectUri: statePayload.redirectUri,
          refererOrigin: statePayload.refererOrigin,
          // client_name scellé dans l'authstate (DCR ou CIMD) ; absent sur les client_id antérieurs.
          clientName: statePayload.clientName,
        }),
      },
      {
        headers: {
          "x-mcp-service-secret": process.env.MCP_SERVICE_SECRET || "",
          "Content-Type": "application/json",
        },
        timeout: 8_000,
        validateStatus: () => true,
      },
    );

    const secret = (exchangeResponse.data as { secret?: string } | undefined)?.secret;
    if (exchangeResponse.status !== 200 || !secret) {
      console.error(`[OAuth] /authorize/callback exchange failed status=${exchangeResponse.status}`);
      redirectBackToClient({ error: "server_error" });
      return;
    }

    const code = seal<AuthCodePayload>(
      "code",
      {
        secret,
        codeChallenge: statePayload.codeChallenge,
        codeChallengeMethod: statePayload.codeChallengeMethod,
        redirectUri: statePayload.redirectUri,
        aud: statePayload.resource,
      },
      AUTH_CODE_TTL_SECONDS,
    );
    console.error(`[OAuth] /authorize/callback → issuing code to client`);
    redirectBackToClient({ code });
  } catch (e) {
    console.error(`[OAuth] /authorize/callback exchange request failed:`, e);
    redirectBackToClient({ error: "server_error" });
  }
});

// POST /token
router.post("/token", async (req, res) => {
  const { client_id, client_secret, code, grant_type, code_verifier, refresh_token, redirect_uri, resource } =
    req.body as Record<string, string>;
  if (resource && !isAllowedAudience(resource)) {
    res.status(400).json({ error: "invalid_target", error_description: "resource is not served by this server" });
    return;
  }

  console.error(
    `[OAuth] /token grant_type=${grant_type} client_id=${shortClientId(client_id)} ua="${req.headers["user-agent"] || ""}" has_secret=${!!client_secret} has_verifier=${!!code_verifier} has_code=${!!code} has_refresh=${!!refresh_token}`,
  );

  // New flow (per-connector, self-encoded): refresh_token → reissue an at/rt pair from the wrapped secret.
  if (grant_type === "refresh_token") {
    const refreshPayload = open<RefreshTokenPayload>(refresh_token, "rt");
    if (!refreshPayload) {
      console.error(`[OAuth] /token invalid_grant: refresh_token not valid`);
      res.status(400).json({ error: "invalid_grant", error_description: "refresh_token invalid or expired" });
      return;
    }
    console.error(`[OAuth] /token refresh ok`);
    res.json(issueTokensForSecret(refreshPayload.secret, resource || refreshPayload.aud));
    return;
  }

  if (grant_type !== "authorization_code") {
    res.status(400).json({ error: "unsupported_grant_type" });
    return;
  }

  // New flow: the code is a self-encoded `code` envelope wrapping the per-connector secret + PKCE.
  // If it opens, issue self-encoded at/rt. Otherwise fall through to the legacy in-memory code path
  // (existing master-key clients) — same migration-safety contract as /mcp's raw-key fallback.
  if (code) {
    const codePayload = open<AuthCodePayload>(code, "code");
    if (codePayload) {
      if (codePayload.codeChallenge) {
        if (!code_verifier) {
          console.error(`[OAuth] /token missing code_verifier (sealed code)`);
          res.status(400).json({ error: "invalid_request", error_description: "code_verifier is required" });
          return;
        }
        if (!verifyPkce(code_verifier, codePayload.codeChallenge, codePayload.codeChallengeMethod || "S256")) {
          console.error(`[OAuth] /token PKCE mismatch (sealed code)`);
          res.status(400).json({ error: "invalid_grant", error_description: "code_verifier mismatch" });
          return;
        }
      }
      if (redirect_uri && codePayload.redirectUri && redirect_uri !== codePayload.redirectUri) {
        console.error(`[OAuth] /token redirect_uri mismatch (sealed code)`);
        res.status(400).json({ error: "invalid_grant", error_description: "redirect_uri mismatch" });
        return;
      }
      console.error(`[OAuth] /token sealed code ok`);
      res.json(issueTokensForSecret(codePayload.secret, resource || codePayload.aud));
      return;
    }
  }

  if (!code || !client_id) {
    res.status(400).json({
      error: "invalid_request",
      error_description: "code and client_id are required",
    });
    return;
  }

  const stored = authCodes.get(code);
  authCodes.delete(code);

  if (!stored) {
    console.error(`[OAuth] /token invalid_grant: code not found`);
    res.status(400).json({ error: "invalid_grant", error_description: "code not found or already used" });
    return;
  }
  if (stored.expiresAt < Date.now()) {
    console.error(`[OAuth] /token invalid_grant: code expired`);
    res.status(400).json({ error: "invalid_grant", error_description: "code expired" });
    return;
  }
  if (stored.clientId.toLowerCase().trim() !== client_id.toLowerCase().trim()) {
    console.error(`[OAuth] /token invalid_grant: client_id mismatch stored=${stored.clientId} received=${client_id}`);
    res.status(400).json({ error: "invalid_grant", error_description: "client_id mismatch" });
    return;
  }

  if (stored.codeChallenge) {
    if (!code_verifier) {
      console.error(`[OAuth] /token missing code_verifier`);
      res.status(400).json({ error: "invalid_request", error_description: "code_verifier is required" });
      return;
    }
    if (!verifyPkce(code_verifier, stored.codeChallenge, stored.codeChallengeMethod || "S256")) {
      console.error(`[OAuth] /token PKCE mismatch`);
      res.status(400).json({ error: "invalid_grant", error_description: "code_verifier mismatch" });
      return;
    }
    console.error(`[OAuth] /token PKCE ok`);
  }

  if (!client_secret) {
    console.error(`[OAuth] /token missing client_secret`);
    res.status(401).json({ error: "invalid_client", error_description: "client_secret (LGM API key) is required" });
    return;
  }

  const check = await validateApiKey(client_secret, client_id);
  if (!check.ok) {
    if (check.reason === 'service_unavailable') {
      console.error(`[OAuth] /token service unavailable for client_id=${client_id}`);
      res.status(503).json({ error: 'server_error', error_description: 'Authentication service temporarily unavailable. Please try again in a few moments.' });
      return;
    }
    if (check.reason === 'bad_request') {
      console.error(`[OAuth] /token bad email format for client_id=${client_id}`);
      res.status(400).json({ error: 'invalid_request', error_description: "Format d'email invalide. Renseignez une adresse email valide." });
      return;
    }
    if (check.reason === 'email_mismatch') {
      console.error(`[OAuth] /token email mismatch for client_id=${client_id}`);
      res.status(401).json({ error: 'invalid_client', error_description: "Cet email ne correspond pas à la clé API renseignée. Vérifiez l'email associé à votre clé API LGM." });
      return;
    }
    console.error(`[OAuth] /token invalid API key for client_id=${client_id}`);
    res.status(401).json({ error: 'invalid_client', error_description: 'Invalid API key. Check your LGM API key in your account settings.' });
    return;
  }

  console.error(`[OAuth] /token success for ${client_id}`);
  res.json({
    access_token: client_secret,
    token_type: "Bearer",
    expires_in: 31_536_000,
  });
});

export default router;
