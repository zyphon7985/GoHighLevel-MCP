// Lead Enrichment Webhook — Phase 1 (plumbing only, no enrichment yet)
// Receives the "new lead" webhook from GHL, validates the Authorization header,
// logs the payload, and returns 200. This is the minimum viable receiver — once
// confirmed working end-to-end, Phase 2 will replace this body with the real
// Anthropic API + lead-enrichment agent loop.

module.exports = async (req, res) => {
  // ─── Auth check: server must have WEBHOOK_SECRET configured ────────────────
  const SECRET = process.env.WEBHOOK_SECRET;
  if (!SECRET || SECRET.length < 16) {
    res.status(500).json({ error: 'Server configuration error' });
    return;
  }

  // ─── Method check: only accept POST ────────────────────────────────────────
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // ─── Auth check: Authorization header must match ──────────────────────────
  const authHeader = req.headers && req.headers.authorization;
  if (authHeader !== `Bearer ${SECRET}`) {
    console.log('[enrich-webhook] Rejected: bad or missing Authorization header');
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  // ─── Read raw body ─────────────────────────────────────────────────────────
  let body = '';
  await new Promise((resolve, reject) => {
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', resolve);
    req.on('error', reject);
  });

  let payload;
  try {
    payload = body ? JSON.parse(body) : {};
  } catch (e) {
    console.log('[enrich-webhook] Invalid JSON body:', body.substring(0, 500));
    res.status(400).json({ error: 'Invalid JSON' });
    return;
  }

  // ─── Log payload (visible in Vercel runtime logs) ──────────────────────────
  console.log('[enrich-webhook] Received at', new Date().toISOString());
  console.log('[enrich-webhook] Full payload:', JSON.stringify(payload, null, 2));

  // ─── Extract common fields (GHL field names vary by trigger; try several) ──
  const contactId =
    payload.contact_id || payload.contactId || payload.id ||
    (payload.contact && (payload.contact.id || payload.contact.contact_id));

  const email = payload.email || (payload.contact && payload.contact.email);
  const firstName = payload.first_name || payload.firstName || (payload.contact && (payload.contact.first_name || payload.contact.firstName));
  const lastName = payload.last_name || payload.lastName || (payload.contact && (payload.contact.last_name || payload.contact.lastName));

  console.log(`[enrich-webhook] Extracted contact: ${firstName || '?'} ${lastName || '?'} | id=${contactId || '?'} | email=${email || '?'}`);

  // ─── Respond 200 with what we extracted (helpful for the GHL test view) ───
  res.status(200).json({
    ok: true,
    phase: 1,
    received_at: new Date().toISOString(),
    extracted: {
      contactId: contactId || null,
      email: email || null,
      firstName: firstName || null,
      lastName: lastName || null
    },
    note: 'Phase 1 plumbing only. No enrichment yet.'
  });
};
