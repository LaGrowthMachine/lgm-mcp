/*
 * Copyright 2026 La Growth Machine
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */
import axios from "axios";
import { callFlow } from "./callFlow";
import { requestContext } from "./requestContext";

jest.mock("axios");
const mockedAxios = axios as unknown as jest.Mock;

const okResponse = { status: 200, data: { ok: true }, headers: {} };

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
