/*
 * Copyright 2026 La Growth Machine
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */
// Journalisation du serveur : OTLP vers la plateforme de logs LGM (ClickStack / HyperDX) quand
// LOG_OTLP_ENDPOINT est défini, sinon la console. Variables :
//   LOG_OTLP_ENDPOINT=https://otlp.lagrowthmachine.xyz   (absent : console seule)
//   LOG_OTLP_API_KEY=...                                 (clé d'ingestion HyperDX de l'environnement)
//   LOG_SERVICE=mcp                                      (service.name côté HyperDX)
// Transport stdio (bundle Desktop) : stdout est le canal MCP, donc tout part sur stderr et l'OTLP
// est désactivé — un exporteur réseau n'a rien à faire dans un processus lancé par le poste client.
import os from "os";
import { AsyncLocalStorage } from "node:async_hooks";
import winston from "winston";
import { logs } from "@opentelemetry/api-logs";
import { LoggerProvider, BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { CompressionAlgorithm } from "@opentelemetry/otlp-exporter-base";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { OpenTelemetryTransportV3 } from "@opentelemetry/winston-transport";

export type LogFields = Record<string, unknown>;

export type Logger = {
  info: (message: string, fields?: LogFields) => void;
  warn: (message: string, fields?: LogFields) => void;
  error: (message: string, fields?: LogFields) => void;
};

// Champs d'une erreur inconnue : nom, message, pile. Jamais l'objet étalé — une AxiosError porte
// sa `config`, donc l'en-tête Authorization de la requête sortante.
export const errorFields = (error: unknown): LogFields => {
  if (error instanceof Error) {
    return { error: { name: error.name, message: error.message, stack: error.stack } };
  }
  return { error: { message: String(error) } };
};

// Champs communs à toutes les lignes d'une même requête HTTP (requestId), posés par le middleware
// d'accès et récupérés automatiquement ici : les lignes OAuth d'un même échange se corrèlent.
const ambient = new AsyncLocalStorage<LogFields>();

export const withLogFields = <T>(fields: LogFields, run: () => T): T => ambient.run(fields, run);

const isStdio = (): boolean => (process.env.LGM_MCP_TRANSPORT || "http") === "stdio";

// Un seul provider OTel par processus. Le BatchLogRecordProcessor met en file en mémoire et envoie
// toutes les secondes ou tous les 512 enregistrements, gzippé, avec réessais.
let provider: LoggerProvider | undefined;
const ensureProvider = (endpoint: string, apiKey: string, service: string, env: string) => {
  if (provider) return;
  provider = new LoggerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: service,
      "deployment.environment.name": env,
      "host.name": os.hostname(),
      "process.pid": process.pid,
    }),
    processors: [
      new BatchLogRecordProcessor({
        exporter: new OTLPLogExporter({
          url: `${endpoint.replace(/\/$/, "")}/v1/logs`,
          headers: { authorization: apiKey },
          compression: CompressionAlgorithm.GZIP,
        }),
        scheduledDelayMillis: 1000,
        maxExportBatchSize: 512,
        maxQueueSize: 8192, // au-delà, les plus anciens sont écartés : on protège la mémoire du serveur
      }),
    ],
  });
  logs.setGlobalLoggerProvider(provider);
  // Vider la file avant de mourir, sinon la dernière seconde de logs est perdue.
  const flush = () => provider?.shutdown().catch(() => undefined);
  process.once("SIGTERM", flush);
  process.once("SIGINT", flush);
  process.once("beforeExit", flush);
};

export const buildLogger = (): Logger => {
  const stdio = isStdio();
  const endpoint = stdio ? undefined : process.env.LOG_OTLP_ENDPOINT;
  const transports: winston.transport[] = [
    // stderrLevels sur tous les niveaux : rien ne doit jamais sortir sur stdout, réservé au
    // protocole MCP en transport stdio.
    new winston.transports.Console({ stderrLevels: ["error", "warn", "info", "debug"] }),
  ];
  if (endpoint) {
    ensureProvider(
      endpoint,
      process.env.LOG_OTLP_API_KEY || "",
      process.env.LOG_SERVICE || "mcp",
      process.env.NODE_ENV || "production",
    );
    transports.push(new OpenTelemetryTransportV3());
  }

  const winstonLogger = winston.createLogger({
    level: "info",
    // errors({ stack: true }) : la pile devient un champ au lieu d'être perdue.
    format: winston.format.combine(
      winston.format.errors({ stack: true }),
      winston.format.timestamp(),
      winston.format.json(),
    ),
    transports,
  });

  // `message` reste le corps de la ligne et n'est jamais recopié dans les champs : winston le
  // concatènerait au corps (corps doublé, vu sur Mikazo le 2026-09-18).
  const emit = (level: "info" | "warn" | "error", message: string, fields?: LogFields) => {
    const { message: _drop, ...rest } = { ...ambient.getStore(), ...fields } as LogFields;
    winstonLogger.log(level, message, rest);
  };

  return {
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
  };
};

export const logger = buildLogger();
