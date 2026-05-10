// /log-event — cheap append to Communication Memory
//
// Fired by GHL workflows on outbound bot activity (SMS sent, email sent,
// call placed). No LLM call. Just reads the contact's Communication Memory,
// prepends a one-liner to RECENT ACTIVITY, hard-caps at 30 entries, writes
// back. Target latency under 2 seconds end-to-end.
//
// Why a hard cap of 30 rather than 10:
//   The "10 entry rollover into HISTORICAL SUMMARY" compression happens in
//   /refresh-memory (which has an LLM available). /log-event is fast and
//   dumb — it doesn't synthesize. Capping at 30 prevents the field from
//   exploding past the 16KB GHL ceiling during long outreach bursts. The
//   next /refresh-memory call (on the prospect's reply) will compress
//   properly down to 10 with the oldest 5 rolled into summary.
//
// POST /log-event
// Auth: Authorization: Bearer ${WEBHOOK_SECRET}
// Body: {
//   contactId: string,            // required
//   event_type: string,           // required - e.g. 'outbound_sms', 'outbound_email', 'outbound_call_placed'
//   summary: string,              // required - max 200 chars, brief description of what happened
//   direction: 'INBOUND'|'OUTBOUND', // optional, defaults inferred from event_type
//   channel: string               // optional, defaults inferred from event_type (SMS, EMAIL, CALL)
// }

const {
  authOK,
  readBody,
  getField,
  ghlGetContact,
  writeContactCustomField,
  readContactCustomField,
  parseMemory,
  buildMemoryString,
  formatTimelineEntry,
  postFailureNotification
} = require('./_shared');

const HARD_CAP_RECENT_ACTIVITY = 30;
const REQUIRED_ENV = ['WEBHOOK_SECRET', 'GHL_API_KEY'];

function inferDirectionAndChannel(eventType) {
  const et = (eventType || '').toLowerCase();
  let direction = 'OUTBOUND';
  if (et.startsWith('inbound')) direction = 'INBOUND';
  let channel = 'EVENT';
  if (et.includes('sms')) channel = et.includes('outbound') ? 'BOT_SMS' : 'SMS';
  else if (et.includes('email')) channel = et.includes('outbound') ? 'BOT_EMAIL' : 'EMAIL';
  else if (et.includes('call') || et.includes('voice')) channel = et.includes('outbound') ? 'BOT_CALL' : 'CALL';
  else if (et.includes('appointment')) channel = 'APPOINTMENT';
  else if (et.includes('workflow')) channel = 'WORKFLOW';
  return { direction, channel };
}

const handler = async (req, res) => {
  const auth = authOK(req);
  if (!auth.ok) {
    res.status(auth.status).json({ error: auth.error });
    return;
  }

  const missing = REQUIRED_ENV.filter(k => !process.env[k]);
  if (missing.length) {
    res.status(500).json({ error: 'Server misconfigured', missing });
    return;
  }

  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    res.status(400).json({ error: e.message || 'Invalid JSON' });
    return;
  }

  // GHL nests workflow Custom Data under a `customData` key. Use getField
  // to read from either the top level or customData seamlessly.
  const contactId = getField(body, 'contactId', 'contact_id');
  const event_type = getField(body, 'event_type');
  const summary = getField(body, 'summary');
  const directionOverride = getField(body, 'direction');
  const channelOverride = getField(body, 'channel');

  if (!contactId || !event_type || !summary) {
    console.warn(`[log-event] missing fields. body keys: ${Object.keys(body || {}).join(',')}; customData keys: ${Object.keys((body && body.customData) || {}).join(',')}`);
    res.status(400).json({
      error: 'Missing required fields: contactId, event_type, summary',
      received_top_level_keys: Object.keys(body || {}),
      received_custom_data_keys: Object.keys((body && body.customData) || {})
    });
    return;
  }

  console.log(`[log-event] contactId=${contactId} event_type=${event_type} summary="${String(summary).substring(0, 80)}"`);

  try {
    // Read current memory (and contact for failure notification context)
    const contactRecord = await ghlGetContact(contactId);
    const currentMemory = readContactCustomField(contactRecord, 'communication_memory') || '';
    const parsed = parseMemory(currentMemory);

    // Build new entry
    const inferred = inferDirectionAndChannel(event_type);
    const direction = (directionOverride || inferred.direction).toUpperCase();
    const channel = (channelOverride || inferred.channel).toUpperCase();
    const newEntry = formatTimelineEntry({
      ts: new Date().toISOString().replace('T', ' ').substring(0, 16),
      direction,
      channel,
      summary
    });

    // Prepend (newest first), cap to HARD_CAP_RECENT_ACTIVITY
    const newLines = [newEntry, ...parsed.recent_activity_lines].slice(0, HARD_CAP_RECENT_ACTIVITY);

    const newMemory = buildMemoryString({
      historical_summary: parsed.historical_summary,
      recent_activity_lines: newLines
    });

    await writeContactCustomField(contactId, 'communication_memory', newMemory);

    console.log(`[log-event] OK contactId=${contactId} entries=${newLines.length} (was ${parsed.recent_activity_lines.length})`);
    res.status(200).json({
      ok: true,
      contactId,
      event_type,
      total_recent_entries: newLines.length,
      hard_cap_reached: newLines.length >= HARD_CAP_RECENT_ACTIVITY
    });
  } catch (err) {
    console.error(`[log-event] FAILED contactId=${contactId} err=${err.message}`);
    res.status(500).json({ error: err.message });
    // Best-effort Slack alert. Failures here mean GHL writes are broken
    // (auth, outage, etc.), which is the kind of thing Rob wants to know
    // about.
    const contact = (err.contactRecord && err.contactRecord.contact) || {};
    const contactName = [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim() || null;
    await postFailureNotification({
      source: 'log_event_threw',
      stage: 'log-event',
      contactId,
      contactName,
      reason: err.message,
      timestamp: new Date().toISOString()
    });
  }
};

module.exports = handler;
