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
  getField,
  ghlGetContact,
  writeContactCustomField,
  readContactCustomField,
  parseMemory,
  buildMemoryString,
  scrubDashes,
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
  description: 'Emit the refreshed Communication Memory state. Call exactly once with the complete structured payload. Read the system prompt for the eight rules.',
  input_schema: {
    type: 'object',
    properties: {
      historical_summary: {
        type: 'string',
        description: '100-500 word prose narrative of the relationship arc. Append-mostly: never remove or contradict existing content based on a single event. Conversation evolution ONLY: do NOT include the contact name, role, company, industry, geography, or lead source (those live in existing_foundation, never duplicate). Plain prose, no bullets, no em dashes, no markdown, no emoji.'
      },
      recent_activity_lines: {
        type: 'array',
        items: { type: 'string' },
        maxItems: 10,
        description: 'Ordered array, newest first, MAXIMUM 10 entries. Each entry format: "YYYY-MM-DD HH:MM <DIRECTION> <CHANNEL>: <summary, max 30 words>". The new event is always the first entry. ROLLOVER: if existing recent had 10 entries and you are adding a new one, take the OLDEST 5, summarize them into historical_summary as new sentences, and REMOVE them from this output array. Result: 6 entries total (new event plus 5 newest existing). Never duplicate entries across historical_summary and recent_activity_lines.'
      },
      foundation_correction_needed: {
        type: 'boolean',
        description: 'True if the new event reveals identity-level info that contradicts existing_foundation (wrong role, wrong company, wrong industry, contact left the company). False otherwise. A separate worker handles re-enrichment; do NOT edit Foundation yourself.'
      },
      foundation_correction_note: {
        type: 'string',
        description: 'Only populate when foundation_correction_needed=true. One sentence stating what specifically contradicts Foundation, e.g., "Contact stated they are a landscaper, not a property manager."'
      }
    },
    required: ['historical_summary', 'recent_activity_lines', 'foundation_correction_needed']
  }
};

function buildSynthesisSystemPrompt() {
  return `You maintain the Communication Memory for a sales lead in TerraGenie's GHL CRM. Your job: integrate one new conversation event while keeping the structure clean and the content non-duplicative.

INPUTS YOU RECEIVE:
- existing_memory: the current Memory field, with a HISTORICAL SUMMARY section and a RECENT ACTIVITY section.
- existing_foundation: the contact's stable identity context (name, role, company, fit). READ-ONLY reference for spotting contradictions. Never copy its content into your output.
- new_event: the event to integrate (timestamp, direction, channel, text content).

OUTPUTS (via emit_memory tool, exactly once):
- historical_summary: 100-500 word prose narrative of the conversation arc.
- recent_activity_lines: ordered array, newest first, max 10 entries.
- foundation_correction_needed: boolean.
- foundation_correction_note: string (only when foundation_correction_needed is true).

THE EIGHT RULES:

1. RECENT ACTIVITY ENTRY FORMAT
   Each entry must be exactly: "YYYY-MM-DD HH:MM <DIRECTION> <CHANNEL>: <summary, max 30 words>"
   DIRECTION = INBOUND or OUTBOUND.
   CHANNEL = SMS, EMAIL, CALL, BOT_SMS, BOT_EMAIL, BOT_CALL, APPOINTMENT, or WORKFLOW.
   Preserve verbatim quotes for short messages when they convey sentiment or commitment ("Sure! Let's do it.").

2. THE NEW EVENT ALWAYS LANDS FIRST
   The new event is always the first (newest) entry in recent_activity_lines. This is non-negotiable.

3. ROLLOVER WHEN RECENT WOULD EXCEED 10
   If existing recent_activity has 10 entries and you are adding the new event (would be 11):
     a. Take the OLDEST 5 entries (positions 6 through 10 in newest-first order).
     b. Summarize those 5 into 1-3 new sentences and APPEND them to historical_summary.
     c. REMOVE those 5 from recent_activity_lines. Do not keep them anywhere in your recent_activity_lines output.
   Final output structure: recent_activity_lines = [new_event, plus the 5 newest existing entries] = 6 entries total.
   The 5 oldest entries live ONLY in historical_summary from this point forward. NEVER duplicate them across sections.

4. WHAT GETS PROMOTED TO HISTORICAL SUMMARY
   When summarizing rolled-over entries (or noting milestone events), preserve detail for things that change future outreach strategy:
     - Confirmed objections (pricing, timing, budget, competitor)
     - Commitments made by the contact (call scheduled, demo booked, decision deadline)
     - Sentiment shifts (frustration that surfaced, satisfaction expressed)
     - Pricing discussions (any mention of cost, tier, package)
     - Complaints, even if resolved (they remain part of the relationship history)
     - Decision-maker or stakeholder changes
   Compress at higher abstraction for routine touchpoints: "three reactivation SMS attempts in May went unanswered" rather than three separate sentences.

5. HISTORICAL SUMMARY IS APPEND-MOSTLY
   Never remove or contradict existing historical_summary content based on a single new event. A friendly closing message ("thanks, you guys are great") does NOT erase a prior documented complaint or objection. Both can coexist: "Raised pricing concern in early May which was resolved on the May 15 call. Has since expressed positive sentiment."

6. NO IDENTITY DUPLICATION
   Historical_summary is conversation evolution ONLY. Do NOT include the contact's name, role, company name, industry, geography, or lead source in historical_summary. That information lives in existing_foundation; the bot reads it from there. Historical_summary covers what happened in the relationship, not who the person is.

7. FOUNDATION CORRECTION DETECTION
   If the new event reveals identity-level information that contradicts existing_foundation (e.g., "I'm a landscaper, not a property manager"; "I left SDC, I'm at Acme now"), set foundation_correction_needed=true and write a one-sentence foundation_correction_note. A separate worker handles re-enrichment. Do NOT edit Foundation yourself.

8. WRITING STYLE
   Plain prose only. No em dashes (—). No en dashes (–). No bullets in historical_summary. No markdown. No emoji.
   Use commas, periods, parentheses, semicolons.
   Hyphens are fine for compound words (follow-up, long-term, mid-market).

LENGTH BOUNDS:
- historical_summary: target 100-500 words. Hard cap 3000 words. If approaching cap, compress older content at higher abstraction.
- recent_activity_lines: maximum 10 entries.
- per-entry summary: maximum 30 words.

OUTPUT: call emit_memory exactly once. That is your only valid output.`;
}

function buildPreSummarySystemPrompt() {
  return `You compress a long sales conversation event (voice call transcript, long email, extended message thread) into a single timeline entry for a sales lead's communication memory.

The entry will be read by an AI sales bot at the next outreach. Focus exclusively on what changes future strategy:
  - Objections raised (pricing, timing, budget, competitor, fit)
  - Questions asked by the contact
  - Commitments made by the contact (calls scheduled, deliverables agreed)
  - Specific concerns or pain points
  - Next steps and timing
  - Sentiment shifts (notable frustration or notable enthusiasm)

OUTPUT LENGTH (scale to input size):
  - Input up to 1500 words: produce 80-120 word digest as one paragraph.
  - Input 1500 to 5000 words: produce 120-180 word digest as one paragraph.
  - Input over 5000 words: produce 180-220 word digest, structured as one paragraph followed by three labeled lines:
      "Key objections: ..."
      "Key commitments: ..."
      "Next steps: ..."

WRITING STYLE:
  - Plain prose only. No em dashes (—). No en dashes (–). No markdown. No emoji.
  - Preserve verbatim quotes for emotionally-charged or commitment-defining lines.
  - Do not include filler ("they exchanged greetings", "small talk about the weather").
  - Do not infer beyond what was actually said in the input.
  - Hyphens are fine for compound words.

Output the digest text only, nothing else.`;
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

  // Defense-in-depth safety nets at the write boundary:
  //  1. Trim recent_activity_lines to a hard maximum of 10 entries (the
  //     synthesis prompt asks for this but compliance is not 100%).
  //  2. Scrub em dashes and en dashes from both sections (Rob's no-em-dashes
  //     rule; the synthesis prompt asks for this too but slips happen).
  const cappedRecentLines = (out.recent_activity_lines || [])
    .filter(s => typeof s === 'string' && s.trim().length > 0)
    .slice(0, 10)
    .map(scrubDashes);
  const scrubbedHistorical = scrubDashes(out.historical_summary || parsedExisting.historical_summary || '');

  const newMemory = buildMemoryString({
    historical_summary: scrubbedHistorical,
    recent_activity_lines: cappedRecentLines
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

  // GHL nests workflow Custom Data under a `customData` key. Use getField
  // to read from either the top level or customData seamlessly.
  const contactId = getField(body, 'contactId', 'contact_id');
  const event_type = getField(body, 'event_type');
  const message_text = getField(body, 'message_text');
  const call_duration_seconds = getField(body, 'call_duration_seconds');
  const metadata = getField(body, 'metadata');

  if (!contactId || !event_type) {
    console.warn(`[refresh-memory] missing fields. body keys: ${Object.keys(body || {}).join(',')}; customData keys: ${Object.keys((body && body.customData) || {}).join(',')}`);
    res.status(400).json({
      error: 'Missing required fields: contactId, event_type',
      received_top_level_keys: Object.keys(body || {}),
      received_custom_data_keys: Object.keys((body && body.customData) || {})
    });
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

  // Build the normalized payload that refreshMemory expects.
  const refreshPayload = { contactId, event_type, message_text, call_duration_seconds, metadata };

  waitUntil(
    refreshMemory(refreshPayload)
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
