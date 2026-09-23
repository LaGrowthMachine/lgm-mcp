/*
 * Copyright 2026 La Growth Machine
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */
import axios from "axios";
import { getApiUrl, getWorkspaceId, getClientUserAgent } from "./requestContext";

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

// Le body d'erreur de l'API LGM est `{ error: string }` (voir HandleExternalApiErrorMiddleware
// côté lgm-apis) ; quelques routes renvoient `{ message: string }`. On en extrait le message
// réel pour le remonter tel quel au client MCP au lieu d'un texte générique — sinon une réponse
// "forbidden"/"not provisioned" arrive à l'assistant sous forme d'erreur vide de sens.
const extractServerMessage = (data: unknown): string | undefined => {
  if (!data || typeof data !== "object") return undefined;
  const body = data as Record<string, unknown>;
  if (typeof body.error === "string" && body.error.length > 0) return neutralizeUpsell(body.error);
  if (typeof body.message === "string" && body.message.length > 0) return neutralizeUpsell(body.message);
  return undefined;
};

// Les stores d'apps (ChatGPT plugins, Claude directory) interdisent toute incitation à
// l'abonnement / achat dans les réponses d'un tool. lgm-apis renvoie pourtant des messages
// commerciaux ("Please upgrade to…", "please subscribe", "recharge your credits") sur les
// features non incluses dans le plan ou à court de crédits : on les remplace par un constat
// factuel. Le reste des messages serveur passe tel quel.
const FEATURE_UNAVAILABLE = "This feature is not available on your account.";
const INSUFFICIENT_CREDITS = "Insufficient credits for this action.";
export const neutralizeUpsell = (message: string): string => {
  if (/recharge|not enough credits|insufficient credits/i.test(message)) return INSUFFICIENT_CREDITS;
  if (/upgrade|subscri|reactivate|trial/i.test(message)) return FEATURE_UNAVAILABLE;
  return message;
};

// UA sortant vers l'API : "mcp/<surface>" à partir de l'UA du client MCP entrant. Valeurs
// normalisées (pas l'UA brut) pour rester stables côté métriques/tracking lgm-apis, quel que
// soit le versionnage des clients. Sans contexte HTTP (stdio) ou client inconnu : "mcp".
const buildOutgoingUserAgent = (): string => {
  const clientUserAgent = (getClientUserAgent() || "").toLowerCase();
  if (clientUserAgent.includes("claude-code")) return "mcp/claude-code";
  if (clientUserAgent.includes("claude-user")) return "mcp/claude-web";
  return "mcp";
};

export const callFlow = async (
  apiKey: string,
  path: string,
  params?: Record<string, unknown>,
  options?: { method?: string; retries?: number; timeout?: number },
): Promise<unknown> => {
  const method = options?.method || "GET";
  const retries = options?.retries ?? MAX_RETRIES;
  const timeoutMs = options?.timeout ?? TIMEOUT_MS;

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
      "user-agent": buildOutgoingUserAgent(),
      // Canal d'intégration explicite (lu par detectExternalIntegration côté lgm-apis) : plus
      // robuste que le sniffing d'UA, l'UA ci-dessus porte le détail de la surface cliente.
      "x-lgm-integration": "mcp",
    },
    timeout: timeoutMs,
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
    // Un timeout client ne signifie PAS que l'action a échoué côté serveur : un envoi
    // (email / message LinkedIn) peut aboutir après que le client a coupé. On le remonte
    // comme tel — l'assistant doit relire le thread avant de retenter, sinon un retour
    // "timeout" déclenche un renvoi et duplique le message chez un vrai prospect.
    if (
      axios.isAxiosError(error) &&
      (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT")
    ) {
      throw new McpFlowError(
        `Request to LGM timed out after ${Math.round(timeoutMs / 1000)}s. ` +
          "The action MAY have completed on the server — for a send, re-read the conversation " +
          "with get_conversation_messages before retrying, to avoid sending a duplicate.",
        408,
      );
    }
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
      extractServerMessage(data) || FEATURE_UNAVAILABLE,
      403,
    );
  }

  if (status === 404) {
    throw new McpFlowError(extractServerMessage(data) || "Resource not found.", 404);
  }

  if (status === 400) {
    throw new McpFlowError(extractServerMessage(data) || "Bad request", 400);
  }

  if (status >= 500) {
    const serverMessage = extractServerMessage(data);
    // Un 5xx qui porte un message applicatif structuré n'est pas une panne transitoire : c'est
    // souvent un statut mal étiqueté côté API (ex: permission refusée / requête invalide renvoyée
    // en 500). Retry inutile — on remonte directement le vrai message au lieu de le masquer
    // derrière "LGM API unavailable".
    if (serverMessage) {
      throw new McpFlowError(serverMessage, status);
    }
    if (retries > 0) {
      const backoffMs = 1000 * (MAX_RETRIES - retries + 1);
      await sleep(backoffMs);
      return callFlow(apiKey, path, params, { method, retries: retries - 1 });
    }
    throw new McpFlowError("LGM API unavailable. Please try again later.", status);
  }

  return data;
};
