/*
 * Copyright 2026 La Growth Machine
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */
import axios from "axios";
import { getApiUrl, getWorkspaceId } from "./requestContext";

const TIMEOUT_MS = 10_000;
const MAX_RETRIES = 2;

export class McpFlowError extends Error {
  public statusCode: number;
  public retryAfter?: number;

  constructor(message: string, statusCode: number, retryAfter?: number) {
    super(message);
    this.name = "McpFlowError";
    this.statusCode = statusCode;
    this.retryAfter = retryAfter;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const callFlow = async (
  apiKey: string,
  path: string,
  params?: Record<string, unknown>,
  options?: { method?: string; retries?: number },
): Promise<unknown> => {
  const method = options?.method || "GET";
  const retries = options?.retries ?? MAX_RETRIES;

  // `workspaceId` is a reserved cross-tool param (Model 2): it NEVER travels as a query/body field.
  // It selects the acting workspace via the X-LGM-Workspace header, carried by the request context
  // (set by registerWorkspaceAwareTool from the tool's `workspaceId` arg). We strip any stray
  // `workspaceId` from params here as a safety net so it can never leak into the query string.
  const { workspaceId: _strippedWorkspaceId, ...flowParams } = (params || {}) as Record<string, unknown> & {
    workspaceId?: unknown;
  };
  const hasFlowParams = Object.keys(flowParams).length > 0;
  const workspaceId = getWorkspaceId();

  const apiUrl = getApiUrl();
  const url = new URL(`/flow${path}`, apiUrl);

  if (method === "GET" && hasFlowParams) {
    Object.entries(flowParams).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    });
  }

  const axiosConfig = {
    method,
    url: url.toString(),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(workspaceId ? { "X-LGM-Workspace": workspaceId } : {}),
    },
    timeout: TIMEOUT_MS,
    data: method !== "GET" && hasFlowParams ? flowParams : undefined,
    validateStatus: () => true,
  };

  let status: number;
  let data: unknown;
  let headers: Record<string, string>;
  try {
    const response = await axios(axiosConfig);
    status = response.status;
    data = response.data;
    headers = response.headers as Record<string, string>;
  } catch (error) {
    console.error("Flow API network error:", error);
    throw error;
  }

  if (status === 429) {
    const retryAfter = parseInt(headers["retry-after"] || "60", 10);
    throw new McpFlowError(
      "Rate limit exceeded. Try again later.",
      429,
      retryAfter,
    );
  }

  if (status === 401) {
    throw new McpFlowError("Authentication failed. Check your API key.", 401);
  }

  if (status === 403) {
    throw new McpFlowError(
      "Permission denied. Your plan may not include this feature.",
      403,
    );
  }

  if (status === 404) {
    throw new McpFlowError("Resource not found.", 404);
  }

  if (status === 400) {
    const body = (data as Record<string, unknown>) || { error: "Bad request" };
    const message = body.error || "Bad request";
    throw new McpFlowError(String(message), 400);
  }

  if (status >= 500 && retries > 0) {
    const backoffMs = 1000 * (MAX_RETRIES - retries + 1);
    await sleep(backoffMs);
    return callFlow(apiKey, path, params, { method, retries: retries - 1 });
  }

  if (status >= 500) {
    throw new McpFlowError(
      "LGM API unavailable. Please try again later.",
      status,
    );
  }

  return data;
};
