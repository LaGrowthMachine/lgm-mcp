/*
 * Copyright 2026 La Growth Machine
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */
import crypto from "crypto";

/**
 * Primitive d'enveloppe self-encodée (AES-256-GCM) pour le serveur OAuth MCP.
 *
 * Tout l'état transient du flux OAuth est porté par des enveloppes chiffrées avec un secret
 * serveur — JAMAIS par un store. Une seule primitive (`seal`/`open`), plusieurs `typ` :
 *  - `authstate` : porté à travers le bounce de consentement web et au retour (redirect_uri Claude, state, PKCE, resource).
 *  - `code`      : code d'autorisation émis à Claude (enveloppe le secret par-connecteur + PKCE + redirect_uri).
 *  - `at`        : access_token (enveloppe le secret par-connecteur + audience).
 *  - `rt`        : refresh_token.
 *
 * Le secret par-connecteur ne quitte jamais le serveur MCP : Claude ne détient que des enveloppes
 * éphémères, déchiffrables uniquement avec le secret serveur. `keyId` permet la rotation sans flag-day.
 */

export type TokenType = "authstate" | "code" | "at" | "rt" | "client";

interface Envelope<T> {
    typ: TokenType;
    exp: number; // epoch seconds
    data: T;
}

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const KEY_LENGTH = 32;

const decodeKey = (raw: string): Buffer => {
    const trimmed = raw.trim();
    const key = /^[0-9a-fA-F]{64}$/.test(trimmed) ? Buffer.from(trimmed, "hex") : Buffer.from(trimmed, "base64url");
    if (key.length !== KEY_LENGTH) {
        throw new Error("LGM_TOKEN_SECRET must decode to 32 bytes (hex or base64url)");
    }
    return key;
};

const keyIdFor = (key: Buffer): string => crypto.createHash("sha256").update(key).digest("hex").slice(0, 8);

interface ServerKey {
    keyId: string;
    key: Buffer;
}

/**
 * Charge les clés à chaque appel (pas au chargement du module) pour rester testable et permettre
 * la rotation à chaud. La première clé (`LGM_TOKEN_SECRET`) scelle ; les précédentes
 * (`LGM_TOKEN_SECRET_PREVIOUS`, séparées par des virgules) ne servent qu'à ouvrir.
 */
const loadKeys = (): ServerKey[] => {
    const active = process.env.LGM_TOKEN_SECRET;
    if (!active) {
        throw new Error("LGM_TOKEN_SECRET is not set");
    }
    const previous = process.env.LGM_TOKEN_SECRET_PREVIOUS?.split(",") ?? [];
    return [active, ...previous]
        .map((raw) => raw.trim())
        .filter(Boolean)
        .map((raw) => {
            const key = decodeKey(raw);
            return { keyId: keyIdFor(key), key };
        });
};

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** Scelle une charge utile typée en une enveloppe chiffrée, valide `ttlSeconds`. */
export const seal = <T>(typ: TokenType, data: T, ttlSeconds: number): string => {
    const [{ keyId, key }] = loadKeys();
    const envelope: Envelope<T> = { typ, exp: nowSeconds() + ttlSeconds, data };
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(envelope), "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [keyId, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
};

/**
 * Ouvre et valide une enveloppe : déchiffrement authentifié, vérification du `typ` attendu et de
 * l'expiration. Renvoie la charge utile, ou `null` pour tout échec (format, clé inconnue,
 * falsification, mauvais `typ`, expiré). Ne lève jamais sur une entrée invalide.
 */
export const open = <T>(token: string, expectedType: TokenType): T | null => {
    const parts = token.split(".");
    if (parts.length !== 4) {
        return null;
    }
    const [keyId, ivPart, tagPart, ciphertextPart] = parts;

    let serverKey: ServerKey | undefined;
    try {
        serverKey = loadKeys().find((candidate) => candidate.keyId === keyId);
    } catch {
        return null;
    }
    if (!serverKey) {
        return null;
    }

    try {
        const iv = Buffer.from(ivPart, "base64url");
        const tag = Buffer.from(tagPart, "base64url");
        const ciphertext = Buffer.from(ciphertextPart, "base64url");
        const decipher = crypto.createDecipheriv(ALGORITHM, serverKey.key, iv);
        decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
        const envelope = JSON.parse(plaintext) as Envelope<T>;
        if (envelope.typ !== expectedType || envelope.exp <= nowSeconds()) {
            return null;
        }
        return envelope.data;
    } catch {
        return null;
    }
};
