/*
 * Copyright 2026 La Growth Machine
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */
import { readFileSync } from "fs";
import { join } from "path";

// Version unique lue dans package.json (src/ et dist/ sont tous deux à un niveau sous la racine),
// pour que /health et le handshake MCP ne divergent plus du bundle publié.
const readVersion = (): string => {
  try {
    return (JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as { version: string }).version;
  } catch {
    return "0.0.0";
  }
};

export const VERSION = readVersion();
