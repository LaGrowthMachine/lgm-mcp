/*
 * Copyright 2026 La Growth Machine
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server";
import { logger, errorFields } from "./logger";

const main = async () => {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
};

main().catch((error) => {
  logger.error("[LGM] Fatal error", errorFields(error));
  process.exit(1);
});
