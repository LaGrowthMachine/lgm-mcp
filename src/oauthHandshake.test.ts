/*
 * Copyright 2026 La Growth Machine
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */
import crypto from "crypto";
import { seal, open } from "./tokens";
import { issueTokensForSecret } from "./oauthTokens";
import { resolveAccessToken } from "./accessToken";
import {
    AuthStatePayload,
    AuthCodePayload,
    AUTH_STATE_TTL_SECONDS,
    AUTH_CODE_TTL_SECONDS,
} from "./oauthEnvelopes";

const KEY_A = "a".repeat(64);

/**
 * Vérifie que le code_challenge PKCE survit tout le trajet authstate → code → /token, et que le
 * secret par-connecteur emballé ressort identique côté /mcp. C'est le maillon que l'advisor a flaggé
 * comme facile à casser au hop de l'authstate.
 */
describe("oauth handshake — PKCE + secret survive the authstate→code chain", () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
        process.env.LGM_TOKEN_SECRET = KEY_A;
    });

    afterEach(() => {
        process.env = { ...originalEnv };
    });

    it("carries code_challenge from /authorize through /authorize/callback into a verifiable code", () => {
        const verifier = "the-pkce-code-verifier-value";
        const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");

        // /authorize seals the authstate carrying Claude's PKCE + redirect_uri.
        const authstate = seal<AuthStatePayload>(
            "authstate",
            { redirectUri: "https://claude.ai/cb", state: "xyz", codeChallenge: challenge, codeChallengeMethod: "S256" },
            AUTH_STATE_TTL_SECONDS,
        );

        // /authorize/callback opens it and seals a code wrapping the per-connector secret + the SAME PKCE.
        const statePayload = open<AuthStatePayload>(authstate, "authstate");
        expect(statePayload).not.toBeNull();
        const code = seal<AuthCodePayload>(
            "code",
            {
                secret: "lgmc_connector_secret",
                codeChallenge: statePayload!.codeChallenge,
                codeChallengeMethod: statePayload!.codeChallengeMethod,
                redirectUri: statePayload!.redirectUri,
            },
            AUTH_CODE_TTL_SECONDS,
        );

        // /token opens the code: the challenge is intact and the verifier matches it.
        const codePayload = open<AuthCodePayload>(code, "code");
        expect(codePayload!.codeChallenge).toBe(challenge);
        const recomputed = crypto.createHash("sha256").update(verifier).digest("base64url");
        expect(recomputed).toBe(codePayload!.codeChallenge);

        // /token then issues tokens whose access_token resolves back to the per-connector secret on /mcp.
        const tokens = issueTokensForSecret(codePayload!.secret);
        expect(resolveAccessToken(tokens.access_token)).toBe("lgmc_connector_secret");
    });
});
