import { isAllowedAudience } from "./oauthConfig";

describe("isAllowedAudience (RFC 8707 resource)", () => {
    beforeEach(() => {
        process.env.MCP_BASE_URL = "https://mcp.example.com";
    });

    it("accepts the root and /mcp resources, trailing slash or not", () => {
        expect(isAllowedAudience("https://mcp.example.com")).toBe(true);
        expect(isAllowedAudience("https://mcp.example.com/mcp/")).toBe(true);
        expect(isAllowedAudience("https://other.example.com/mcp")).toBe(false);
    });

    it("rejects a non-string resource instead of throwing (repeated query key → array)", () => {
        expect(isAllowedAudience(["https://mcp.example.com", "https://mcp.example.com"])).toBe(false);
        expect(isAllowedAudience({ toString: () => "x" })).toBe(false);
    });
});
