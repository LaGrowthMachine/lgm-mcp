/*
 * Copyright 2026 La Growth Machine
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import { open } from "./tokens";
import { AccessTokenPayload } from "./oauthEnvelopes";

/**
 * Résout le bearer présenté sur /mcp en clé d'appel /flow :
 *  - access_token self-encodé (OAuth Model 2) → secret par-connecteur `lgmc_` emballé dedans.
 *  - sinon (FALLBACK MIGRATION) clé maître brute des clients legacy, renvoyée telle quelle.
 *
 * Le fallback est NON négociable avant prod : l'access_token des clients existants EST leur clé
 * maître brute. `open` ne lève jamais et renvoie null sur tout token non scellé (mauvais format,
 * mauvais typ, falsifié, expiré, ou LGM_TOKEN_SECRET absent) → on retombe sur la clé brute.
 */
export const resolveAccessToken = (bearer: string): string => {
    return open<AccessTokenPayload>(bearer, "at")?.secret ?? bearer;
};
