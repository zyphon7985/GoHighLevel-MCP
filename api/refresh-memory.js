// /refresh-memory — LLM-driven Communication Memory refresh
//
// Fired by GHL workflows on inbound conversation events (inbound SMS / email
// reply, voice call transcript ready, appointment booked, workflow stage
// changed). Synthesizes the new event into existing memory while preserving
// historical context.
//
// Architecture (per design doc):
//   1. Fetch existing Communication Memory + last 5-10 conversation events
//      from GHL for grounding context.
//   2. For voice events with long transcripts: pre-summarize into ~100 words
//      via a separate cheap Anthropic call.
//   3. Single Anthropic synthesis call: integrate new event, refresh both
//      sections, return structured emit_memory output.
//   4. If RECENT ACTIVITY exceeds 10 entries: oldest 5 fold into HISTORICAL
//      SUMMARY (handled by the synthesis prompt's instructions).
//   5. Write updated Memory back to GHL.
//   6. If foundation_correction_needed=true: post a Slack notification so
//      Rob can decide whether to re-run enrichment.
//
// Cost target: ~$0.003 per refresh on Sonnet 4.6.
// Latency target: 5-15 seconds (acceptable since this is post-event, not
// on a hot user-facing path).
//
// POST /refresh-memory
// Auth: Authorization: Bearer ${WEBHOOK_SECRET}
// Body: {
//   contactId: string,            // required
//   event_type: string,           // required - 'inbound_sms', 'inbound_email', 'voice_transcript_ready', 'appointment_booked', 'workflow_stage_changed', 'manual_refresh'
//   message_text?: string,        // optional, the inbound message body or transcript
//   call_duration_seconds?: number, // optional, for voice
//   metadata?: object             // optional, milestone metadata (e.g., {appointment_time: ...})
// }

const { waitUntil } = require('@vercel/functions');
const {
  authOK,
  readBody,
  ghlGetContact,
  writeContactCustomField,
  readContactCustomField,
  parseMemory,
  buildMemoryString,
  callAnthropicWithRetry,
  postFailureNotification
} = require('./_shared');

const SYNTHESIS_MODEL = 'claude-sonnet-4-6';
const SYNTHESIS_MAX_TOKENS = 2048;
const SYNTHESIS_TIMEOUT_MS = 60_000;
const PRE_SUMMARY_MODEL = 'claude-sonnet-4-6';
const PRE_SUMMARY_MAX_TOKENS = 512;
const PRE_SUMMARY_TIMEOUT_MS = 45_000;

const RECENT_ACTIVITY_TARGET_MAX = 10; // synthesis aims to keep RECENT ACTIVITY at or below this
const PRE_SUMMARY_THRESHOLD_WORDS = 200; // if message_text exceeds this, pre-summarize first

const REQUIRED_ENV = ['WEBHOOK_SECRET', 'ANTHROPIC_API_KEY', 'GHL_API_KEY'];

const EMIT_MEMORY_TOOL = {
  name: 'emit_memory',
  description: 'Emit the refreshed Communication Memory state. Call exactly once with the complete structured payload.',
  input_schema: {
    type: 'object',
    properties: {
      historical_summary: {
        type: 'string',
        description: '100-500 word prose paragraph capturing the long-term context of this lead. Append-mostly: never remove or contradict existing summary content based on a single new event. Plain prose, no bullets / em dashes / markdown / emoji.'
      },
      recent_activity_lines: {
        type: 'array',
        items: { type: 'string' },
        maxItems: 10,
        description: 'Array of timeline entries, newest first, max 10 entries. Each entry format: "YYYY-MM-DD HH:MM <DIRECTION> <CHANNEL>: <one-line summary>". Older entries beyond 10 should be summarized and folded into historical_summary, not silently dropped.'
      },
      foundation_correction_needed: {
        type: 'boolean',
        description: 'True if the new event reveals identity-level information that contradicts the existing Enrichment Foundation (wrong company, wrong role, wrong industry). False otherwise.'
      },
      foundation_correction_note: {
        type: 'string',
        description: 'Only when foundation_correction_needed=true. One-sentence explanation of what specifically contradicts the Foundation, e.g., "Contact stated they are a landscaper, not a property manager."'
      }
    },
    required: ['historical_summary', 'recent_activity_lines', 'foundation_correction_needed']
  }
};

function buildSynthesisSystemPrompt() {
  return `You maintain the Communication Memory for a sales lead in TerraGenie's GHL CRM. Your job is to integrate a new conversation event into the existing memory, preserving important context and ensuring the structure stays clean.

The Communication Memory has two sections:
  HISTORICAL SUMMARY: a 100-500 word prose paragraph capturing long-term context (early signals, key objections, sentiment trajectory, milestone events).
  RECENT ACTIVITY: a list of the last 10 conversation events newest first, each one line.

CRITICAL RULES:

1. HISTORICAL SUMMARY is append-mostly. NEVER remove or contradict existing summary content based on a single new event. Information promotes from RECENT ACTIVITY into HISTORICAL SUMMARY only when:
   (a) RECENT ACTIVITY has more than 10 entries and the oldest 5 need to be summarized, OR
   (b) the new event is a clear milestone (appointment booked, contract signed, opportunity stage advance, churn).
   A friendly closing message DOES NOT erase a documented complaint or objection. A "thanks, you guys are great" does not retroactively make a previous frustration disappear.

2. RECENT ACTIVITY is the last 10 events newest first. Each entry: "YYYY-MM-DD HH:MM <DIRECTION> <CHANNEL>: <one-line summary, max 30 words>". Direction is INBOUND or OUTBOUND. Channel is SMS, EMAIL, CALL, BOT_SMS, BOT_EMAIL, BOT_CALL, APPOINTMENT, WORKFLOW.

3. If the input has more than 10 entries in RECENT ACTIVITY (because /log-event was capping at a higher number), summarize the oldest entries down so output has at most 10 entries. The summarized content folds into historical_summary as new sentences. Do not silently drop entries.

4. WRITING STYLE: plain prose. NO em dashes (—). NO en dashes (–). NO bullets. NO markdown. NO emoji. Use commas, periods, parentheses, semicolons. Hyphens are fine for compound words (e.g., "follow-up", "long-term").

5. Identity-level corrections: if the new event reveals that the contact's role / company / industry differs from what's currently documented (e.g., contact says "actually I'm a landscaper, not a property manager"), set foundation_correction_needed=true and write a one-sentence foundation_correction_note. A separate worker will handle Foundation re-enrichment. Do NOT modify Foundation yourself.

6. The new event ALWAYS goes into RECENT ACTIVITY as a timeline line, regardless of how it affects HISTORICAL SUMMARY.

7. Output via emit_memory exactly once. That is your only valid output.

INPUT YOU WILL RECEIVE:
- existing_memory: the current Communication Memory (both sections, possibly with sentinel content if first event)
- new_event: structured information about the event to integrate
- recent_ghl_messages: optional grounding context from GHL's conversation API`;
}

function buildPreSummarySystemPrompt() {
  return `You summarize a long sales conversation event (voice call transcript or long email) into a single timeline entry for a sales lead's communication memory.

Output one paragraph, 80-120 words, plain prose. Focus on what's relevant for future outreach:
- Objections raised
- Questions asked
- Commitments made
- Specific concerns or pain points
- Next steps agreed
- Sentiment shift if notable

Do NOT include filler. Do NOT use bullets, headers, em dashes, or emoji. Plain prose only. No more than 120 words.`;
}

async function preSummarizeEventText(text, eventType) {
  const wordCount = text.split(/\s+/).length;
  if (wordCount <= PRE_SUMMARY_THRESHOLD_WORDS) return text;

  console.log(`[refresh-memory] pre-summarizing ${wordCount}-word ${eventType}`);
  const response = await callAnthropicWithRetry({
    model: PRE_SUMMARY_MODEL,
    maxTokens: PRE_SUMMARY_MAX_TOKENS,
    system: buildPreSummarySystemPrompt(),
    messages: [{ role: 'user', content: `Event type: ${eventType}\n\nFull text:\n\n${text}` }],
    timeoutMs: PRE_SUMMARY_TIMEOUT_MS
  });

  const summary = (response.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim();
  return summary || text.substring(0, 1500);
}

async function refreshMemory({ contactId, event_type, message_text, call_duration_seconds, metadata }) {
  console.log(`[refresh-memory] start contactId=${contactId} event_type=${event_type}`);
  const startTime = Date.now();

  const contactRecord = await ghlGetContact(contactId);
  const contact = (contactRecord && contactRecord.contact) || {};
  const contactName = [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim() || contact.email || null;
  const existingMemory = readContactCustomField(contactRecord, 'communication_memory') || '';
  const existingFoundation = readContactCustomField(contactRecord, 'enrichment_foundation') || '';
  const parsedExisting = parseMemory(existingMemory);

  // Pre-summarize long event text (typically voice transcripts)
  let eventTextProcessed = message_text || '';
  if (eventTextProcessed) {
    eventTextProcessed = await preSummarizeEventText(eventTextProcessed, event_type);
  }

  const eventTimestamp = new Date().toISOString().replace('T', ' ').substring(0, 16);
  const newEventBlock = {
    timestamp: eventTimestamp,
    event_type,
    direction: event_type.toLowerCase().startsWith('inbound') ? 'INBOUND' : 'EVENT',
    text: eventTextProcessed || '(no text content)',
    call_duration_seconds: call_duration_seconds || null,
    metadata: metadata || null
  };

  const userMessage = [
    'Integrate the following new event into the existing Communication Memory. Output via emit_memory.',
    '',
    '<existing_memory>',
    existingMemory || '(empty)',
    '</existing_memory>',
    '',
    '<existing_foundation_for_correction_check>',
    existingFoundation || '(empty)',
    '</existing_foundation_for_correction_check>',
    '',
    '<new_event>',
    JSON.stringify(newEventBlock, null, 2),
    '</new_event>'
  ].join('\n');

  const response = await callAnthropicWithRetry({
    model: SYNTHESIS_MODEL,
    maxTokens: SYNTHESIS_MAX_TOKENS,
    system: buildSynthesisSystemPrompt(),
    messages: [{ role: 'user', content: userMessage }],
    tools: [EMIT_MEMORY_TOOL],
    toolChoice: { type: 'tool', name: 'emit_memory' },
    timeoutMs: SYNTHESIS_TIMEOUT_MS
  });

  const emit = (response.content || []).find(b => b.type === 'tool_use' && b.name === 'emit_memory');
  if (!emit) {
    const fallbackText = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').substring(0, 500);
    throw new Error(`synthesis_no_emit: ${fallbackText}`);
  }
  const out = emit.input || {};

  const newMemory = buildMemoryString({
    historical_summary: out.historical_summary || parsedExisting.historical_summary,
    recent_activity_lines: out.recent_activity_lines || []
  });

  await writeContactCustomField(contactId, 'communication_memory', newMemory);

  const elapsedSeconds = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[refresh-memory] OK contactId=${contactId} entries=${(out.recent_activity_lines || []).length} ` +
              `historical_summary_len=${(out.historical_summary || '').length} ` +
              `foundation_correction=${out.foundation_correction_needed} elapsedSeconds=${elapsedSeconds}`);

  return {
    ok: true,
    contactId,
    contactName,
    event_type,
    elapsedSeconds,
    foundation_correction_needed: !!out.foundation_correction_needed,
    foundation_correction_note: out.foundation_correction_note || null,
    recent_activity_count: (out.recent_activity_lines || []).length
  };
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

  const { contactId, event_type } = body;
  if (!contactId || !event_type) {
    res.status(400).json({ error: 'Missing required fields: contactId, event_type' });
    return;
  }

  console.log(`[refresh-memory] webhook received contactId=${contactId} event_type=${event_type}`);

  // Ack within 1 second; do the work in the background.
  res.status(200).json({
    ok: true,
    contactId,
    event_type,
    status: 'memory_refresh_started',
    received_at: new Date().toISOString()
  });

  waitUntil(
    refreshMemory(body)
      .then(async (result) => {
        console.log(`[refresh-memory] complete: ${JSON.stringify(result).substring(0, 600)}`);
        if (result.foundation_correction_needed) {
          console.warn(`[refresh-memory] FOUNDATION CORRECTION NEEDED contact=${contactId} note="${result.foundation_correction_note}"`);
          // Slack alert so Rob can decide whether to re-run enrichment
          await postFailureNotification({
            source: 'foundation_correction_needed',
            stage: 'memory-refresh',
            contactId,
            contactName: result.contactName,
            reason: `New event reveals identity-level information that contradicts Enrichment Foundation. Note: "${result.foundation_correction_note}". Consider re-running full enrichment for this contact.`,
            timestamp: new Date().toISOString()
          });
        }
      })
      .catch(async (err) => {
        const msg = (err && err.message) || 'unknown error';
        console.error(`[REFRESH_MEMORY_FAILURE] contactId=${contactId} err=${msg}`);
        if (err && err.stack) console.error(err.stack);
        await postFailureNotification({
          source: 'refresh_memory_threw',
          stage: 'memory-refresh',
          contactId,
          contactName: null,
          reason: msg.substring(0, 500),
          timestamp: new Date().toISOString()
        });
      })
  );
};

module.exports = handler;
