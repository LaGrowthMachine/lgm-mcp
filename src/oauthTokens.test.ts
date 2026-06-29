/*
 * Copyright 2026 La Growth Machine
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */
import { issueTokensForSecret } from "./oauthTokens";
import { resolveAccessToken } from "./accessToken";
import { open } from "./tokens";
import { RefreshTokenPayload, ACCESS_TOKEN_TTL_SECONDS } from "./oauthEnvelopes";

const KEY_A = "a".repeat(64);

describe("oauthTokens — at/rt issuance", () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
        process.env.LGM_TOKEN_SECRET = KEY_A;
    });

    afterEach(() => {
        process.env = { ...originalEnv };
    });

    it("issues an access_token that /mcp resolves back to the per-connector secret", () => {
        const tokens = issueTokensForSecret("lgmc_connector_secret");
        expect(tokens.token_type).toBe("Bearer");
        expect(tokens.expires_in).toBe(ACCESS_TOKEN_TTL_SECONDS);
        expect(resolveAccessToken(tokens.access_token)).toBe("lgmc_connector_secret");
    });

    it("issues a refresh_token that wraps the same secret under the 'rt' type", () => {
        const tokens = issueTokensForSecret("lgmc_connector_secret");
        expect(open<RefreshTokenPayload>(tokens.refresh_token, "rt")).toEqual({ secret: "lgmc_connector_secret" });
        // the refresh token must NOT be usable as an access token
        expect(open(tokens.refresh_token, "at")).toBeNull();
    });
});
