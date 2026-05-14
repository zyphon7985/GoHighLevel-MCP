// Shared helpers for the lead-enrichment webhook family. Used by:
//   api/enrich-webhook.js  (full enrichment pipeline)
//   api/log-event.js       (cheap append to Communication Memory)
//   api/refresh-memory.js  (LLM synthesis refresh of Communication Memory)
//
// Keep this file dependency-light. Each api/*.js function is bundled
// separately by Vercel; bringing in heavy deps here multiplies bundle size
// across all functions.

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const GHL_BASE_URL = process.env.GHL_BASE_URL || 'https://services.leadconnectorhq.com';
const GHL_API_VERSION = '2021-07-28';

// Canonical contact custom field IDs. Mirror of CONTACT_FIELDS in
// enrich-webhook.js — duplicated intentionally so each function can be read
// independently. If the source of truth (the GHL custom fields) changes,
// update both here and in enrich-webhook.js.
const CONTACT_FIELDS = {
  enrichment_foundation: 'Jfz323wRZQj75V1UFmIj',
  communication_memory: 'KVEJ8Dtw4frhx9Qik5bd'
};

const COMMUNICATION_MEMORY_SENTINEL =
  'HISTORICAL SUMMARY:\n(none yet, first contact, no conversation history)\n\nRECENT ACTIVITY (newest first):\n(no events yet)';

// ─── GHL HTTPS ──────────────────────────────────────────────────────────────

async function ghlRequest(path, method = 'GET', body = null) {
  const apiKey = process.env.GHL_API_KEY;
  if (!apiKey) throw new Error('GHL_API_KEY not configured');
  const res = await fetch(`${GHL_BASE_URL}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Version': GHL_API_VERSION,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GHL ${method} ${path} ${res.status}: ${text.substring(0, 500)}`);
  return text ? JSON.parse(text) : {};
}

async function ghlGetContact(contactId) {
  return ghlRequest(`/contacts/${contactId}`);
}

async function ghlUpdateContact(contactId, payload) {
  return ghlRequest(`/contacts/${contactId}`, 'PUT', payload);
}

// Read a contact custom field value by canonical name (e.g., 'communication_memory').
function readContactCustomField(contactResponse, fieldName) {
  const fieldId = CONTACT_FIELDS[fieldName];
  if (!fieldId) return undefined;
  const cf = (contactResponse && contactResponse.contact && contactResponse.contact.customFields) || [];
  const f = cf.find(x => x && x.id === fieldId);
  if (!f) return undefined;
  return f.value !== undefined ? f.value : f.field_value;
}

// Write a single contact custom field by canonical name. Wraps the GHL
// update_contact payload shape ([{id, field_value}]).
async function writeContactCustomField(contactId, fieldName, value) {
  const fieldId = CONTACT_FIELDS[fieldName];
  if (!fieldId) throw new Error(`Unknown CONTACT_FIELDS key: ${fieldName}`);
  return ghlUpdateContact(contactId, {
    customFields: [{ id: fieldId, field_value: String(value) }]
  });
}

// ─── Auth check (matches enrich-webhook.js pattern) ─────────────────────────

function authOK(req) {
  const SECRET = process.env.WEBHOOK_SECRET;
  if (!SECRET || SECRET.length < 16) return { ok: false, status: 500, error: 'Server configuration error' };
  if (req.method !== 'POST') return { ok: false, status: 405, error: 'Method not allowed' };
  if (!req.headers || req.headers.authorization !== `Bearer ${SECRET}`) {
    return { ok: false, status: 401, error: 'Unauthorized' };
  }
  return { ok: true };
}

async function readBody(req) {
  let body = '';
  await new Promise((resolve, reject) => {
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', resolve);
    req.on('error', reject);
  });
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch (e) {
    throw new Error('Invalid JSON body');
  }
}

// Extract a field from a webhook payload, tolerant of GHL's nesting.
//
// GHL workflow webhooks send custom-data fields under a `customData` key,
// while standard contact fields land at the top level. They also use
// snake_case for some standard fields (contact_id) and camelCase for
// others. This helper checks (in order):
//   1. body.<key> (top level — if the caller hand-rolled the payload)
//   2. body.customData.<key> (GHL standard custom-data nesting)
//   3. body.<snake_case_alt> (e.g., contact_id) when an alt is provided
function getField(body, key, snakeAlt) {
  if (!body) return undefined;
  if (body[key] !== undefined && body[key] !== null && body[key] !== '') return body[key];
  if (body.customData && body.customData[key] !== undefined && body.customData[key] !== null && body.customData[key] !== '') {
    return body.customData[key];
  }
  if (snakeAlt && body[snakeAlt] !== undefined && body[snakeAlt] !== null && body[snakeAlt] !== '') {
    return body[snakeAlt];
  }
  return undefined;
}

// ─── Slack notification ─────────────────────────────────────────────────────
//
// Two kinds of alerts go through this helper:
//   - kind='failed'    → delivery failure (write blew up, network error, etc.)
//                        Headline: "*<stage> failed*"
//   - kind='attention' → soft signal that needs a human decision but is NOT a
//                        delivery failure (e.g., foundation_correction_needed
//                        — Memory wrote fine, but Foundation may be stale).
//                        Headline: "*<stage> needs attention*"
//
// Default is 'failed' for backwards compatibility.
async function postFailureNotification({ source, contactId, contactName, reason, stage, timestamp, kind }) {
  const url = process.env.NOTIFY_WEBHOOK_URL;
  if (!url) return;
  const ghlLoc = process.env.GHL_LOCATION_ID;
  const contactUrl = ghlLoc
    ? `https://app.gohighlevel.com/v2/location/${ghlLoc}/contacts/detail/${contactId}`
    : null;
  const logsUrl = `https://vercel.com/robvaniglia-gmailcoms-projects/go-high-level-mcp/logs?query=${encodeURIComponent(contactId)}`;
  const userMention = process.env.SLACK_NOTIFY_USER_ID ? `<@${process.env.SLACK_NOTIFY_USER_ID}>` : '';
  const displayName = (contactName && contactName.trim()) || '(name unavailable)';
  const alertKind = kind === 'attention' ? 'attention' : 'failed';
  const headlineSuffix = alertKind === 'attention' ? 'needs attention' : 'failed';
  const lines = [
    `${userMention ? userMention + ' — ' : ''}*${stage} ${headlineSuffix}*`.trim(),
    `*Contact:* ${displayName} (\`${contactId}\`)`,
    `*Source:* ${source}`,
    `*Reason:* ${reason}`,
    `*Time:* ${timestamp}`,
    [contactUrl ? `<${contactUrl}|View contact in GHL>` : null, `<${logsUrl}|Open Vercel logs>`].filter(Boolean).join(' | ')
  ];
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: lines.join('\n'),
        event: `${stage.toLowerCase().replace(/\s+/g, '_')}_${alertKind}`,
        kind: alertKind,
        source,
        contact_id: contactId,
        contact_name: contactName || null,
        reason,
        timestamp
      })
    });
    console.log(`[notify] posted status=${res.status} kind=${alertKind}`);
  } catch (err) {
    console.error(`[notify] errored: ${err.message}`);
  }
}

// ─── Anthropic call with retry (lightweight, no MCP) ────────────────────────

async function callAnthropic({ model, maxTokens, system, messages, tools, toolChoice, timeoutMs }) {
  const body = {
    model,
    max_tokens: maxTokens,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages
  };
  if (tools) body.tools = tools;
  if (toolChoice) body.tool_choice = toolChoice;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
  clearTimeout(timeoutId);
  const text = await res.text();
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${text.substring(0, 500)}`);
  return JSON.parse(text);
}

async function callAnthropicWithRetry(args, maxAttempts = 2) {
  const baseTimeout = args.timeoutMs || 60_000;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await callAnthropic(args);
    } catch (err) {
      lastErr = err;
      const msg = (err && err.message) || '';
      const isTransient =
        /\b(429|500|502|503|504|529)\b/.test(msg) ||
        /Connection error|overloaded/i.test(msg) ||
        err.name === 'AbortError';
      if (!isTransient || attempt === maxAttempts) throw err;
      await new Promise(r => setTimeout(r, attempt === 1 ? 1000 : 3000));
    }
  }
  throw lastErr;
}

// ─── Memory parsing helpers ─────────────────────────────────────────────────

// Parse the Communication Memory string into its two sections.
// Returns { historical_summary, recent_activity_lines } where
// recent_activity_lines is an array of strings (newest first).
// Tolerates malformed input by returning empty sections.
function parseMemory(memoryString) {
  const empty = { historical_summary: '', recent_activity_lines: [] };
  if (!memoryString || typeof memoryString !== 'string') return empty;
  const trimmed = memoryString.trim();
  if (!trimmed) return empty;

  const histMatch = trimmed.match(/HISTORICAL SUMMARY:\s*([\s\S]*?)(?=\n\s*RECENT ACTIVITY|$)/i);
  const recMatch = trimmed.match(/RECENT ACTIVITY[^:]*:\s*([\s\S]*?)$/i);

  let historical_summary = '';
  if (histMatch) {
    historical_summary = histMatch[1].trim();
    // Strip the "(none yet...)" sentinel
    if (/^\(none yet/i.test(historical_summary)) historical_summary = '';
  }

  let recent_activity_lines = [];
  if (recMatch) {
    const block = recMatch[1].trim();
    if (!/^\(no events/i.test(block)) {
      recent_activity_lines = block
        .split(/\n+/)
        .map(s => s.trim())
        .filter(s => s.length > 0)
        .map(s => s.replace(/^[-•]\s*/, ''));
    }
  }

  return { historical_summary, recent_activity_lines };
}

// Reconstruct the Communication Memory string from sections.
function buildMemoryString({ historical_summary, recent_activity_lines }) {
  const histText = historical_summary && historical_summary.trim()
    ? historical_summary.trim()
    : '(none yet, first contact, no conversation history)';
  const lines = (recent_activity_lines || []).filter(s => s && s.trim());
  const recText = lines.length
    ? lines.map(s => s.replace(/^[-•]\s*/, '')).map(s => `- ${s}`).join('\n')
    : '(no events yet)';
  return `HISTORICAL SUMMARY:\n${histText}\n\nRECENT ACTIVITY (newest first):\n${recText}`;
}

// Format a new event timeline line. Used by /log-event for cheap appends.
//   ts: ISO timestamp
//   direction: 'INBOUND' | 'OUTBOUND'
//   channel: 'SMS' | 'EMAIL' | 'CALL' | 'BOT_SMS' | 'BOT_EMAIL' | etc.
//   summary: brief text describing what happened
function formatTimelineEntry({ ts, direction, channel, summary }) {
  const timestamp = ts || formatLocalTimestamp(new Date());
  const dir = (direction || '').toUpperCase();
  const ch = (channel || '').toUpperCase();
  const sum = (summary || '').replace(/\n+/g, ' ').trim().substring(0, 220);
  return `${timestamp} ${dir} ${ch}: ${sum}`;
}

// Replace em dashes and en dashes with safer punctuation. Defense-in-depth
// safety net for the no-em-dashes-in-AI-output rule. The synthesis prompt
// instructs the model to avoid them, but compliance is not 100% so we
// scrub at the boundary too.
//   " — " (parenthetical) -> ", "
//   "—"   (no spaces)     -> ","
function scrubDashes(s) {
  if (typeof s !== 'string') return s;
  return s.replace(/\s+[—–]\s+/g, ', ').replace(/[—–]/g, ',');
}

// Format a Date as "YYYY-MM-DD HH:MM" in a specific timezone (default
// America/New_York for Rob). Uses Intl.DateTimeFormat so DST is handled
// automatically (EST <-> EDT). Vercel function runtime defaults to UTC,
// which produced 14:04 in entries when Rob expected 10:04 (EDT). All
// Recent Activity timestamps now use this helper instead of toISOString.
//
// Override via env TIMESTAMP_TIMEZONE if you want a different zone.
function formatLocalTimestamp(date, tz) {
  const d = date instanceof Date ? date : new Date();
  const zone = tz || process.env.TIMESTAMP_TIMEZONE || 'America/New_York';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(d).reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {});
  // Intl can return "24" for midnight hour in en-US; normalize to "00".
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day} ${hour}:${parts.minute}`;
}

module.exports = {
  ANTHROPIC_API_URL,
  GHL_BASE_URL,
  GHL_API_VERSION,
  CONTACT_FIELDS,
  COMMUNICATION_MEMORY_SENTINEL,
  ghlRequest,
  ghlGetContact,
  ghlUpdateContact,
  readContactCustomField,
  writeContactCustomField,
  authOK,
  readBody,
  getField,
  postFailureNotification,
  callAnthropic,
  callAnthropicWithRetry,
  parseMemory,
  buildMemoryString,
  formatTimelineEntry,
  formatLocalTimestamp,
  scrubDashes
};
