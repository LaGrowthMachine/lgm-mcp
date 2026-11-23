/*
 * Copyright 2026 La Growth Machine — Apache-2.0.
 * Auto-generated from lgm-apis bigquery-logs-guide.md. Source of truth is lgm-apis.
 */
export const BIGQUERY_LOGS_GUIDE = `# BigQuery \`logs\` — MCP query guide (workspace-scoped)

This guide is the source of truth for writing queries through the MCP
\`ask_your_outbound\` tool. It is adapted to the workspace-scoped MCP path:
you query a single logical table \`logs\`, results are automatically restricted to
the current LGM workspace, and everything is enforced server-side.

All definitions below were verified against the real production data.

---

## 1. What the table is

\`logs\` is an **event table**: **one row = one timestamped campaign action** for a
lead (an invitation sent, a message sent, a reply detected, an email opened, a
bounce, …). It is not a table of final business objects — you almost always need
to **aggregate** to rebuild a funnel, a rate, or a state.

Because a single lead produces many events, business metrics count **distinct
leads**, not rows.

---

## 2. Golden rules (queries breaking these are rejected server-side)

1. **Table name**: write \`FROM logs\` — never a project/dataset path, never backticks.
2. **SELECT only**: no \`*\`, no DML/DDL, no \`INFORMATION_SCHEMA\`.
3. **Always filter the partition** \`date\` (type \`DATE\`, day only):
   \`\`\`sql
   WHERE date >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)
   \`\`\`
4. **Distinct leads for business metrics**: \`COUNT(DISTINCT leadId)\`, not \`COUNT(*)\`.
5. **Rates**: always \`SAFE_DIVIDE(numerator, denominator)\` (never \`/\`).
6. **Outbound actions must be successful**: filter \`status = 'SUCCESS'\` on outbound
   actions (send/invite/message) — a \`FAILED\` row is an action that was never actually sent.
7. Never filter or group by \`userId\` — it is always the current workspace.

---

## 3. Columns

| Column | Type | Notes |
|---|---|---|
| \`date\` | DATE | partition (day only). Use for filtering / grouping by day. **Required in WHERE.** |
| \`createdAt\` | TIMESTAMP | precise event time. Use **only** for hour-level delays (\`TIMESTAMP_DIFF\`). |
| \`type\` | STRING | the action performed (see §4). Most important field. |
| \`status\` | STRING | \`'SUCCESS'\` or \`'FAILED'\`. Filter \`'SUCCESS'\` on outbound actions. |
| \`leadId\` | STRING | the targeted lead. Core of every conversion metric. |
| \`campaignId\` | STRING | campaign. May be NULL for out-of-campaign actions → add \`campaignId IS NOT NULL\`. |
| \`identityId\` | STRING | the sending identity (LinkedIn/email profile). One workspace has several. |
| \`stepId\` | STRING | campaign step. May be NULL. |
| \`templateId\` | STRING | template used. For \`LINKEDIN_ADD_CONTACT\`, non-NULL = invitation **with a note**. |
| \`channel\` | STRING | \`'LINKEDIN'\`, \`'EMAIL'\`, \`'LGM'\`, … |
| \`message\` | STRING | message content. |

---

## 4. Action types that matter

The table contains ~90 raw types (most are internal: \`LGM_*\`, \`HUBSPOT_*\`,
\`API_TRIGGER\`, checks…). The business-relevant prospecting types are:

**Outbound (require \`status='SUCCESS'\`)**
| type | meaning |
|---|---|
| \`LINKEDIN_ADD_CONTACT\` | LinkedIn invitation. **With a note** iff \`templateId IS NOT NULL\`. |
| \`LINKEDIN_DIRECT_MESSAGE\` | LinkedIn message sent. |
| \`LINKEDIN_DIRECT_VOICE\` | LinkedIn voice note sent. |
| \`LINKEDIN_LIKE_POST\` | like on the lead's post (engagement, low signal). |
| \`GOOGLE_SEND_EMAIL\` | email sent. |

**Replies — strong conversion (no status filter)**
| type | meaning |
|---|---|
| \`LINKEDIN_HAS_REPLY\` | lead replied on LinkedIn. |
| \`GOOGLE_REPLY\` | lead replied by email. |

**Email engagement (no status filter)**
| type | meaning |
|---|---|
| \`GOOGLE_OPENED\` | email opened. Volumetric proxy — it contains the real open events (\`GOOGLE_ON_OPEN ⊂ GOOGLE_OPENED\`). Noisy (Apple MPP, proxies). |
| \`GOOGLE_HAS_CLICKED\` | link clicked (stronger than open; contains the real \`GOOGLE_ON_CLICKED\`). |
| \`GOOGLE_CHECK_BOUNCE\` | email bounced (all rows are actual bounces). |

> Use \`GOOGLE_OPENED\` / \`GOOGLE_HAS_CLICKED\`, **not** the \`GOOGLE_ON_*\` variants:
> the \`_ON_\` webhook events are heavily under-logged. Ignore \`GOOGLE_NOT_OPENED\`,
> \`GOOGLE_HAS_NOT_CLICKED\`, \`GOOGLE_NO_REPLY\` — those are campaign-flow condition checks.
>
> **A click implies an open**: \`opened\` must include clickers (open OR click), otherwise
> the funnel can show more clicks than opens.

> **\`GOOGLE_*\` = every email provider**, not just Gmail. Email logs are prefixed
> \`GOOGLE_\` regardless of the connected mailbox (SMTP, GSUITE, OUTLOOK, …). Never
> assume the provider from the prefix — an Outlook or SMTP sender still logs \`GOOGLE_SEND_EMAIL\`,
> \`GOOGLE_OPENED\`, \`GOOGLE_REPLY\`, etc.

> A lead can appear several times per type (multiple opens, replies, messages).
> Always dedupe with \`COUNT(DISTINCT leadId)\` for conversion metrics.

---

## 5. Verified metric definitions

**Leads contacted** — distinct leads with at least one successful outbound action
(LinkedIn invitation counts only when it carries a note):
\`\`\`sql
COUNT(DISTINCT IF(
  status = 'SUCCESS' AND (
    (type = 'LINKEDIN_ADD_CONTACT' AND templateId IS NOT NULL)
    OR type IN ('LINKEDIN_DIRECT_MESSAGE', 'LINKEDIN_DIRECT_VOICE', 'GOOGLE_SEND_EMAIL')
  ), leadId, NULL))
\`\`\`

**Leads contacted by email**
\`\`\`sql
COUNT(DISTINCT IF(status = 'SUCCESS' AND type = 'GOOGLE_SEND_EMAIL', leadId, NULL))
\`\`\`

**Leads contacted on LinkedIn**
\`\`\`sql
COUNT(DISTINCT IF(status = 'SUCCESS' AND (
  (type = 'LINKEDIN_ADD_CONTACT' AND templateId IS NOT NULL)
  OR type IN ('LINKEDIN_DIRECT_MESSAGE', 'LINKEDIN_DIRECT_VOICE')
), leadId, NULL))
\`\`\`

**Leads who replied** (inbound, no status filter)
\`\`\`sql
COUNT(DISTINCT IF(type IN ('LINKEDIN_HAS_REPLY', 'GOOGLE_REPLY'), leadId, NULL))
\`\`\`

**Opened / clicked / bounced** (email, no status filter)
\`\`\`sql
-- opened: a click implies an open, so include clickers
COUNT(DISTINCT IF(type IN ('GOOGLE_OPENED', 'GOOGLE_HAS_CLICKED'), leadId, NULL))  -- opened
COUNT(DISTINCT IF(type = 'GOOGLE_HAS_CLICKED', leadId, NULL))                      -- clicked
COUNT(DISTINCT IF(type = 'GOOGLE_CHECK_BOUNCE', leadId, NULL))                     -- bounced
\`\`\`

Rates = replied/opened/… \`SAFE_DIVIDE\`d by the matching denominator (contacted, or
emailed for email rates).

---

## 6. Ready-to-use queries

### 6.1 Action volume by type (last 30 days)
\`\`\`sql
SELECT
  type,
  COUNT(*) AS events,
  COUNT(DISTINCT leadId) AS distinct_leads
FROM logs
WHERE date >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)
  AND status = 'SUCCESS'
GROUP BY type
ORDER BY events DESC;
\`\`\`

### 6.2 Reply rate by campaign (this year)
\`\`\`sql
SELECT
  campaignId,
  COUNT(DISTINCT IF(
    status = 'SUCCESS' AND (
      (type = 'LINKEDIN_ADD_CONTACT' AND templateId IS NOT NULL)
      OR type IN ('LINKEDIN_DIRECT_MESSAGE', 'LINKEDIN_DIRECT_VOICE', 'GOOGLE_SEND_EMAIL')
    ), leadId, NULL)) AS contacted_leads,
  COUNT(DISTINCT IF(type IN ('LINKEDIN_HAS_REPLY', 'GOOGLE_REPLY'), leadId, NULL)) AS replied_leads,
  SAFE_DIVIDE(
    COUNT(DISTINCT IF(type IN ('LINKEDIN_HAS_REPLY', 'GOOGLE_REPLY'), leadId, NULL)),
    COUNT(DISTINCT IF(
      status = 'SUCCESS' AND (
        (type = 'LINKEDIN_ADD_CONTACT' AND templateId IS NOT NULL)
        OR type IN ('LINKEDIN_DIRECT_MESSAGE', 'LINKEDIN_DIRECT_VOICE', 'GOOGLE_SEND_EMAIL')
      ), leadId, NULL))
  ) AS reply_rate
FROM logs
WHERE date >= DATE('2025-01-01')
  AND campaignId IS NOT NULL
GROUP BY campaignId
ORDER BY reply_rate DESC;
\`\`\`

### 6.3 Email funnel by campaign (last 90 days)
\`\`\`sql
SELECT
  campaignId,
  COUNT(DISTINCT IF(status = 'SUCCESS' AND type = 'GOOGLE_SEND_EMAIL', leadId, NULL)) AS emailed_leads,
  COUNT(DISTINCT IF(type IN ('GOOGLE_OPENED', 'GOOGLE_HAS_CLICKED'), leadId, NULL)) AS opened_leads,
  COUNT(DISTINCT IF(type = 'GOOGLE_HAS_CLICKED', leadId, NULL)) AS clicked_leads,
  COUNT(DISTINCT IF(type = 'GOOGLE_REPLY', leadId, NULL)) AS replied_leads,
  COUNT(DISTINCT IF(type = 'GOOGLE_CHECK_BOUNCE', leadId, NULL)) AS bounced_leads,
  SAFE_DIVIDE(
    COUNT(DISTINCT IF(type IN ('GOOGLE_OPENED', 'GOOGLE_HAS_CLICKED'), leadId, NULL)),
    COUNT(DISTINCT IF(status = 'SUCCESS' AND type = 'GOOGLE_SEND_EMAIL', leadId, NULL))
  ) AS open_rate,
  SAFE_DIVIDE(
    COUNT(DISTINCT IF(type = 'GOOGLE_REPLY', leadId, NULL)),
    COUNT(DISTINCT IF(status = 'SUCCESS' AND type = 'GOOGLE_SEND_EMAIL', leadId, NULL))
  ) AS email_reply_rate
FROM logs
WHERE date >= DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY)
  AND campaignId IS NOT NULL
GROUP BY campaignId
ORDER BY email_reply_rate DESC;
\`\`\`

### 6.4 Daily activity
\`\`\`sql
SELECT date, type, COUNT(DISTINCT leadId) AS distinct_leads
FROM logs
WHERE date >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)
  AND status = 'SUCCESS'
GROUP BY date, type
ORDER BY date DESC;
\`\`\`

---

## 7. Advanced — reply time (uses \`createdAt\` for hour precision)

\`\`\`sql
WITH first_contact AS (
  SELECT campaignId, leadId, MIN(createdAt) AS contacted_at
  FROM logs
  WHERE date >= DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY)
    AND status = 'SUCCESS'
    AND (
      (type = 'LINKEDIN_ADD_CONTACT' AND templateId IS NOT NULL)
      OR type IN ('LINKEDIN_DIRECT_MESSAGE', 'LINKEDIN_DIRECT_VOICE', 'GOOGLE_SEND_EMAIL')
    )
    AND campaignId IS NOT NULL AND leadId IS NOT NULL
  GROUP BY campaignId, leadId
),
first_reply AS (
  SELECT campaignId, leadId, MIN(createdAt) AS replied_at
  FROM logs
  WHERE date >= DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY)
    AND type IN ('LINKEDIN_HAS_REPLY', 'GOOGLE_REPLY')
    AND campaignId IS NOT NULL AND leadId IS NOT NULL
  GROUP BY campaignId, leadId
)
SELECT
  fc.campaignId,
  COUNT(*) AS contacted_leads,
  COUNT(fr.leadId) AS replied_leads,
  AVG(TIMESTAMP_DIFF(fr.replied_at, fc.contacted_at, HOUR)) AS avg_hours_to_reply
FROM first_contact fc
LEFT JOIN first_reply fr
  ON fc.campaignId = fr.campaignId AND fc.leadId = fr.leadId
  AND fr.replied_at >= fc.contacted_at
GROUP BY fc.campaignId
ORDER BY replied_leads DESC;
\`\`\`

---

## 8. Pitfalls

- **Don't count rows for conversions** — a lead has many events. Use \`COUNT(DISTINCT leadId)\`.
- **Don't forget \`status='SUCCESS'\` on outbound** — otherwise failed sends inflate "contacted".
- **\`date\` is a DATE (no time)** — for delays use \`createdAt\`, not \`date\`.
- **Don't compare very recent campaigns** — they haven't had time to get replies.
- **Open rate is noisy** (Apple Mail Privacy, proxies) — treat as indicative.
- **Split channels when relevant** — LinkedIn vs email (\`STARTS_WITH(type, 'LINKEDIN_')\` / \`'GOOGLE_'\`).
- Add \`campaignId IS NOT NULL\` for per-campaign analysis; \`leadId IS NOT NULL\` for lead rates.

---

## 9. Appendix — full \`type\` dictionary

Every \`type\` present in the table. Almost all are queryable and useful.
Two usage notes:
- For engagement **counts**, prefer the \`HAS_*\` / \`OPENED\` variants over the \`_ON_*\`
  webhook variants (the \`_ON_*\` events are under-logged) — but the \`_ON_*\` rows are still
  real events you can query.
- The only row to treat as pure noise is \`LGM_ADD_DELAY\` (scheduling delay).

### LinkedIn
| type | description |
|---|---|
| \`LINKEDIN_ADD_CONTACT\` | invitation sent (counts as a real contact only WITH a note, templateId not null) |
| \`LINKEDIN_DIRECT_MESSAGE\` | message sent |
| \`LINKEDIN_DIRECT_VOICE\` | voice note sent |
| \`LINKEDIN_LIKE_POST\` | liked the lead's post (engagement) |
| \`LINKEDIN_FOLLOW\` | followed the lead |
| \`LINKEDIN_HAS_REPLY\` | lead replied (use this for reply metrics) |
| \`LINKEDIN_ON_REPLY\` | reply webhook event (near-duplicate of HAS_REPLY) |
| \`LINKEDIN_ACCEPT_REQUEST\` | invitation accepted by the lead |
| \`LINKEDIN_ON_ACCEPT_REQUEST\` | acceptance webhook event (near-duplicate) |
| \`LINKEDIN_NEW_RELATION_ADDED\` | a NEW LinkedIn connection was established (lead accepted, not connected before) |
| \`LINKEDIN_NEW_RELATION\` | relation detected (includes already-connected leads). \`NEW_RELATION\` minus \`NEW_RELATION_ADDED\` ≈ leads that were already a connection beforehand |
| \`LINKEDIN_CONNECTION_REQUEST_WITHDREW\` | invitation withdrawn |
| \`LINKEDIN_DENY_REQUEST\` | invitation denied/expired |
| \`LINKEDIN_CHECK_REQUEST_ACCEPTED\` | check whether the invitation was accepted (flow) |
| \`LINKEDIN_HAS_NOT_REPLY\` | condition: lead did NOT reply (find non-repliers) |
| \`LINKEDIN_ADD_CONTACT_SKIPPED\` | invitation skipped |
| \`LINKEDIN_STOP_ADD_CONTACT\` | add-contact stopped |
| \`LINKEDIN_VISIT_PROFILE\` | lead's profile visited |
| \`LINKEDIN_VISIT_ENRICH\` | profile visited for enrichment |
| \`LINKEDIN_VISIT_LIMIT_DECREASE\` | visit quota decremented (technical) |
| \`LINKEDIN_NO_VISIT_BACK\` | lead did not visit back |
| \`LINKEDIN_ENRICH_CONTACT\` | contact enriched from LinkedIn |
| \`LINKEDIN_IS_ACTIVE\` / \`LINKEDIN_IS_NOT_ACTIVE\` | lead's LinkedIn profile detected active / inactive |

### Email (GOOGLE_* = all providers: SMTP, GSUITE, OUTLOOK…)
| type | description |
|---|---|
| \`GOOGLE_SEND_EMAIL\` | email sent |
| \`GOOGLE_OPENED\` | opened (volumetric proxy; use this) |
| \`GOOGLE_ON_OPEN\` | open webhook event (under-logged) |
| \`GOOGLE_HAS_CLICKED\` | clicked (use this) |
| \`GOOGLE_ON_CLICKED\` | click webhook event (under-logged) |
| \`GOOGLE_REPLY\` | lead replied by email |
| \`GOOGLE_CHECK_BOUNCE\` | bounced |
| \`GOOGLE_ON_BOUNCED\` | bounce webhook event (near-duplicate) |
| \`GOOGLE_NOT_OPENED\` / \`GOOGLE_HAS_NOT_CLICKED\` / \`GOOGLE_NO_REPLY\` | conditions: did NOT open / click / reply (find non-engaged leads) |
| \`EMAIL_UNSUBSCRIBED\` | lead unsubscribed |
| \`EMAIL_RESUBSCRIBED\` | lead resubscribed |

### Twitter
| type | description |
|---|---|
| \`TWITTER_FOLLOW\` / \`TWITTER_UNFOLLOW\` / \`TWITTER_FOLLOW_BACK\` / \`TWITTER_DONT_FOLLOW_BACK\` | follow lifecycle |
| \`TWITTER_SEND_MESSAGE\` | DM sent |
| \`TWITTER_FAVOURITE\` / \`TWITTER_RETWEET\` / \`TWITTER_TWEET\` | engagement |

### Manual tasks
| type | description |
|---|---|
| \`MANUAL_TASK_CALL_DECISIVE\` | call marked decisive |
| \`MANUAL_TASK_CALL_UNREACHABLE\` | call — lead unreachable |
| \`MANUAL_TASK_CUSTOM_MESSAGE\` | manual custom-message task |
| \`MANUAL_TASK_INVITE_NOTE\` | manual invite-note task |

### Lifecycle / campaign / conversion
| type | description |
|---|---|
| \`START\` | **lead activated / started in the sequence** (activation marker) |
| \`LGM_CONVERTED\` | lead converted |
| \`LGM_ADD_TO_CAMPAIGN\` | lead added to a campaign |
| \`LGM_CAMPAIGN_COMPLETED\` | lead finished the campaign |
| \`LGM_END_CAMPAIGN\` | campaign ended for the lead |
| \`LGM_LEAD_CAMPAIGN_PAUSED\` / \`LGM_LEAD_CAMPAIGN_RESUMED\` | lead's campaign paused / resumed |
| \`LGM_LEAD_OUT_OF_OFFICE\` | out-of-office detected |
| \`LGM_LEAD_DUPLICATION\` | duplicate lead detected |
| \`LGM_LEAD_PAUSED_CRM_DEAL\` / \`LGM_LEAD_PAUSED_LIFECYCLE\` | lead paused by a CRM-deal / lifecycle rule |
| \`LEAD_TAG_UPDATE\` | lead tag changed |
| \`STOP_MESSAGE_AUTO_QUALIFY\` | auto-qualify stop |

### Enrichment
| type | description |
|---|---|
| \`LGM_AUTO_ENRICH\` / \`LGM_AUTO_ENRICH_ALREADY_ENRICHED\` | auto-enrichment run / already enriched |
| \`LGM_ENRICH_CONTACT_START\` | enrichment started |
| \`LGM_DOMAIN_FOUND\` | company domain found |
| \`LGM_PERSO_EMAIL_FOUND\` / \`LGM_PRO_EMAIL_FOUND\` | personal / professional email found |
| \`LGM_PHONE_FOUND\` | phone found |
| \`LGM_PROFILE_FOUND\` / \`LGM_PROFILE_NOT_FOUND\` | profile found / not found |

### Campaign attribute conditions
| type | description |
|---|---|
| \`LGM_HAS_ATTRIBUTE\` / \`LGM_HAS_NOT_ATTRIBUTE\` | condition check: lead has / doesn't have a given attribute. Useful **only if you know which attribute is being tested** (the attribute isn't in a dedicated column). |

### CRM sync / integrations / webhooks
| type | description |
|---|---|
| \`HUBSPOT_CRM_INIT\` / \`HUBSPOT_CRM_UPDATE_LEAD\` / \`_LIFECYCLE\` / \`_TIMELINE\` | HubSpot CRM sync (init, lead update, lifecycle, timeline) |
| \`PIPEDRIVE_CRM_INIT\` / \`PIPEDRIVE_CRM_UPDATE_LEAD\` / \`_LIFECYCLE\` / \`_TIMELINE\` | Pipedrive CRM sync |
| \`API_TRIGGER\` / \`MAKE_TRIGGER\` / \`ZAPIER_TRIGGER\` | integration triggers (public API, Make, Zapier) |
| \`LGM_WEBHOOK\` | outbound webhook executed |

### Ignore
| type | note |
|---|---|
| \`LGM_ADD_DELAY\` | scheduling delay only — no analytical value |
`;
