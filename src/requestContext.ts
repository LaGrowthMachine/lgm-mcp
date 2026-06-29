/*
 * Copyright 2026 La Growth Machine
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */
import { AsyncLocalStorage } from "node:async_hooks";

interface RequestContext {
  apiUrl?: string;
  apiKey?: string;
  // Workspace ciblé pour l'appel courant (Model 2). Posé par tool depuis son param `workspaceId`,
  // lu par callFlow pour le header X-LGM-Workspace. Absent = workspace racine du humain (cas courant).
  workspaceId?: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

const ALLOWED_API_URL_PATTERNS = [
  /^https:\/\/([a-z0-9-]+\.)*lagrowthmachine\.com$/,
  /^https:\/\/([a-z0-9-]+\.)*lagrowthmachine\.xyz$/,
  /^https:\/\/[a-z0-9-]+\.preview\.lgmfeatureenv7\.com$/,
  /^http:\/\/localhost(:\d+)?$/,
  /^http:\/\/127\.0\.0\.1(:\d+)?$/,
];

export const isAllowedApiUrl = (url: string): boolean => {
  return ALLOWED_API_URL_PATTERNS.some((pattern) => pattern.test(url));
};

const resolveEnvUrl = (value?: string): string | undefined => {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("${")) return undefined;
  return trimmed;
};

export const getApiUrl = (): string => {
  const context = requestContext.getStore();
  return (
    context?.apiUrl ||
    resolveEnvUrl(process.env.LGM_API_URL) ||
    "https://apiv2.lagrowthmachine.com"
  );
};

export const getApiKey = (): string => {
  const context = requestContext.getStore();
  return context?.apiKey || process.env.LGM_API_KEY || "";
};

export const getWorkspaceId = (): string | undefined => {
  return requestContext.getStore()?.workspaceId;
};
