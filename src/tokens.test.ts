/*
 * Copyright 2026 La Growth Machine
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */
import { seal, open } from "./tokens";

const KEY_A = "a".repeat(64); // 32 bytes hex
const KEY_B = "b".repeat(64);

describe("tokens (self-encoded envelopes)", () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
        process.env = { ...originalEnv };
    });

    it("seals and opens a payload round-trip", () => {
        process.env.LGM_TOKEN_SECRET = KEY_A;
        const token = seal("at", { secret: "lgmc_abc", aud: "mcp" }, 3600);
        const data = open<{ secret: string; aud: string }>(token, "at");
        expect(data).toEqual({ secret: "lgmc_abc", aud: "mcp" });
    });

    it("rejects a token opened with the wrong type", () => {
        process.env.LGM_TOKEN_SECRET = KEY_A;
        const token = seal("at", { secret: "lgmc_abc" }, 3600);
        expect(open(token, "rt")).toBeNull();
        expect(open(token, "code")).toBeNull();
    });

    it("rejects an expired token", () => {
        process.env.LGM_TOKEN_SECRET = KEY_A;
        const token = seal("code", { secret: "lgmc_abc" }, -10);
        expect(open(token, "code")).toBeNull();
    });

    it("rejects a tampered token (GCM auth tag mismatch)", () => {
        process.env.LGM_TOKEN_SECRET = KEY_A;
        const token = seal("at", { secret: "lgmc_abc" }, 3600);
        const parts = token.split(".");
        const ciphertext = Buffer.from(parts[3], "base64url");
        ciphertext[0] = ciphertext[0] ^ 0xff;
        parts[3] = ciphertext.toString("base64url");
        expect(open(parts.join("."), "at")).toBeNull();
    });

    it("rejects a token sealed with a different (unknown) key", () => {
        process.env.LGM_TOKEN_SECRET = KEY_A;
        const token = seal("at", { secret: "lgmc_abc" }, 3600);
        process.env.LGM_TOKEN_SECRET = KEY_B;
        expect(open(token, "at")).toBeNull();
    });

    it("still opens a token after key rotation (previous key accepted)", () => {
        process.env.LGM_TOKEN_SECRET = KEY_A;
        const token = seal("rt", { secret: "lgmc_abc" }, 3600);
        // Rotate: B becomes active, A kept as previous (open-only)
        process.env.LGM_TOKEN_SECRET = KEY_B;
        process.env.LGM_TOKEN_SECRET_PREVIOUS = KEY_A;
        expect(open<{ secret: string }>(token, "rt")).toEqual({ secret: "lgmc_abc" });
    });

    it("returns null for malformed tokens", () => {
        process.env.LGM_TOKEN_SECRET = KEY_A;
        expect(open("not-a-token", "at")).toBeNull();
        expect(open("a.b.c", "at")).toBeNull();
        expect(open("", "at")).toBeNull();
    });

    it("accepts a base64url-encoded 32-byte key", () => {
        process.env.LGM_TOKEN_SECRET = Buffer.alloc(32, 7).toString("base64url");
        const token = seal("authstate", { redirectUri: "https://claude.ai/cb", state: "xyz" }, 600);
        expect(open<{ redirectUri: string }>(token, "authstate")).toEqual({
            redirectUri: "https://claude.ai/cb",
            state: "xyz",
        });
    });
});
