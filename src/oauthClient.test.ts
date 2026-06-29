/*
 * Copyright 2026 La Growth Machine
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */
import { issueClientId, parseClientId, clientAllowsRedirectUri, isAllowedRedirectUri } from "./oauthClient";

const KEY_A = "a".repeat(64);

describe("oauthClient — DCR stateless client_id (known-host allowlist)", () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
        process.env.LGM_TOKEN_SECRET = KEY_A;
        // Éditeurs supportés par défaut dans les tests.
        process.env.OAUTH_ALLOWED_REDIRECT_HOSTS = "claude.ai,chatgpt.com";
    });

    afterEach(() => {
        process.env = { ...originalEnv };
    });

    it("seals a redirect on an allowed host into a client_id and reads it back", () => {
        const clientId = issueClientId(["https://claude.ai/api/mcp/auth_callback"]);
        expect(clientId).not.toBeNull();
        expect(parseClientId(clientId as string)).toEqual({
            redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
        });
    });

    it("matches any path and any subdomain of an allowed host", () => {
        expect(isAllowedRedirectUri("https://claude.ai/whatever/path?x=1")).toBe(true);
        expect(isAllowedRedirectUri("https://auth.chatgpt.com/connector/cb")).toBe(true);
    });

    it("fails closed: rejects every remote https redirect when no host is configured", () => {
        delete process.env.OAUTH_ALLOWED_REDIRECT_HOSTS;
        expect(isAllowedRedirectUri("https://claude.ai/api/mcp/auth_callback")).toBe(false);
        expect(issueClientId(["https://claude.ai/cb"])).toBeNull();
    });

    it("always accepts http localhost / 127.0.0.1 (dev), rejects other http and junk", () => {
        delete process.env.OAUTH_ALLOWED_REDIRECT_HOSTS;
        expect(isAllowedRedirectUri("http://localhost:3000/cb")).toBe(true);
        expect(isAllowedRedirectUri("http://127.0.0.1/cb")).toBe(true);
        expect(isAllowedRedirectUri("http://evil.example.com/cb")).toBe(false);
        expect(isAllowedRedirectUri("not-a-url")).toBe(false);
    });

    it("rejects a lookalike host that is not a real subdomain", () => {
        // notclaude.ai must NOT match claude.ai (suffix check is on a dot boundary)
        expect(isAllowedRedirectUri("https://notclaude.ai/cb")).toBe(false);
        expect(isAllowedRedirectUri("https://claude.ai.attacker.com/cb")).toBe(false);
    });

    it("returns null when no presented redirect_uri is on an allowed host", () => {
        expect(issueClientId(["https://attacker.example.com/cb"])).toBeNull();
    });

    it("keeps only the redirects on allowed hosts when mixing valid and invalid", () => {
        const clientId = issueClientId(["https://attacker.example.com/cb", "https://claude.ai/cb"]);
        expect(parseClientId(clientId as string)).toEqual({ redirectUris: ["https://claude.ai/cb"] });
    });

    it("authorizes a redirect_uri only if it belongs to the signed client_id", () => {
        const clientId = issueClientId(["https://claude.ai/cb"]) as string;
        expect(clientAllowsRedirectUri(clientId, "https://claude.ai/cb")).toBe(true);
        // even though chatgpt.com is allowlisted, this client only registered claude.ai/cb
        expect(clientAllowsRedirectUri(clientId, "https://chatgpt.com/cb")).toBe(false);
    });

    it("rejects a tampered / unknown client_id", () => {
        expect(parseClientId("garbage")).toBeNull();
        expect(clientAllowsRedirectUri("garbage", "https://claude.ai/cb")).toBe(false);
    });
});
