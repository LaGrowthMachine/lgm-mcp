/*
 * Copyright 2026 La Growth Machine
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */
import axios from "axios";
import { callFlow, McpFlowError } from "./callFlow";
import { requestContext } from "./requestContext";

jest.mock("axios");
const mockedAxios = axios as unknown as jest.Mock;

const okResponse = { status: 200, data: { ok: true }, headers: {} };

const runInContext = (fn: () => Promise<unknown>): Promise<unknown> =>
    requestContext.run({ apiUrl: "https://apiv2.lagrowthmachine.com" }, fn);

describe("callFlow — X-LGM-Workspace header (Model 2)", () => {
    beforeEach(() => {
        mockedAxios.mockReset();
        mockedAxios.mockResolvedValue(okResponse);
    });

    const lastConfig = (): { headers: Record<string, string>; url: string; data?: unknown } => mockedAxios.mock.calls[0][0];

    it("sets X-LGM-Workspace from the request context when a workspace is targeted", async () => {
        await requestContext.run({ apiUrl: "https://apiv2.lagrowthmachine.com", workspaceId: "ws_123" }, async () => {
            await callFlow("lgmc_secret", "/campaigns");
        });

        expect(lastConfig().headers["X-LGM-Workspace"]).toBe("ws_123");
        expect(lastConfig().headers.Authorization).toBe("Bearer lgmc_secret");
    });

    it("omits X-LGM-Workspace entirely when no workspace is targeted (the common case)", async () => {
        await requestContext.run({ apiUrl: "https://apiv2.lagrowthmachine.com" }, async () => {
            await callFlow("lgmc_secret", "/campaigns");
        });

        expect(lastConfig().headers["X-LGM-Workspace"]).toBeUndefined();
    });

    it("never leaks a stray workspaceId param into the query string", async () => {
        await requestContext.run({ apiUrl: "https://apiv2.lagrowthmachine.com", workspaceId: "ws_123" }, async () => {
            await callFlow("lgmc_secret", "/campaigns", { status: "RUNNING", workspaceId: "ws_should_not_leak" });
        });

        const url = new URL(lastConfig().url);
        expect(url.searchParams.get("status")).toBe("RUNNING");
        expect(url.searchParams.get("workspaceId")).toBeNull();
    });

    it("strips workspaceId from a POST body as well", async () => {
        await requestContext.run({ apiUrl: "https://apiv2.lagrowthmachine.com", workspaceId: "ws_123" }, async () => {
            await callFlow("lgmc_secret", "/audiences", { audience: "Leads", workspaceId: "ws_should_not_leak" }, { method: "POST" });
        });

        expect(lastConfig().data).toEqual({ audience: "Leads" });
        expect(lastConfig().headers["X-LGM-Workspace"]).toBe("ws_123");
    });
});

describe("callFlow — surfacing the server's real error message", () => {
    beforeEach(() => {
        mockedAxios.mockReset();
    });

    it("surfaces the API error body on a 500 instead of the generic 'unavailable' message, and does not retry", async () => {
        mockedAxios.mockResolvedValue({
            status: 500,
            data: { error: "This feature requires the Ultimate plan. Please contact your Client Partner or support to activate it." },
            headers: {},
        });

        const error = await runInContext(() => callFlow("lgmc_secret", "/mcp/bigquery/query", {}, { method: "POST" })).catch((e) => e);
        expect(error).toBeInstanceOf(McpFlowError);
        expect(error).toMatchObject({
            statusCode: 500,
            message: "This feature requires the Ultimate plan. Please contact your Client Partner or support to activate it.",
        });
        // A structured application error is not transient — no retry should be attempted.
        expect(mockedAxios).toHaveBeenCalledTimes(1);
    });

    it("still retries and reports 'unavailable' when a 5xx has no structured error body", async () => {
        mockedAxios.mockResolvedValue({ status: 503, data: "<html>gateway</html>", headers: {} });

        await expect(runInContext(() => callFlow("lgmc_secret", "/campaigns"))).rejects.toMatchObject({
            statusCode: 503,
            message: "LGM API unavailable. Please try again later.",
        });
        // Initial call + MAX_RETRIES (2) retries.
        expect(mockedAxios).toHaveBeenCalledTimes(3);
    });

    it("surfaces the API message on a 404 (e.g. workspace not provisioned) instead of the generic text", async () => {
        mockedAxios.mockResolvedValue({
            status: 404,
            data: { error: "This workspace is not provisioned for BigQuery MCP." },
            headers: {},
        });

        await expect(runInContext(() => callFlow("lgmc_secret", "/mcp/bigquery/query", {}, { method: "POST" }))).rejects.toMatchObject({
            statusCode: 404,
            message: "This workspace is not provisioned for BigQuery MCP.",
        });
    });

    it("surfaces the API message on a genuine 403 instead of the hardcoded fallback", async () => {
        mockedAxios.mockResolvedValue({ status: 403, data: { error: "Your workspace membership was revoked." }, headers: {} });

        await expect(runInContext(() => callFlow("lgmc_secret", "/campaigns"))).rejects.toMatchObject({
            statusCode: 403,
            message: "Your workspace membership was revoked.",
        });
    });

    it("falls back to a sane default when the error body carries no message", async () => {
        mockedAxios.mockResolvedValue({ status: 403, data: {}, headers: {} });

        await expect(runInContext(() => callFlow("lgmc_secret", "/campaigns"))).rejects.toMatchObject({
            statusCode: 403,
            message: "This feature is not available on your account.",
        });
    });
});
