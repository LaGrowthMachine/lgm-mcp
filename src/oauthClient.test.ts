/*
 * Copyright 2026 La Growth Machine
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */
import axios from "axios";
import {
    issueClientId,
    parseClientId,
    clientAllowsRedirectUri,
    isAcceptableRedirectUri,
    isKnownRedirectUri,
    isFetchableClientIdMetadataUrl,
    isPrivateAddress,
    resolvePublicAddress,
    fetchClientIdMetadata,
    consentDisplayMatches,
    CLIENT_ID_METADATA_FETCH_OPTIONS,
    HostnameLookup,
} from "./oauthClient";

jest.mock("axios");
const mockedAxiosGet = axios.get as unknown as jest.Mock;

const KEY_A = "a".repeat(64);

describe("oauthClient — DCR stateless client_id (any https client, no host allowlist)", () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
        process.env.LGM_TOKEN_SECRET = KEY_A;
    });

    afterEach(() => {
        process.env = { ...originalEnv };
    });

    it("seals a known-vendor redirect into a client_id and reads it back", () => {
        const clientId = issueClientId(["https://claude.ai/api/mcp/auth_callback"]);
        expect(clientId).not.toBeNull();
        expect(parseClientId(clientId as string)).toEqual({
            redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
        });
    });

    it("accepts an unknown / custom https source (the consent page warns, it does not block)", () => {
        expect(isAcceptableRedirectUri("https://tryallin.com/api/connections/oauth/callback")).toBe(true);
        const clientId = issueClientId(["https://tryallin.com/api/connections/oauth/callback"], "Allin");
        expect(parseClientId(clientId as string)).toEqual({
            redirectUris: ["https://tryallin.com/api/connections/oauth/callback"],
            clientName: "Allin",
        });
    });

    it("always accepts http localhost / 127.0.0.1 (CLI), rejects other http and junk", () => {
        expect(isAcceptableRedirectUri("http://localhost:3000/cb")).toBe(true);
        expect(isAcceptableRedirectUri("http://127.0.0.1/cb")).toBe(true);
        expect(isAcceptableRedirectUri("http://evil.example.com/cb")).toBe(false);
        expect(isAcceptableRedirectUri("ftp://claude.ai/cb")).toBe(false);
        expect(isAcceptableRedirectUri("not-a-url")).toBe(false);
    });

    it("returns null when no presented redirect_uri is https or loopback", () => {
        expect(issueClientId(["http://attacker.example.com/cb"])).toBeNull();
    });

    it("keeps only the acceptable redirects when mixing valid and invalid", () => {
        const clientId = issueClientId(["http://attacker.example.com/cb", "https://claude.ai/cb"]);
        expect(parseClientId(clientId as string)).toEqual({ redirectUris: ["https://claude.ai/cb"] });
    });

    it("authorizes a redirect_uri only if it belongs to the signed client_id", () => {
        const clientId = issueClientId(["https://claude.ai/cb"]) as string;
        expect(clientAllowsRedirectUri(clientId, "https://claude.ai/cb")).toBe(true);
        // https is acceptable in general, but this client only registered claude.ai/cb
        expect(clientAllowsRedirectUri(clientId, "https://chatgpt.com/cb")).toBe(false);
    });

    it("rejects a tampered / unknown client_id", () => {
        expect(parseClientId("garbage")).toBeNull();
        expect(clientAllowsRedirectUri("garbage", "https://claude.ai/cb")).toBe(false);
    });
});

describe("oauthClient — known vs unknown source (consent warning, never a block)", () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
        process.env = { ...originalEnv };
    });

    it("recognizes the built-in vendors, any path and any subdomain", () => {
        expect(isKnownRedirectUri("https://claude.ai/api/mcp/auth_callback")).toBe(true);
        expect(isKnownRedirectUri("https://auth.chatgpt.com/connector/cb")).toBe(true);
        expect(isKnownRedirectUri("https://platform.openai.com/cb")).toBe(true);
        expect(isKnownRedirectUri("https://claude.com/cb")).toBe(true);
    });

    it("treats a local CLI loopback as known", () => {
        expect(isKnownRedirectUri("http://localhost:3000/cb")).toBe(true);
        expect(isKnownRedirectUri("http://127.0.0.1/cb")).toBe(true);
    });

    it("flags a custom source and lookalike hosts as unknown", () => {
        expect(isKnownRedirectUri("https://tryallin.com/api/connections/oauth/callback")).toBe(false);
        expect(isKnownRedirectUri("https://notclaude.ai/cb")).toBe(false);
        expect(isKnownRedirectUri("https://claude.ai.attacker.com/cb")).toBe(false);
        expect(isKnownRedirectUri("not-a-url")).toBe(false);
    });

    it("extends the known list from env (new name, legacy name still read)", () => {
        process.env.OAUTH_KNOWN_REDIRECT_HOSTS = "tryallin.com";
        expect(isKnownRedirectUri("https://tryallin.com/cb")).toBe(true);
        delete process.env.OAUTH_KNOWN_REDIRECT_HOSTS;
        process.env.OAUTH_ALLOWED_REDIRECT_HOSTS = "clay.com";
        expect(isKnownRedirectUri("https://app.clay.com/cb")).toBe(true);
        expect(isKnownRedirectUri("https://tryallin.com/cb")).toBe(false);
    });
});

describe("oauthClient — CIMD metadata URL (SSRF bounds without a host allowlist)", () => {
    it("fetches only https URLs on a named host", () => {
        expect(isFetchableClientIdMetadataUrl("https://chatgpt.com/oauth/client.json")).toBe(true);
        expect(isFetchableClientIdMetadataUrl("https://custom-agent.example.com/client-metadata")).toBe(true);
    });

    it("refuses http, localhost, IP literals and junk", () => {
        expect(isFetchableClientIdMetadataUrl("http://example.com/client.json")).toBe(false);
        expect(isFetchableClientIdMetadataUrl("https://localhost/client.json")).toBe(false);
        expect(isFetchableClientIdMetadataUrl("https://127.0.0.1/client.json")).toBe(false);
        expect(isFetchableClientIdMetadataUrl("https://169.254.169.254/latest/meta-data")).toBe(false);
        expect(isFetchableClientIdMetadataUrl("https://[::1]/client.json")).toBe(false);
        expect(isFetchableClientIdMetadataUrl("https://foo.localhost/client.json")).toBe(false);
        expect(isFetchableClientIdMetadataUrl("https://example.com./client.json")).toBe(false);
        expect(isFetchableClientIdMetadataUrl("not-a-url")).toBe(false);
    });
});

describe("oauthClient — consent display integrity (tampered consent link)", () => {
    const sealedRedirect = "https://evil.example/cb";

    it("accepts the callback when the page echoes exactly what the server sent", () => {
        expect(consentDisplayMatches(sealedRedirect, { clientRedirect: sealedRedirect, sourceKnown: "false" })).toBe(true);
        expect(consentDisplayMatches("https://claude.ai/cb", { clientRedirect: "https://claude.ai/cb", sourceKnown: "true" })).toBe(true);
    });

    it("refuses a link rewritten to impersonate a known source", () => {
        // attacker rewrote client_redirect to claude.ai and source_known to true, authstate untouched
        expect(consentDisplayMatches(sealedRedirect, { clientRedirect: "https://claude.ai/cb", sourceKnown: "true" })).toBe(false);
        // attacker only hid the warning
        expect(consentDisplayMatches(sealedRedirect, { clientRedirect: sealedRedirect, sourceKnown: "true" })).toBe(false);
    });

    it("refuses a callback that does not echo the displayed values at all", () => {
        expect(consentDisplayMatches(sealedRedirect, {})).toBe(false);
        expect(consentDisplayMatches(sealedRedirect, { clientRedirect: sealedRedirect })).toBe(false);
    });
});

describe("oauthClient — private address detection (CIMD SSRF guard)", () => {
    it("flags loopback, private, link-local, CGNAT, metadata and multicast IPv4", () => {
        const privateAddresses = ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1"];
        for (const address of privateAddresses) {
            expect(isPrivateAddress(address)).toBe(true);
        }
    });

    it("flags loopback, unspecified, ULA, link-local and v4-mapped private IPv6", () => {
        const privateAddresses = ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:c0a8:101", "64:ff9b::7f00:1"];
        for (const address of privateAddresses) {
            expect(isPrivateAddress(address)).toBe(true);
        }
    });

    it("accepts public addresses and rejects anything that is not an IP", () => {
        expect(isPrivateAddress("104.18.32.7")).toBe(false);
        expect(isPrivateAddress("172.32.0.1")).toBe(false);
        expect(isPrivateAddress("2606:4700::6812:2007")).toBe(false);
        expect(isPrivateAddress("::ffff:104.18.32.7")).toBe(false);
        expect(isPrivateAddress("not-an-ip")).toBe(true);
    });
});

describe("oauthClient — CIMD metadata fetch (bounded outbound request)", () => {
    const clientId = "https://custom-agent.example.com/client-metadata";
    const publicLookup: HostnameLookup = async () => [{ address: "104.18.32.7", family: 4 }];
    const document = {
        client_id: clientId,
        client_name: "Custom Agent",
        redirect_uris: ["https://custom-agent.example.com/cb", "http://evil.example.com/cb"],
    };

    beforeEach(() => {
        mockedAxiosGet.mockReset();
        mockedAxiosGet.mockResolvedValue({ status: 200, data: document });
    });

    it("resolves the host and refuses it if any address is private", async () => {
        const mixed: HostnameLookup = async () => [
            { address: "104.18.32.7", family: 4 },
            { address: "127.0.0.1", family: 4 },
        ];
        expect(await resolvePublicAddress("rebinding.example", mixed)).toBeNull();
        expect(await resolvePublicAddress("nxdomain.example", async () => [])).toBeNull();
        expect(
            await resolvePublicAddress("failing.example", async () => {
                throw new Error("ENOTFOUND");
            }),
        ).toBeNull();
        expect(await resolvePublicAddress("public.example", publicLookup)).toEqual({ address: "104.18.32.7", family: 4 });
    });

    it("does not fetch when the host resolves to a private address", async () => {
        const privateLookup: HostnameLookup = async () => [{ address: "10.0.0.5", family: 4 }];
        expect(await fetchClientIdMetadata(clientId, privateLookup)).toBeNull();
        expect(mockedAxiosGet).not.toHaveBeenCalled();
    });

    it("does not fetch http, localhost, trailing-dot or IP-literal client_ids", async () => {
        const badClientIds = [
            "http://example.com/c.json",
            "https://localhost/c.json",
            "https://foo.localhost/c.json",
            "https://example.com./c.json",
            "https://127.0.0.1/c.json",
        ];
        for (const bad of badClientIds) {
            expect(await fetchClientIdMetadata(bad, publicLookup)).toBeNull();
        }
        expect(mockedAxiosGet).not.toHaveBeenCalled();
    });

    it("fetches with a short timeout, a size cap, no redirect and a connection pinned to the verified address", async () => {
        const registration = await fetchClientIdMetadata(clientId, publicLookup);
        expect(registration).toEqual({ redirectUris: ["https://custom-agent.example.com/cb"], clientName: "Custom Agent" });

        expect(mockedAxiosGet).toHaveBeenCalledTimes(1);
        const [url, config] = mockedAxiosGet.mock.calls[0];
        expect(url).toBe(clientId);
        expect(config.timeout).toBe(CLIENT_ID_METADATA_FETCH_OPTIONS.timeoutMs);
        expect(config.maxContentLength).toBe(CLIENT_ID_METADATA_FETCH_OPTIONS.maxContentLengthBytes);
        expect(config.maxRedirects).toBe(0);

        // the agent's lookup answers with the address we verified, never re-resolving the hostname
        const pinnedLookup = config.httpsAgent.options.lookup;
        await new Promise<void>((resolve) => {
            pinnedLookup("custom-agent.example.com", {}, (error: Error | null, address: string, family: number) => {
                expect(error).toBeNull();
                expect(address).toBe("104.18.32.7");
                expect(family).toBe(4);
                resolve();
            });
        });
        await new Promise<void>((resolve) => {
            pinnedLookup("custom-agent.example.com", { all: true }, (error: Error | null, addresses: unknown) => {
                expect(error).toBeNull();
                expect(addresses).toEqual([{ address: "104.18.32.7", family: 4 }]);
                resolve();
            });
        });
    });

    it("refuses a document that does not reference its own client_id, a non-200, no acceptable redirect, or a failed request", async () => {
        mockedAxiosGet.mockResolvedValueOnce({ status: 200, data: { ...document, client_id: "https://other.example/c.json" } });
        expect(await fetchClientIdMetadata(clientId, publicLookup)).toBeNull();

        mockedAxiosGet.mockResolvedValueOnce({ status: 301, data: document });
        expect(await fetchClientIdMetadata(clientId, publicLookup)).toBeNull();

        mockedAxiosGet.mockResolvedValueOnce({ status: 200, data: { ...document, redirect_uris: ["http://evil.example.com/cb"] } });
        expect(await fetchClientIdMetadata(clientId, publicLookup)).toBeNull();

        mockedAxiosGet.mockRejectedValueOnce(new Error("timeout of 5000ms exceeded"));
        expect(await fetchClientIdMetadata(clientId, publicLookup)).toBeNull();
    });
});
