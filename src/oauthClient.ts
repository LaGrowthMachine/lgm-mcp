/*
 * Copyright 2026 La Growth Machine
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */
import axios from "axios";
import dns from "node:dns/promises";
import https from "node:https";
import net from "node:net";
import { seal, open } from "./tokens";

/**
 * Dynamic Client Registration (RFC 7591) sans store : le `client_id` EST un blob signé (enveloppe
 * `client`) qui emballe les `redirect_uris` autorisés du client. /authorize re-valide alors le
 * `redirect_uri` reçu contre ce blob — aucune persistance, multi-replica safe.
 */
export interface ClientRegistrationPayload {
    redirectUris: string[];
    // Nom auto-déclaré au /register (RFC 7591, ex: "Claude", "Codex", "ChatGPT"). Signal ANALYTICS
    // uniquement (spoofable) — jamais utilisé pour une décision de sécurité. Absent sur les
    // client_id émis avant cet ajout.
    clientName?: string;
}

// Le client_id est durable (Claude le réutilise longtemps) ; on lui donne une longue durée de vie.
const CLIENT_ID_TTL_SECONDS = 60 * 60 * 24 * 365 * 5; // 5 ans

const isLoopback = (url: URL): boolean =>
    url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");

/**
 * Forme acceptée pour un redirect_uri (DCR et CIMD) : https quel que soit le host, ou http loopback
 * (CLI en dev : Claude Code, Codex). Un client OAuth custom (source inconnue) N'EST PAS bloqué ici :
 * il est accepté, et la page de consentement avertit l'utilisateur (cf. isKnownRedirectUri).
 */
export const isAcceptableRedirectUri = (uri: string): boolean => {
    try {
        const url = new URL(uri);
        return isLoopback(url) || url.protocol === "https:";
    } catch {
        return false;
    }
};

/**
 * Éditeurs de clients MCP reconnus, par hostname de redirect_uri. Sert (a) à la détection `llm`
 * (analytics, cf. oauth.ts) et (b) au verdict connu/inconnu transmis à la page de consentement :
 * source connue → rien de particulier ; source inconnue → bandeau « Unverified application » et
 * l'utilisateur ne continue que s'il fait confiance à la source. Ce n'est PAS une allowlist : un
 * host absent d'ici passe quand même l'enregistrement.
 *
 * Extensible sans redéploiement via l'env `OAUTH_KNOWN_REDIRECT_HOSTS` (hostnames séparés par des
 * virgules ; l'ancien nom `OAUTH_ALLOWED_REDIRECT_HOSTS` est encore lu pour ne pas casser la config
 * Coolify existante). Match exact ou sous-domaine sur frontière de point (rejette les lookalikes).
 */
export const KNOWN_LLM_HOSTS: Array<{ llm: string; hosts: string[] }> = [
    { llm: "claude", hosts: ["claude.ai", "claude.com", "anthropic.com"] },
    { llm: "chatgpt", hosts: ["chatgpt.com", "openai.com"] },
];

const extraKnownHosts = (): string[] =>
    (process.env.OAUTH_KNOWN_REDIRECT_HOSTS || process.env.OAUTH_ALLOWED_REDIRECT_HOSTS || "")
        .split(",")
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean);

const hostnameMatches = (hostname: string, knownHost: string): boolean =>
    hostname === knownHost || hostname.endsWith(`.${knownHost}`);

export const isKnownRedirectHost = (hostname: string): boolean => {
    const candidate = hostname.toLowerCase();
    const builtIn = KNOWN_LLM_HOSTS.flatMap((entry) => entry.hosts);
    return [...builtIn, ...extraKnownHosts()].some((knownHost) => hostnameMatches(candidate, knownHost));
};

/** Loopback (CLI locale lancée par l'utilisateur lui-même) compte comme connu : pas d'avertissement. */
export const isKnownRedirectUri = (uri: string): boolean => {
    try {
        const url = new URL(uri);
        return isLoopback(url) || isKnownRedirectHost(url.hostname);
    } catch {
        return false;
    }
};

/** Valeur de `source_known` transmise à la page de consentement pour ce redirect_uri. */
export const sourceKnownParam = (redirectUri: string): "true" | "false" => (isKnownRedirectUri(redirectUri) ? "true" : "false");

/**
 * Intégrité de l'affichage du consentement. `client_redirect` et `source_known` voyagent EN CLAIR dans
 * l'URL de la page : sans ce contrôle, un attaquant qui a enregistré un client sur SON domaine peut
 * réécrire le lien (« Source : Claude », pas de bandeau) et l'envoyer à une victime connectée — le
 * code OAuth partirait alors sur son redirect_uri scellé dans l'authstate. La page renvoie donc ce
 * qu'elle a affiché à /authorize/callback, qui refuse l'échange si ça ne correspond pas à l'état scellé.
 */
export const consentDisplayMatches = (
    sealedRedirectUri: string,
    displayed: { clientRedirect?: string; sourceKnown?: string },
): boolean => displayed.clientRedirect === sealedRedirectUri && displayed.sourceKnown === sourceKnownParam(sealedRedirectUri);

const CLIENT_NAME_MAX_LENGTH = 60;

/** Scelle les redirect_uris validés (+ client_name déclaratif) en un client_id durable. Renvoie null si aucune URI valide. */
export const issueClientId = (redirectUris: string[], clientName?: string): string | null => {
    const validUris = redirectUris.filter(isAcceptableRedirectUri);
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
 * Le fetch est une requête sortante déclenchée par une URL fournie par le client : on borne le risque
 * SSRF sans allowlist d'hôtes — https obligatoire, host nommé (jamais une IP littérale ni localhost),
 * host résolu en adresse PUBLIQUE avant la requête et connexion épinglée sur cette adresse (pas de
 * rebinding DNS entre la vérification et la connexion), timeout court, taille plafonnée, aucune
 * redirection suivie, et le document doit se désigner lui-même. Chaque redirect_uri du document
 * repasse ensuite par isAcceptableRedirectUri.
 */
export const isClientIdMetadataUrl = (clientId: string): boolean => {
    try {
        const url = new URL(clientId);
        const hostname = url.hostname.toLowerCase();
        const isLocalName = hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".");
        return url.protocol === "https:" && !isLocalName;
    } catch {
        return false;
    }
};

// Host en IP littérale (v4, ou v6 entre crochets) : refusé pour le fetch CIMD, un client légitime publie
// son document de métadonnées sous un nom de domaine.
const isIpLiteralHostname = (hostname: string): boolean =>
    /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.startsWith("[");

export const isFetchableClientIdMetadataUrl = (clientId: string): boolean => {
    if (!isClientIdMetadataUrl(clientId)) return false;
    return !isIpLiteralHostname(new URL(clientId).hostname);
};

const isPrivateIpv4 = (address: string): boolean => {
    const octets = address.split(".").map(Number);
    if (octets.length !== 4 || octets.some((octet) => Number.isNaN(octet))) return true;
    const [a, b] = octets;
    return (
        a === 0 || // 0.0.0.0/8 (« ce réseau »)
        a === 10 || // 10/8
        a === 127 || // loopback
        (a === 100 && b >= 64 && b <= 127) || // 100.64/10 (CGNAT)
        (a === 169 && b === 254) || // link-local + metadata cloud (169.254.169.254)
        (a === 172 && b >= 16 && b <= 31) || // 172.16/12
        (a === 192 && b === 168) || // 192.168/16
        a >= 224 // multicast + réservé + broadcast
    );
};

const IPV4_MAPPED_PREFIX = "::ffff:";

const isPrivateIpv6 = (address: string): boolean => {
    const normalized = address.toLowerCase();
    if (normalized === "::" || normalized === "::1") return true;
    if (normalized.startsWith(IPV4_MAPPED_PREFIX)) {
        const mapped = normalized.slice(IPV4_MAPPED_PREFIX.length);
        if (net.isIPv4(mapped)) return isPrivateIpv4(mapped);
        // Forme hexadécimale (::ffff:7f00:1) : on reconstitue les 4 octets.
        const [high, low] = mapped.split(":");
        const value = (parseInt(high || "0", 16) << 16) | parseInt(low || "0", 16);
        return isPrivateIpv4([value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join("."));
    }
    const firstHextet = parseInt(normalized.split(":")[0] || "0", 16);
    return (
        (firstHextet & 0xfe00) === 0xfc00 || // fc00::/7 (ULA)
        (firstHextet & 0xffc0) === 0xfe80 || // fe80::/10 (link-local)
        (firstHextet & 0xff00) === 0xff00 || // multicast
        normalized.startsWith("64:ff9b:") // NAT64 (64:ff9b::/96) : peut viser un v4 privé
    );
};

/** Adresse IP (v4 ou v6, telle que renvoyée par le résolveur) qui ne doit jamais être contactée par le fetch CIMD. */
export const isPrivateAddress = (address: string): boolean => {
    if (net.isIPv4(address)) return isPrivateIpv4(address);
    if (net.isIPv6(address)) return isPrivateIpv6(address);
    return true;
};

export interface ResolvedAddress {
    address: string;
    family: number;
}

export type HostnameLookup = (hostname: string) => Promise<ResolvedAddress[]>;

const defaultLookup: HostnameLookup = async (hostname) => {
    const results = await dns.lookup(hostname, { all: true });
    return results.map(({ address, family }) => ({ address, family }));
};

/**
 * Résout le host et renvoie l'adresse à utiliser, ou null si le host ne résout pas ou si UNE de ses
 * adresses est privée (un attaquant contrôlant le DNS peut mêler une adresse publique et une privée).
 */
export const resolvePublicAddress = async (hostname: string, lookup: HostnameLookup = defaultLookup): Promise<ResolvedAddress | null> => {
    try {
        const addresses = await lookup(hostname);
        if (addresses.length === 0) return null;
        if (addresses.some(({ address }) => isPrivateAddress(address))) return null;
        return addresses[0];
    } catch {
        return null;
    }
};

// Agent https qui se connecte à l'adresse DÉJÀ vérifiée (au lieu de re-résoudre le host) : ferme la
// fenêtre de rebinding DNS entre la vérification et la connexion. Le SNI/certificat reste sur le hostname.
const pinnedHttpsAgent = (resolved: ResolvedAddress): https.Agent =>
    new https.Agent({
        lookup: (_hostname, options, callback) => {
            const wantsAll = typeof options === "object" && options !== null && "all" in options && options.all === true;
            if (wantsAll) {
                callback(null, [{ address: resolved.address, family: resolved.family }]);
                return;
            }
            callback(null, resolved.address, resolved.family);
        },
    });

export const CLIENT_ID_METADATA_FETCH_OPTIONS = {
    timeoutMs: 5_000,
    maxContentLengthBytes: 64 * 1024,
};

// Fetch à chaque /authorize (1 requête par consentement humain, pas par appel de tool) : pas de
// cache tant que le volume ne le justifie pas.
export const fetchClientIdMetadata = async (
    clientId: string,
    lookup: HostnameLookup = defaultLookup,
): Promise<ClientRegistrationPayload | null> => {
    if (!isFetchableClientIdMetadataUrl(clientId)) return null;
    const resolved = await resolvePublicAddress(new URL(clientId).hostname, lookup);
    if (!resolved) return null;
    try {
        const response = await axios.get(clientId, {
            timeout: CLIENT_ID_METADATA_FETCH_OPTIONS.timeoutMs,
            maxContentLength: CLIENT_ID_METADATA_FETCH_OPTIONS.maxContentLengthBytes,
            maxRedirects: 0,
            headers: { Accept: "application/json" },
            validateStatus: () => true,
            httpsAgent: pinnedHttpsAgent(resolved),
        });
        if (response.status !== 200 || !response.data || typeof response.data !== "object") return null;
        const doc = response.data as { client_id?: unknown; client_name?: unknown; redirect_uris?: unknown };
        // Le document doit se désigner lui-même (protège contre un JSON arbitraire servi sur le host).
        if (doc.client_id !== clientId) return null;
        const redirectUris = Array.isArray(doc.redirect_uris)
            ? doc.redirect_uris.filter((uri): uri is string => typeof uri === "string" && isAcceptableRedirectUri(uri))
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
