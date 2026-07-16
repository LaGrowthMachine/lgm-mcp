/*
 * Copyright 2026 La Growth Machine
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */
import { seal } from "./tokens";
import {
    AccessTokenPayload,
    RefreshTokenPayload,
    ACCESS_TOKEN_TTL_SECONDS,
    REFRESH_TOKEN_TTL_SECONDS,
} from "./oauthEnvelopes";

export interface IssuedTokens {
    access_token: string;
    refresh_token: string;
    token_type: "Bearer";
    expires_in: number;
}

/**
 * Émet une paire access_token/refresh_token self-encodée pour un secret par-connecteur `lgmc_`.
 * Le secret est emballé dans les deux enveloppes ; il ne transite jamais en clair vers Claude.
 * Utilisé aussi bien à l'échange du code qu'au refresh (le refresh ré-émet une nouvelle paire).
 */
export const issueTokensForSecret = (secret: string): IssuedTokens => ({
    access_token: seal<AccessTokenPayload>("at", { secret }, ACCESS_TOKEN_TTL_SECONDS),
    refresh_token: seal<RefreshTokenPayload>("rt", { secret }, REFRESH_TOKEN_TTL_SECONDS),
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
});
