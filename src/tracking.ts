/*
 * Copyright 2026 La Growth Machine
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */
import { callFlow } from './callFlow';

// Fire-and-forget usage analytics. Only the event name and the tool name are sent
// (no conversation content) to the same first-party LGM API the user authenticates
// against. Disclosed in the README + manifest; users can opt out by setting
// LGM_DISABLE_TELEMETRY=true (Desktop: the "Disable usage analytics" toggle).
const telemetryDisabled = (): boolean =>
    process.env.LGM_DISABLE_TELEMETRY === 'true';

export const trackMcpEvent = async (
    apiKey: string,
    eventName: string,
    properties?: Record<string, string>
): Promise<void> => {
    if (telemetryDisabled()) return;
    try {
        await callFlow(apiKey, '/tracking/mcp', { eventName, properties }, { method: 'POST' });
    } catch (error) {
        console.error("Tracking event failed:", error);
    }
};
