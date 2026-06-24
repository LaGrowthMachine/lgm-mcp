/*
 * Copyright 2026 La Growth Machine
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */
import express from "express";
import axios from "axios";
import { IncomingMessage } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

import { createMcpServer } from "./server";
import { requestContext, isAllowedApiUrl, getApiUrl } from "./requestContext";
import { resolveAccessToken } from "./accessToken";
import oauthRouter from "./oauth";

const PORT = parseInt(process.env.PORT || "3001", 10);
const TRANSPORT = process.env.LGM_MCP_TRANSPORT || "http";

const startHttpServer = async () => {
  const app = express();

  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  app.use(oauthRouter);

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", version: "1.0.0" });
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
          console.error(message);
          res.status(400).json({
            error: message,
          });
          return;
        }

        if (!bearer) {
          const base =
            process.env.MCP_BASE_URL || "https://mcpapp.lagrowthmachine.com";
          res.set(
            "WWW-Authenticate",
            `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
          );
          res.status(401).json({ error: "unauthorized" });
          return;
        }

        // Résout le bearer : access_token self-encodé (OAuth Model 2) → secret par-connecteur
        // `lgmc_` emballé ; sinon fallback clé maître brute des clients legacy (migration).
        const apiKey = resolveAccessToken(bearer);

        (req as IncomingMessage & { auth?: AuthInfo }).auth = {
          token: apiKey,
          clientId: "lgm-api-key",
          scopes: [],
        };

        await requestContext.run({ apiUrl: customApiUrl, apiKey }, async () => {
          await handler(req, res);
        });
      } catch (error) {
        console.error("Request context error:", error);
        if (!res.headersSent) {
          res.status(500).json({ error: "Internal server error" });
        }
      }
    };
  };

  const handleMcp = withRequestContext(
    async (req: express.Request, res: express.Response) => {
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
    console.log(`LGM MCP Server running on port ${PORT}`);
    console.log(`endpoint: ${getApiUrl()}`);
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
    console.error("[LGM] Starting stdio server...");
    const server = createMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("[LGM] Stdio server connected successfully");
  } catch (error) {
    console.error("[LGM] Stdio server error:", error);
    process.exit(1);
  }
};

if (TRANSPORT === "stdio") {
  startStdioServer().catch((error) => {
    console.error("Failed to start stdio server:", error);
    process.exit(1);
  });
} else {
  startHttpServer().catch((error) => {
    console.error("Failed to start HTTP server:", error);
    process.exit(1);
  });
}
