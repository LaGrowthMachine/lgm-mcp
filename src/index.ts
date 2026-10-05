/*
 * Copyright 2026 La Growth Machine
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */
import express from "express";
import axios from "axios";
import { randomUUID } from "node:crypto";
import { IncomingMessage } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

import { createMcpServer } from "./server";
import { requestContext, isAllowedApiUrl, getApiUrl } from "./requestContext";
import { resolveAccessToken } from "./accessToken";
import oauthRouter from "./oauth";
import { getBase, isAllowedAudience, OAUTH_SCOPES } from "./oauthConfig";
import { VERSION as version } from "./version";
import { logger, errorFields, withLogFields } from "./logger";

const PORT = parseInt(process.env.PORT || "3001", 10);
const TRANSPORT = process.env.LGM_MCP_TRANSPORT || "http";

const startHttpServer = async () => {
  const app = express();

  // Une ligne par requête, écrite quand la réponse est partie, et un requestId que les lignes
  // émises pendant la requête reprennent. Le chemin seul, jamais la query : /authorize/callback y
  // porte le code d'autorisation et l'authstate.
  app.use((req, res, next) => {
    const requestId = randomUUID();
    const start = process.hrtime.bigint();
    res.setHeader("x-request-id", requestId);
    withLogFields({ requestId }, () => {
      res.on("finish", () => {
        logger.info(`${req.method} ${req.path}`, {
          kind: "http",
          method: req.method,
          path: req.path,
          status: res.statusCode,
          durationMs: Math.round(Number(process.hrtime.bigint() - start) / 1e5) / 10,
          userAgent: req.headers["user-agent"] || "",
        });
      });
      next();
    });
  });

  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  app.use(oauthRouter);

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", version });
  });

  // Vérification de domaine du portail plugins OpenAI : le token fourni par le formulaire doit être
  // servi en texte brut sur ce chemin. Vide → 404 (rien à prouver).
  app.get("/.well-known/openai-apps-challenge", (_req, res) => {
    const token = process.env.OPENAI_APPS_CHALLENGE_TOKEN;
    if (!token) {
      res.status(404).type("text/plain").send("");
      return;
    }
    res.type("text/plain").send(token);
  });

  app.get("/health/ready", async (_req, res) => {
    try {
      await axios
        .head(`${getApiUrl()}/flow/members`, {
          timeout: 3000,
        })
        .catch(() => {
          // Ignore errors for readiness probe
        });
      res.json({ status: "ready" });
    } catch {
      res.status(503).json({ status: "not ready" });
    }
  });

  const extractApiKey = (req: express.Request): string | undefined => {
    const apiKeyHeader = req.headers["x-lgm-api-key"] as string | undefined;
    if (apiKeyHeader) return apiKeyHeader;

    const authHeader = req.headers["authorization"] as string | undefined;
    if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);

    return undefined;
  };

  const withRequestContext = (
    handler: (req: express.Request, res: express.Response) => Promise<void>,
  ) => {
    return async (req: express.Request, res: express.Response) => {
      try {
        const customApiUrl = req.headers["x-lgm-api-url"] as string | undefined;
        const bearer = extractApiKey(req);

        if (customApiUrl && !isAllowedApiUrl(customApiUrl)) {
          const message =
            "Invalid X-LGM-API-URL. Must be a *.lagrowthmachine.com, *.preview.lgmfeatureenv7.com, or localhost URL.";
          logger.warn(message, { kind: "http-reject", reason: "api_url_not_allowed" });
          res.status(400).json({
            error: message,
          });
          return;
        }

        // 401 RFC 9728 : `resource_metadata` pointe sur la métadonnée de LA ressource appelée
        // (racine ou /mcp) pour que `resource` matche exactement l'URL saisie par l'utilisateur.
        const unauthorized = (error: string): void => {
          const suffix = req.path === "/mcp" ? "/mcp" : "";
          res.set(
            "WWW-Authenticate",
            `Bearer error="${error}", resource_metadata="${getBase()}/.well-known/oauth-protected-resource${suffix}", scope="${OAUTH_SCOPES.join(" ")}"`,
          );
          res.status(401).json({ error });
        };

        if (!bearer) {
          unauthorized("unauthorized");
          return;
        }

        // Résout le bearer : access_token self-encodé (OAuth Model 2) → secret par-connecteur
        // `lgmc_` emballé ; sinon fallback clé maître brute des clients legacy (migration).
        const { apiKey, aud } = resolveAccessToken(bearer);
        // Audience (RFC 8707) : un access_token émis pour une autre ressource est refusé. Les tokens
        // sans `aud` (émis avant cet ajout, clés brutes) passent — migration sans flag-day.
        if (aud && !isAllowedAudience(aud)) {
          logger.warn(`[MCP] access_token audience mismatch aud=${aud}`);
          unauthorized("invalid_token");
          return;
        }

        (req as IncomingMessage & { auth?: AuthInfo }).auth = {
          token: apiKey,
          clientId: "lgm-api-key",
          scopes: [],
        };

        await requestContext.run(
          { apiUrl: customApiUrl, apiKey, clientUserAgent: req.headers["user-agent"] },
          async () => {
            await handler(req, res);
          },
        );
      } catch (error) {
        logger.error("Request context error", errorFields(error));
        if (!res.headersSent) {
          res.status(500).json({ error: "Internal server error" });
        }
      }
    };
  };

  const handleMcp = withRequestContext(
    async (req: express.Request, res: express.Response) => {
      // Observabilité client : le user-agent est le seul signal identifiant la surface qui nous
      // appelle (claude.ai / Claude Code / autre). Loggé après auth pour ne pas tracer les probes.
      logger.info(`[MCP] ${req.method} ua="${req.headers["user-agent"] || ""}"`, { kind: "mcp" });

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      const server = createMcpServer();
      await server.connect(transport);

      await transport.handleRequest(req, res, req.body);
    },
  );

  app.post("/mcp", handleMcp);
  app.get("/mcp", handleMcp);
  app.delete("/mcp", handleMcp);

  // MCP également servi à la racine, pour que l'URL du connecteur puisse être l'hôte nu
  // (ex. https://mcpv2.lagrowthmachine.com). Express fait correspondre "/" au chemin racine
  // EXACTEMENT — ça ne masque donc ni /health, ni /.well-known/*, ni les routes OAuth.
  // `/mcp` reste actif comme alias (rétro-compat).
  app.post("/", handleMcp);
  app.get("/", handleMcp);
  app.delete("/", handleMcp);

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  const httpServer = app.listen(PORT, () => {
    logger.info(`LGM MCP Server running on port ${PORT}`, { version, apiUrl: getApiUrl() });
  });

  const shutdown = () => {
    httpServer.close(() => {
      process.exit(0);
    });

    setTimeout(() => {
      process.exit(1);
    }, 5000);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
};

const startStdioServer = async () => {
  try {
    logger.info("[LGM] Starting stdio server...");
    const server = createMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info("[LGM] Stdio server connected successfully");
  } catch (error) {
    logger.error("[LGM] Stdio server error", errorFields(error));
    process.exit(1);
  }
};

if (TRANSPORT === "stdio") {
  startStdioServer().catch((error) => {
    logger.error("Failed to start stdio server", errorFields(error));
    process.exit(1);
  });
} else {
  startHttpServer().catch((error) => {
    logger.error("Failed to start HTTP server", errorFields(error));
    process.exit(1);
  });
}
