/*
 * Copyright 2026 La Growth Machine
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */
import { seal } from "./tokens";
import { resolveAccessToken } from "./accessToken";

const KEY_A = "a".repeat(64); // 32 bytes hex

describe("resolveAccessToken (/mcp bearer resolution)", () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
        process.env = { ...originalEnv };
    });

    it("unwraps a self-encoded access_token to its per-connector secret", () => {
        process.env.LGM_TOKEN_SECRET = KEY_A;
        const accessToken = seal("at", { secret: "lgmc_connector_secret", aud: "mcp" }, 3600);
        expect(resolveAccessToken(accessToken)).toBe("lgmc_connector_secret");
    });

    it("falls back to the raw master key for legacy clients (migration)", () => {
        process.env.LGM_TOKEN_SECRET = KEY_A;
        const rawMasterKey = "0123456789abcdef-legacy-master-key";
        expect(resolveAccessToken(rawMasterKey)).toBe(rawMasterKey);
    });

    it("falls back to the raw bearer when the envelope type is not 'at'", () => {
        process.env.LGM_TOKEN_SECRET = KEY_A;
        const refreshToken = seal("rt", { secret: "lgmc_connector_secret" }, 3600);
        expect(resolveAccessToken(refreshToken)).toBe(refreshToken);
    });

    it("falls back to the raw bearer when no server secret is configured", () => {
        delete process.env.LGM_TOKEN_SECRET;
        const rawMasterKey = "raw-key-without-token-secret";
        expect(resolveAccessToken(rawMasterKey)).toBe(rawMasterKey);
    });

    it("falls back to the raw bearer for an expired access_token", () => {
        process.env.LGM_TOKEN_SECRET = KEY_A;
        const expired = seal("at", { secret: "lgmc_connector_secret" }, -10);
        expect(resolveAccessToken(expired)).toBe(expired);
    });
});
