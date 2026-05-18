// Lead Enrichment Webhook v3 — three-stage architecture
//
// Stage 1 (Research): multi-turn agent loop with read-only GHL helpers
//   (direct HTTPS) plus Apollo and Firecrawl tools. Terminates by calling
//   emit_research_findings with a structured payload. Has no write tools.
//
// Stage 2 (Synthesis): single Anthropic call with tool_choice forced to
//   emit_enrichment. Returns parsed structured JSON covering classification,
//   ICP score, all 16 contact custom field values, business standard fields,
//   name corrections, and brief sections.
//
// Stage 3 (Writeback): function-side, deterministic. Selects the brief
//   template by classification, formats it, and issues exactly one each of
//   update_contact, update_business, create_contact_note via direct GHL
//   HTTPS. No agent involvement, no recovery loops, no verification needed.
//
// All previous robustness defenses preserved: waitUntil() lifecycle, retry
// with adaptive timeouts on Anthropic calls, 750s deadline guard, Slack
// alerts on failure, today's-date injection, function-level same-day
// idempotency guard.

const { waitUntil } = require('@vercel/functions');
const { getDriveFromTerraGenieHQ, driveTimeToD2DPoints } = require('./_maps');

// ─── Config ────────────────────────────────────────────────────────────────
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS_RESEARCH = 4096;
const MAX_TOKENS_SYNTHESIS = 8192;
const MAX_RESEARCH_TURNS = 30;
const PER_TURN_TIMEOUT_MS = 180 * 1000;
const SYNTHESIS_TIMEOUT_MS = 240 * 1000;
const ENRICHMENT_DEADLINE_MS = 750 * 1000;

const GHL_BASE_URL = process.env.GHL_BASE_URL || 'https://services.leadconnectorhq.com';
const GHL_API_VERSION = '2021-07-28';

// Canonical contact custom field IDs. Source of truth lives in the skill;
// this mirror is what Stage 3 uses to build the update_contact payload.
const CONTACT_FIELDS = {
  company_position: '8GBZUD9i0v4YwmN5D8ql',
  linkedin_url: 'Fs3vd5aDkfmCmMi5ezR5',
  industry: 'YmQKLcFMLHngYLPqNrQ1',
  decision_maker: 'hug3WGqPGpmWSTDIMCbQ',
  verified_email: 'KZLIXx1cqpjyxkp7nlGV',
  contact_source: 'GY8ouGyz20gvT4kOchnu',
  company_size_tier: 'UVccVccVWu9bEapOHcHP',
  revenue_tier: 'xksJTkHj856hdcMwGB5P',
  icp_score: 'huDhxJeTQwziNa1ieNhc',
  icp_segment: 'e0MhZI4Mz6Byy4KimPsU',
  service_area: 'JVDIFcZbbIg9q3rKeEOP',
  year_founded: 'tZjxUT4WsJwGQGtraUZM',
  enrichment_date: 'mKxoh4updlE5gTHn5rE4',
  enrichment_status: 'fWKopv1EoEk7w05xUbUZ',
  company_website: 'BYci9oLWTdYipwsuAzH3',
  enrichment_source: 'pu7XXEeb8y0195Dj2V4S',
  // AI outreach scaffolding (v1):
  // - enrichment_foundation: stable identity / company / fit prose, populated
  //   at enrichment time and re-populated only on full re-enrichment.
  //   Read by GHL Voice AI / Conversation AI / Email AI as long-term context.
  // - communication_memory: evolving conversation memory, initialized to a
  //   sentinel here and updated by the v2 /refresh-memory webhook on
  //   inbound events. Re-enrichment preserves existing memory.
  enrichment_foundation: 'Jfz323wRZQj75V1UFmIj',
  communication_memory: 'KVEJ8Dtw4frhx9Qik5bd',
  // ICP recalibration v2 (2026-05-18): added a second ICP score tuned for
  // door-to-door fit and a numerical drive time from the TerraGenie HQ
  // (5322 Ridgeway Dr, Orlando, FL 32819) so the field is queryable in GHL
  // for proximity filtering. Existing icp_score (huDhxJeTQwziNa1ieNhc) is
  // now framed as the revenue/opportunity score with no geo weighting.
  icp_score_d2d: 'KHLZ1Im8xxQG14EmE2sq',
  est_drive_time_min: 'HOit2kktcIuYMJXx4vCG'
};

// Sentinel value written to Communication Memory at first-time enrichment so
// downstream AI prompts always see a structured, parseable string instead of
// an empty field. The /refresh-memory webhook (v2) replaces this on the
// first inbound event.
const COMMUNICATION_MEMORY_SENTINEL =
  'HISTORICAL SUMMARY:\n(none yet, first contact, no conversation history)\n\nRECENT ACTIVITY (newest first):\n(no events yet)';

// ─── Skill content (re-embedded; v2.3) ─────────────────────────────────────
// The lead-enrichment skill content, embedded as a JS string literal. Source
// of truth is the Cowork skill mount; this constant is a snapshot that must
// be updated whenever the skill changes. Both Stage 1 and Stage 2 system
// prompts reference this so classification/scoring/brief rules stay aligned.
const SKILL_CONTENT = require('./_skill-content.js');

// ─── GHL HTTPS helpers ─────────────────────────────────────────────────────

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

async function ghlGetBusiness(businessId) {
  return ghlRequest(`/businesses/${businessId}`);
}

async function ghlUpdateContact(contactId, payload) {
  return ghlRequest(`/contacts/${contactId}`, 'PUT', payload);
}

async function ghlUpdateBusiness(businessId, payload) {
  return ghlRequest(`/businesses/${businessId}`, 'PUT', payload);
}

async function ghlCreateContactNote(contactId, body) {
  return ghlRequest(`/contacts/${contactId}/notes`, 'POST', { body });
}

// Read a contact custom field value by canonical name.
function readContactCustomField(contactResponse, fieldName) {
  const fieldId = CONTACT_FIELDS[fieldName];
  if (!fieldId) return undefined;
  const cf = (contactResponse && contactResponse.contact && contactResponse.contact.customFields) || [];
  const f = cf.find(x => x && x.id === fieldId);
  if (!f) return undefined;
  return f.value !== undefined ? f.value : f.field_value;
}

// Build the customFields array for an update_contact PUT body.
// Input: { fieldName: value, ... } where fieldName is a key in CONTACT_FIELDS.
// Empty/null/undefined values are skipped so we never null-out existing data.
function buildContactCustomFieldsArray(values) {
  const arr = [];
  for (const [name, value] of Object.entries(values || {})) {
    if (value === undefined || value === null || value === '') continue;
    const id = CONTACT_FIELDS[name];
    if (!id) continue;
    arr.push({ id, field_value: String(value) });
  }
  return arr;
}

// ─── External research tool executors (Apollo, Firecrawl) ──────────────────

async function execApolloPeopleMatch(input) {
  const body = { first_name: input.first_name, last_name: input.last_name };
  if (input.email) body.email = input.email;
  if (input.domain) body.domain = input.domain;
  if (input.organization_name) body.organization_name = input.organization_name;
  const res = await fetch('https://api.apollo.io/api/v1/people/match', {
    method: 'POST',
    headers: {
      'X-Api-Key': process.env.APOLLO_API_KEY,
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache'
    },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Apollo people/match ${res.status}: ${text.substring(0, 500)}`);
  return JSON.parse(text);
}

async function execApolloOrgEnrich(input) {
  const params = new URLSearchParams({ domain: input.domain });
  const res = await fetch(`https://api.apollo.io/api/v1/organizations/enrich?${params}`, {
    method: 'GET',
    headers: { 'X-Api-Key': process.env.APOLLO_API_KEY, 'Cache-Control': 'no-cache' }
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Apollo organizations/enrich ${res.status}: ${text.substring(0, 500)}`);
  return JSON.parse(text);
}

async function execFirecrawlScrape(input) {
  const body = {
    url: input.url,
    formats: ['markdown'],
    onlyMainContent: input.only_main_content !== false
  };
  const res = await fetch('https://api.firecrawl.dev/v1/scrape', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.FIRECRAWL_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Firecrawl scrape ${res.status}: ${text.substring(0, 500)}`);
  return JSON.parse(text);
}

async function execFirecrawlSearch(input) {
  const body = { query: input.query, limit: input.limit || 5 };
  const res = await fetch('https://api.firecrawl.dev/v1/search', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.FIRECRAWL_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Firecrawl search ${res.status}: ${text.substring(0, 500)}`);
  return JSON.parse(text);
}

// Stage 1 read-only GHL custom tools — wraps direct HTTPS so the agent can
// pull contact and business data without any MCP exposure (which would
// expose write tools).
async function execGetContactTool(input) {
  return ghlGetContact(input.contactId);
}

async function execGetBusinessTool(input) {
  return ghlGetBusiness(input.businessId);
}

async function executeStage1Tool(name, input) {
  const inputPreview = JSON.stringify(input).substring(0, 200);
  console.log(`[research] tool_call: ${name} ${inputPreview}`);
  try {
    let result;
    switch (name) {
      case 'get_contact': result = await execGetContactTool(input); break;
      case 'get_business': result = await execGetBusinessTool(input); break;
      case 'apollo_people_match': result = await execApolloPeopleMatch(input); break;
      case 'apollo_organizations_enrich': result = await execApolloOrgEnrich(input); break;
      case 'firecrawl_scrape': result = await execFirecrawlScrape(input); break;
      case 'firecrawl_search': result = await execFirecrawlSearch(input); break;
      default: throw new Error(`Unknown Stage 1 tool: ${name}`);
    }
    return result;
  } catch (err) {
    console.error(`[research] tool ${name} failed: ${err.message}`);
    return { error: err.message };
  }
}

// ─── Tool schemas ──────────────────────────────────────────────────────────

const STAGE1_TOOLS = [
  {
    name: 'get_contact',
    description: 'Read a GHL contact by ID. Returns contact object including custom field values, email, phone, name, businessId, tags, and contact source.',
    input_schema: {
      type: 'object',
      properties: { contactId: { type: 'string' } },
      required: ['contactId']
    }
  },
  {
    name: 'get_business',
    description: 'Read a GHL business by ID. Returns business object including standard fields (name, website, phone, address, description) and existing custom fields.',
    input_schema: {
      type: 'object',
      properties: { businessId: { type: 'string' } },
      required: ['businessId']
    }
  },
  {
    name: 'apollo_people_match',
    description: 'Match a person on Apollo by name + email or domain. Returns title, seniority, LinkedIn URL, and embedded organization data. Cost: 1 Apollo credit.',
    input_schema: {
      type: 'object',
      properties: {
        first_name: { type: 'string' },
        last_name: { type: 'string' },
        email: { type: 'string' },
        domain: { type: 'string' },
        organization_name: { type: 'string' }
      },
      required: ['first_name', 'last_name']
    }
  },
  {
    name: 'apollo_organizations_enrich',
    description: 'Enrich a company by domain on Apollo. Returns industry, employee count, annual revenue, founded year, address, description, website. Cost: 1 Apollo credit. Skip if person.organization from people_match already has the data.',
    input_schema: {
      type: 'object',
      properties: { domain: { type: 'string' } },
      required: ['domain']
    }
  },
  {
    name: 'firecrawl_scrape',
    description: 'Scrape a webpage and return main content as markdown. Read the markdown yourself and extract intelligence — never trust auto-extraction.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        only_main_content: { type: 'boolean' }
      },
      required: ['url']
    }
  },
  {
    name: 'firecrawl_search',
    description: 'Google search via Firecrawl. Returns ranked URLs and snippets. Use to find company websites, Sunbiz records, Google Maps listings, LinkedIn pages.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' }
      },
      required: ['query']
    }
  },
  {
    name: 'emit_research_findings',
    description: 'Stage 1 terminator. Call EXACTLY ONCE when research is complete to pass structured findings to Stage 2 (synthesis). Stage 2 will then classify, score, and produce the pre-call brief from this payload. Stop researching and emit when you have enough data to confidently classify and score at least 3 of the 6 ICP factors. If sources are exhausted without sufficient data, set sufficient=false and emit anyway — Stage 3 will produce a Failure brief.',
    input_schema: {
      type: 'object',
      properties: {
        sufficient: { type: 'boolean', description: 'True if 3+ ICP factors can be scored confidently. False if all sources exhausted.' },
        classification_intent: {
          type: 'string',
          enum: ['customer', 'partner', 'low_fit', 'failure'],
          description: 'Best read of the classification per Phase 6 Step 1. Stage 2 may refine.'
        },
        contact_summary: {
          type: 'object',
          properties: {
            first_name: { type: 'string' },
            last_name: { type: 'string' },
            email: { type: 'string' },
            phone: { type: 'string' },
            company_name: { type: 'string' },
            discovered_domain: { type: 'string' },
            known_lead_source: { type: 'string' },
            business_id: { type: 'string', description: 'GHL businessId from the contact record (passes through to Stage 3 for update_business).' }
          }
        },
        apollo_person: {
          type: 'object',
          description: 'Compact summary: title, seniority, linkedin_url, organization_name/website/industry/employees/revenue if embedded.',
          properties: {
            title: { type: 'string' },
            seniority: { type: 'string' },
            linkedin_url: { type: 'string' },
            organization_name: { type: 'string' },
            organization_website: { type: 'string' },
            organization_industry: { type: 'string' },
            organization_employees: { type: 'integer' },
            organization_revenue: { type: 'number' },
            organization_description: { type: 'string' },
            organization_founded_year: { type: 'integer' }
          }
        },
        apollo_organization: {
          type: 'object',
          description: 'Compact org enrich summary if separately fetched.',
          properties: {
            industry: { type: 'string' },
            employees: { type: 'integer' },
            annual_revenue: { type: 'number' },
            founded_year: { type: 'integer' },
            description: { type: 'string' },
            website: { type: 'string' },
            phone: { type: 'string' },
            street: { type: 'string' },
            city: { type: 'string' },
            state: { type: 'string' },
            postal_code: { type: 'string' },
            country: { type: 'string' }
          }
        },
        firecrawl_findings: {
          type: 'object',
          properties: {
            services: { type: 'string', description: 'Services / specialties / project types found on the website.' },
            service_areas: { type: 'string', description: 'Geographic regions / cities / counties served.' },
            equipment_signals: { type: 'string', description: 'Mentions of GPS, drones, 3D scanning, etc. (TerraGenie fit signals).' },
            customer_vs_vendor: { type: 'string', description: 'Whether the company looks like a direct customer prospect vs. tech vendor / supplier.' },
            extracted_company_description: { type: 'string' },
            notes: { type: 'string', description: 'Any other relevant observations.' }
          }
        },
        fallback_findings: {
          type: 'object',
          description: 'Free-form notes from Sunbiz, Google Maps, LinkedIn search, etc. when Apollo + Firecrawl were insufficient.',
          properties: {
            sunbiz: { type: 'string' },
            google_maps: { type: 'string' },
            linkedin: { type: 'string' },
            other: { type: 'string' }
          }
        },
        sources_used: {
          type: 'array',
          items: { type: 'string' },
          description: 'Sources that returned usable data, e.g. ["Apollo Person", "Apollo Org", "Firecrawl", "Sunbiz", "Google Maps", "LinkedIn"]. Stage 2 appends "AI Synthesis" automatically.'
        },
        data_gaps: {
          type: 'array',
          items: { type: 'string' },
          description: 'Specific factors that could not be scored, e.g. "geography unknown", "no decision-maker title", "no revenue".'
        },
        name_correction_candidates: {
          type: 'object',
          properties: {
            first_name: { type: 'string' },
            last_name: { type: 'string' },
            company_name: { type: 'string' },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
            note: { type: 'string' }
          }
        },
        research_summary: {
          type: 'string',
          description: '2-4 paragraph free-form synthesis of what was found. Stage 2 reads this when generating brief sections.'
        },
        hq_address: {
          type: 'object',
          description: 'Best available HQ / primary-office street address for the company. Used by the pipeline to compute driving distance from TerraGenie HQ (5322 Ridgeway Dr, Orlando, FL 32819) for the D2D ICP score. Prefer Apollo organization street+city+state, then Firecrawl contact-page address, then Sunbiz principal-place-of-business address, then any city/state hint from service_area. If you only have a city/state, populate full_address as e.g. "Tampa, FL"; partial is better than null.',
          properties: {
            full_address: {
              type: 'string',
              description: 'A single-string address suitable for geocoding. Examples: "1100 Crescent Lake Dr, Sanford, FL 32773" / "Downtown Tampa, FL" / "Jacksonville, FL". Leave empty if no geographic signal is available at all.'
            },
            confidence: { type: 'string', enum: ['high', 'medium', 'low', 'none'] },
            source: { type: 'string', description: 'Which source the address came from: "apollo_org", "firecrawl_contact_page", "sunbiz", "google_maps", "service_area_inference", or "none".' }
          }
        },
        pocs: {
          type: 'array',
          description: 'Decision-maker POCs (Points of Contact) discovered for THIS company beyond the lead form contact. Sales reps use these to name-drop when calling the company main line and the form contact does not pick up. Target 2-3 senior decision-makers (owner, principal, president, CEO, VP, GM, COO, head of operations, head of field, controller). Skip junior staff. Skip the lead-form contact themselves (they are handled separately). Only include people with at least one actionable channel (phone, email, or LinkedIn) AND medium-or-high confidence in their role at this company. Better to return 0 high-confidence POCs than 5 speculative ones — Stage 2 will surface what you find.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Full name. Title Case.' },
              title: { type: 'string', description: 'Role / title at this company. Be specific: "Owner", "President", "VP Field Operations", "Director of Survey", "Co-Founder", "Operations Manager", "General Manager". Avoid vague titles like "Manager".' },
              phone: { type: 'string', description: 'Direct phone / mobile if found. Include extension if known. Empty string if not found.' },
              email: { type: 'string', description: 'Direct email if found. Empty string if not found.' },
              linkedin_url: { type: 'string', description: 'LinkedIn profile URL if found. Empty string if not found.' },
              source: { type: 'string', description: 'Where the POC was discovered: "apollo_people_match", "firecrawl_leadership_page", "firecrawl_about_page", "firecrawl_contact_page", "google_search_owner", "sunbiz_officers", "linkedin_search", or a combination like "apollo+firecrawl".' },
              confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: 'high: name+title+at-least-two-actionable-channels verified across 2+ sources. medium: name+title verified with at least one actionable channel from 1 reliable source. low: name+title only, no actionable channel — usually skip unless company is small and these are the only names available.' },
              note: { type: 'string', description: 'Optional 1-line context Gal can use when name-dropping: prior employer overlap, alma mater, recent press, public quote, anything that builds rapport. Leave empty if no signal.' }
            },
            required: ['name', 'title', 'source', 'confidence']
          }
        }
      },
      required: ['sufficient', 'classification_intent', 'contact_summary', 'sources_used', 'research_summary', 'hq_address']
    }
  }
];

const EMIT_ENRICHMENT_TOOL = {
  name: 'emit_enrichment',
  description: 'Stage 2 terminator and ONLY valid output. Call exactly once with the complete enrichment object. Stage 3 will write contact custom fields, business standard fields, and the pre-call brief note from this payload deterministically.',
  input_schema: {
    type: 'object',
    properties: {
      classification: { type: 'string', enum: ['customer', 'partner', 'low_fit', 'failure'] },
      icp_score: {
        type: 'integer',
        minimum: 0,
        maximum: 100,
        description: 'REVENUE/OPPORTUNITY FIT score (0-100). "How big a win if we land them, ignoring sales-cycle difficulty and geography." Heavy weight on revenue tier, deal-size potential, decision-maker access. NO geography weighting (geography lives in icp_score_d2d). Enterprise GCs that are sales-cycle nightmares can still score 90+ here because the dollar value of landing them is huge.'
      },
      icp_score_d2d: {
        type: 'integer',
        minimum: 0,
        maximum: 100,
        description: 'DOOR-TO-DOOR FIT score (0-100). "Should a TerraGenie rep drive there and knock?" Heavy weight on driving distance from HQ + business-type taxonomy + project-volume sweet spot. ENTERPRISE GCs score LOW here even if revenue potential is huge — too many decision-makers, too long a cycle for D2D motion. Computation: start from base fit (business type + project volume + decision-maker accessibility, scored 0-65), apply business-type multiplier (1.0 for sweet-spot builders down to 0.0 for out-of-vertical), then ADD the drive-time tier points from drive_data.d2d_points_from_distance (range -20 to +35). Clamp final to 0-100. If drive_data.drive_time_minutes is null, set the geography component to 0 and note "drive time unavailable" in icp_score_d2d_breakdown.'
      },
      icp_score_d2d_breakdown: {
        type: 'string',
        description: 'Factor-by-factor breakdown of the D2D score. Example: "Drive 25min/+35 (Orlando metro); Business type 1.0x (mid-size residential builder); Volume signal 20/25 (30-50 homes/yr est); Decision-maker accessibility 10/15 (owner findable); Size penalty 0 (right band)". Stage 3 renders this in the brief next to the score.'
      },
      confidence_level: { type: 'string', enum: ['High', 'Medium', 'Low', 'Very Low'] },
      icp_segment: {
        type: 'string',
        description: 'Per Phase 6 Step 4. Use the dash form exactly as defined in the skill (e.g. "Primary - Civil/Construction", "Partner - Technology Vendor", "Low Fit - Property Management").'
      },
      engagement_signal: { type: 'string', description: 'One-liner per Phase 6 Step 5.' },
      icp_scoring_breakdown: {
        type: 'string',
        description: 'Factor-by-factor breakdown of the REVENUE score. Example: "Industry 35/35 (Construction); Decision Maker 15/15 (CEO); Company Size 12/15 (Mid-market 50-200); Revenue Potential 25/30 ($10M-$50M est); Digital Presence 5/5 (Full website)". Used by Stage 3 in the brief alongside icp_score_d2d_breakdown.'
      },
      est_drive_time_min: {
        type: 'integer',
        description: 'The driving time in minutes from TerraGenie HQ to the company HQ. ALWAYS copy this value verbatim from drive_data.drive_time_minutes (round to nearest integer). If drive_data.drive_time_minutes is null, omit this field entirely. Do not invent or estimate — only echo what the deterministic ORS lookup produced.'
      },
      poc_research: {
        type: 'array',
        description: 'Distilled decision-maker POC list (2-3 max) drawn from findings.pocs. Sales reps name-drop these when calling the main line and the lead-form contact does not answer. Deduplicate the raw pocs[], drop low-confidence entries unless the company is very small, preserve verbatim contact channels, order by seniority. Skip the lead-form contact themselves. Empty array is acceptable if no high-confidence POCs were found.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            title: { type: 'string' },
            phone: { type: 'string', description: 'Empty string if not found.' },
            email: { type: 'string', description: 'Empty string if not found.' },
            linkedin_url: { type: 'string', description: 'Empty string if not found.' },
            source: { type: 'string', description: 'Source(s) the POC was confirmed from, comma-separated if multiple.' },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
            name_drop_hook: { type: 'string', description: 'Optional 1-line context the rep can mention when calling the main line: "Recently quoted in the Orlando Business Journal on labor costs", "Co-founded with [other person] in 2003", "Listed on the leadership page as VP of Field Ops". Empty if no specific hook.' }
          },
          required: ['name', 'title', 'confidence']
        }
      },
      enrichment_foundation: {
        type: 'string',
        description: 'Stable identity-and-fit prose paragraph for downstream AI outreach (Voice AI, Conversation AI, Email AI). Plain prose, no emoji / bullets / em dashes / markdown. Bots read this verbatim as long-term context for personalized outreach. Better to say less with high accuracy than to say more with speculation. A short, defensive Foundation is correct when data is thin. A speculative Foundation is a defect: it produces embarrassing outreach.\n\nCONFIDENCE TIER (decide first, then write):\n  Tier A (high confidence): contact full name verified across sources, role/seniority known with at least medium confidence, company verified with services confirmed via primary sources (own website services page, LinkedIn company page). ICP factors scored 5+/6. Classification typically customer or partner.\n  Tier B (mixed confidence): company verified but contact identity is partial (last name missing or contradictory, or first-name-only on the form), OR services known only via secondary sources (BBB, BuildZoom, permits) without primary confirmation, OR ICP < 50, OR classification low_fit.\n  Tier C (low confidence / failure): identity unknown, no usable enrichment, or classification=failure.\n\nLENGTH BY TIER:\n  Tier A: 100-150 words.\n  Tier B: 60-100 words.\n  Tier C: 40-60 words.\n\nABSOLUTE FORBID LIST (every tier):\n  1. NEVER name the contact if their last name is missing, equal to their first name (e.g., "Dave Dave"), absent from sources, or contradicted by source records. Use "the contact" or "the company contact" instead. Naming a contact you cannot verify is a defect.\n  2. NEVER name third parties surfaced by enrichment (registered agents, managing members from state databases, BBB listed owners) unless that person IS the contact with verified match. Bots only care about the contact, not the org chart.\n  3. NEVER state a specific industry sub-segment ("residential remodeling", "commercial paving", "underground utilities") unless it is confirmed by primary source (the company\'s own website services page or LinkedIn). Secondary sources (BBB categories, permit records) are signal, not confirmation.\n  4. NEVER recommend a specific pitch angle in Tier B or Tier C. The closing sentence in B/C must use generic language like: "Lead with open discovery before referencing TerraGenie capabilities" or "Use the lead source as the warm hook and ask qualifying questions". DO NOT anchor on a service vertical the bot will pitch around.\n  5. NEVER echo icp_score, segment, scoring breakdown, email, phone, or LinkedIn (the bot has these separately).\n  6. NEVER use em dashes or en dashes.\n\nTIER A SHAPE (Identity sentence with name + role + company + one-phrase what-they-do, Lead source, Fit context, One specific verified value-prop hook). End with a specific angle tied to their verified work.\n\nTIER B SHAPE (Open by stating Lead source and verified company name, NOT the contact\'s name. Acknowledge what is NOT confirmed in plain language: "Contact\'s role and last name are not verified", "Company\'s specific service mix is not confirmed beyond secondary sources", etc. Close with a generic-discovery direction).\n\nTIER C SHAPE (Begin: "Generic outreach context. No reliable enrichment data available." Then one sentence on the lead source as the warm hook. Then one sentence directing the bot to ask open discovery and avoid referencing company, industry, or services).\n\nDo not add headers. Do not use the words "Tier A/B/C", "Shape A/B/C", or "Confidence:" in the output. Just the prose paragraph.\n\nEXAMPLE of a Tier B output that is CORRECT (note: no contact name, no third parties, no specific pitch angle):\n"Lead came in via Facebook ad for FL builders and site development in May 2026. Company on record is Singular Construction LLC in South Florida; the contact\'s role and last name are not verified, and the email on file is invalid. Secondary sources suggest a small residential general contractor profile, but primary services have not been confirmed against the company\'s own materials. Lead with open discovery before referencing TerraGenie capabilities; do not anchor on a specific service vertical until the contact describes their actual work."\n\nEXAMPLE of a Tier B output that is INCORRECT (defects: speculative name, third-party name, specific pitch angle):\n"Dave Benini is the name on record for Singular Construction LLC; FL DBPR records list David Sabag as managing member. The company focuses on residential remodeling including kitchen and bathroom renovations. Bots should lead with a discovery question about whether the company handles driveway, paving, or utility-related site work."'
      },
      name_corrections: {
        type: 'object',
        description: 'Only include fields where there is medium-or-high confidence the GHL value is wrong. Stage 3 overwrites these via update_contact / update_business. Always apply Title Case fixes for all-lower or ALL-CAPS names.',
        properties: {
          first_name: { type: 'string' },
          last_name: { type: 'string' },
          company_name: { type: 'string' }
        }
      },
      contact_fields: {
        type: 'object',
        description: 'Values for the 16 contact custom fields. Use empty string to skip a field (Stage 3 will not write it). enrichment_date is set by Stage 3 (do not include).',
        properties: {
          company_position: { type: 'string' },
          linkedin_url: { type: 'string' },
          industry: { type: 'string', enum: ['Construction', 'Surveyors', 'Infrastructure Detectors', 'Landscape or Playgrounds', 'Pools', 'Other', ''] },
          decision_maker: { type: 'string', enum: ['Yes', 'No', 'Unknown', 'Gatekeeper', ''] },
          verified_email: { type: 'string' },
          contact_source: { type: 'string', description: 'Only set if currently empty in GHL. Stage 3 enforces preservation.' },
          company_size_tier: { type: 'string' },
          revenue_tier: { type: 'string' },
          service_area: { type: 'string' },
          year_founded: { type: 'integer' },
          company_website: { type: 'string' },
          enrichment_source: { type: 'string', description: 'Pipe-delimited list of sources that returned data. Stage 3 appends " | AI Synthesis" automatically.' },
          enrichment_status: { type: 'string', enum: ['Fully Enriched', 'Partially Enriched', 'Enrichment Failed'] }
        }
      },
      business_fields: {
        type: 'object',
        description: 'Standard business fields. Only include fields you want Stage 3 to write. Empty / absent fields are skipped so existing GHL data is preserved.',
        properties: {
          name: { type: 'string' },
          website: { type: 'string' },
          phone: { type: 'string' },
          email: { type: 'string' },
          address: { type: 'string' },
          city: { type: 'string' },
          state: { type: 'string' },
          postal_code: { type: 'string' },
          country: { type: 'string' },
          description: { type: 'string' }
        }
      },
      brief: {
        type: 'object',
        description: 'Pre-call brief sections. Stage 3 selects the template by classification and assembles. Populate the sections that apply to this classification (see Phase 6 brief templates in the skill). opening_angles is MANDATORY for every classification.',
        properties: {
          header_flag: { type: 'string', description: 'Customer only, optional. Use plain text like "TOP PRIORITY LEAD" when ICP score is 90+, or a warning marker when there is a data discrepancy. Stage 3 prepends visual decoration.' },
          who: { type: 'string', description: 'WHO HE/SHE IS (customer, low_fit) or WHO THEY ARE (partner) — 2-4 sentence narrative.' },
          company: { type: 'string', description: 'THE COMPANY — 2-4 sentence narrative. Used for customer and low_fit; optional for partner.' },
          lead_source: { type: 'string', description: 'LEAD SOURCE line. Format example: "Source: Web Form - Demo Request - submitted at IBS expo, indicates active interest". Used for customer and low_fit.' },
          customer_why_fits: { type: 'string', description: 'WHY TerraGenie FITS — customer only. 2-3 sentences specific to this company.' },
          customer_deal_size: { type: 'string', description: 'POTENTIAL DEAL SIZE — customer only, optional.' },
          partner_partnership_potential: { type: 'string', description: 'PARTNERSHIP POTENTIAL — partner only.' },
          partner_referral_angle: { type: 'string', description: 'REFERRAL/INTEGRATION ANGLE — partner only.' },
          partner_considerations: { type: 'string', description: 'CONSIDERATIONS — partner only, optional.' },
          low_fit_icp_notes: { type: 'string', description: 'ICP NOTES — low_fit only. Factual, neutral. No "do not pursue" language.' },
          low_fit_possible_angles: { type: 'string', description: 'POSSIBLE ANGLES — low_fit only.' },
          failure_what_we_know: { type: 'string', description: 'WHAT WE KNOW — failure only.' },
          failure_what_we_tried: { type: 'string', description: 'WHAT WE TRIED — failure only.' },
          failure_next_steps: { type: 'string', description: 'RECOMMENDED NEXT STEPS — failure only.' },
          opening_angles: {
            type: 'array',
            items: { type: 'string' },
            minItems: 2,
            description: 'MANDATORY for every classification. 2-3 ready-to-use opening lines. When data is thin, anchor on lead source / form responses / geography / company name and explicitly note the limitation.'
          },
          contact_info: { type: 'string', description: 'Pre-formatted multi-line block with available email, phone, LinkedIn, etc.' }
        },
        required: ['who', 'opening_angles']
      }
    },
    required: ['classification', 'icp_score', 'icp_score_d2d', 'confidence_level', 'icp_segment', 'contact_fields', 'brief']
  }
};

// ─── System prompts (date-injected, skill-content-embedded) ────────────────

function buildResearchSystemPrompt() {
  const today = new Date().toISOString().slice(0, 10);
  return `You are running Stage 1 (Research) of an automated lead-enrichment pipeline triggered by a GoHighLevel webhook. You are RESEARCH ONLY. You do NOT write to GHL. A separate stage handles all writeback.

CURRENT DATE: ${today} (today, YYYY-MM-DD, UTC).

Your job: gather and verify information about this lead so the synthesis stage can produce a high-quality pre-call brief. Run Phases 1 through 5 of the skill below (Input/Identification, Domain Discovery, Apollo Person, Apollo Org, Firecrawl Website with optional sub-page scrapes, plus the multi-source fallback chain when Apollo org is empty). Apply the classification gate guidance from Phase 6 Step 1 only enough to decide which kind of brief should be generated downstream — set classification_intent in your emit payload accordingly. Do NOT compute the final ICP score or write the brief text; Stage 2 owns those.

Tools available in THIS stage:
- get_contact, get_business — read-only GHL data via direct HTTPS
- apollo_people_match, apollo_organizations_enrich — Apollo person and company enrichment
- firecrawl_scrape, firecrawl_search — website scraping and Google search
- emit_research_findings — TERMINATOR. Call exactly once when research is complete with the structured findings payload.

Tools NOT available:
- update_contact, update_business, create_contact_note — owned by Stage 3 writeback. They are not registered for this stage; do not attempt to call them.
- Fullenrich tools — Stage 1 does not run Fullenrich. The skill default of OFF applies absolutely here.

When you have enough data to confidently classify the lead AND score at least 3 of the 6 ICP factors, call emit_research_findings with the structured payload. Be thorough but bounded — once you have enough, stop researching and emit. Adaptive multi-source fallback is preserved: if Apollo org is empty or Firecrawl yields thin data, run the Phase 4b fallback chain (Sunbiz, Google Maps, LinkedIn) before emitting. Conditional sub-page scrapes (/about, /services, /our-work) are encouraged when the homepage is thin.

STRICTLY REQUIRED: populate hq_address.full_address in emit_research_findings with a non-empty geocodable string. This is now a required schema field. Driving distance from TerraGenie HQ (5322 Ridgeway Dr, Orlando, FL 32819) is the dominant factor in the D2D ICP score; failing to surface an address makes the whole score collapse.

Resolution priority (use the FIRST one that yields something):
  1. Apollo organization street + city + state + postal_code (best, full street address)
  2. Firecrawl contact / about / footer page address (very common)
  3. Sunbiz principal-place-of-business address (FL LLCs)
  4. GHL business record address
  5. Apollo org city + state only (good fallback if no street)
  6. service_area inference — if the company's service area mentions specific FL cities, use the most likely HQ city as "<City>, FL". For example if service_area is "Central Florida (Ocoee, Orlando, Winter Springs)", set full_address = "Ocoee, FL" (the first city listed is usually the primary). If service_area is "South Florida (Miami, Fort Lauderdale)", use "Miami, FL".

ACCEPTABLE values for full_address (any of these work — partial is far better than empty):
  - Full street: "2222 Ocoee Apopka Rd Suite 104, Ocoee, FL 34761"
  - City + state: "Winter Park, FL"
  - Metro region: "Orlando metro, FL"
  - State only: "Florida" (last resort if NO city signal exists anywhere)

DO NOT EMIT empty string or "Unknown" or omit the field. If literally no geographic signal exists across ALL the sources you searched (very rare), set full_address = "Florida" with confidence = "low" and source = "default_state_fallback".

DO NOT set confidence = "none" unless you genuinely searched all sources and found zero geo signal. "Service area mentions FL" is a geo signal.

POC RESEARCH (NEW): in addition to enriching the lead-form contact, hunt for 2-3 OTHER decision-makers at the same company so the sales rep can name-drop when calling the company main line. Populate the pocs[] array in emit_research_findings. Target senior decision-makers only: Owner / Principal / President / CEO / Co-Founder / VP / GM / COO / Head of Operations / Head of Field / Director of Survey / Controller. Skip junior staff and individual contributors.

Practical POC discovery strategy (apply in this order, stop when you have 2-3 solid POCs):
  1. Firecrawl scrape the company's leadership / about / team / our-people pages if they exist (look at the homepage navigation for likely URLs).
  2. Firecrawl scrape the company's contact / contact-us page (often lists key people).
  3. Firecrawl search "<company name> owner" / "<company name> president" / "<company name> founder" — surfaces press, BBB, BuildZoom, news pages with names.
  4. If Sunbiz returned officers/directors and the company is small (Florida LLC, sole owner), those officer names are usually the actual decision-makers — include them.
  5. If Apollo organization data was retrieved, organization.contacts (when present) may list senior people.
  6. For each candidate name, decide whether to spend an apollo_people_match call to verify role and pull contact channels. Worth it for 1-3 likely owners. Not worth it for every junior employee.

POC inclusion gate:
  - Include in pocs[] ONLY if (a) role is senior-decision-maker per the list above AND (b) you can attest at least medium confidence in their current role at THIS company AND (c) you have at least one actionable channel (phone, email, or LinkedIn) OR the company is small enough that even a name-only POC is useful for name-dropping.
  - DO NOT pad the list with low-confidence names just to hit 2-3. Better to return 1 high-confidence POC than 3 speculative ones.
  - Skip the lead-form contact themselves — they are already in the brief.
  - Skip people clearly listed as "former" or who left the company per LinkedIn or news.

Time budget: spend at most 4-5 turns on POC research for the whole batch. Diminishing returns past 3 solid POCs.

If you exhaust all sources and still cannot score 3 factors, set sufficient=false in the emit_research_findings payload and emit anyway. Stage 3 will produce a Failure brief.

After emit_research_findings returns successfully, end your turn. Do not call any other tools.

---

${SKILL_CONTENT}`;
}

function buildSynthesisSystemPrompt() {
  return `You are running Stage 2 (Synthesis) of an automated lead-enrichment pipeline. Your input is a structured research payload from Stage 1. Your output is exactly ONE call to emit_enrichment with a complete structured enrichment object. You do NOT write to GHL — Stage 3 (function code) handles all writeback deterministically based on what you emit.

Steps to perform, in order:
1. Classify: customer, partner, low_fit, or failure. Use Stage 1's classification_intent as the starting point; refine only if data warrants. (Skill Phase 6 has the classification gate detail; Stage 1 has already pre-classified.)
2. Compute BOTH ICP scores per the "DUAL ICP SCORING" section:
   - icp_score: 0-100, REVENUE/OPPORTUNITY fit only, no geography weighting
   - icp_score_d2d: 0-100, DOOR-TO-DOOR fit, geo-dominant
   Then set confidence_level (High / Medium / Low / Very Low) to reflect the WEAKER of the two scores' supporting data. Important: confidence_level is a SEPARATE METADATA FIELD; it does NOT discount either score number. Score numbers are pure formula results.
3. Set icp_segment using the dash form (e.g., "Primary - Civil/Construction", "Partner - Technology Vendor", "Low Fit - Property Management"). Self-performing GC rule: if the company runs a self-performing construction division (their own in-house crews build the sites), classify as Primary - Civil/Construction regardless of corporate parent's headline industry. The self-performing division IS a construction GC, and that is what matters for TerraGenie.
4. Populate icp_scoring_breakdown (revenue) AND icp_score_d2d_breakdown (D2D) with one-line per-factor explanations.
5. Echo est_drive_time_min = drive_data.drive_time_minutes (rounded to integer). Omit entirely if drive_data.drive_time_minutes is null. Do NOT emit 0.
6. Distill poc_research from findings.pocs per the "POC DISTILLATION" section.
7. Compute contact_fields values. Empty string ("") on any field you cannot determine; Stage 3 skips empties so existing GHL data is preserved. enrichment_date is set by Stage 3.

   FIELD PLACEMENT: icp_score, icp_score_d2d, icp_segment, est_drive_time_min are TOP-LEVEL on emit_enrichment, NOT under contact_fields.

   year_founded: omit entirely if no confirmed year. Never emit 0 (displays as "Year Founded: 0" in GHL).

8. Compute business_fields, name_corrections, and brief sections per classification, then generate enrichment_foundation per its schema description.

DUAL ICP SCORING (added 2026-05-18 — supersedes any single-score guidance in the skill):

A) icp_score (REVENUE/OPPORTUNITY, 0-100, no geography)
   The pure "how big is the win if we land them" score, independent of sales-cycle difficulty.
   Inputs and weights (sum to 100):
     Industry fit / TerraGenie use case (0-30): construction-adjacent verticals with layout/grade-check needs score full; non-fit verticals score 0
     Revenue potential (0-25): higher revenue / larger projects = higher score
     Decision-maker access (0-20): identified senior decision-maker with verified channel = full; gatekeeper-only or unknown = partial
     Company size signal (0-15): mid-market and up score full; nano-shops score lower (less capacity to pay)
     Digital presence / discoverability (0-10): mature website, LinkedIn, press = full
   Result: a giant enterprise GC with $500M revenue scores 95+ here even if sales cycle is brutal. That is correct.

B) icp_score_d2d (DOOR-TO-DOOR, 0-100, geo-dominant)
   The "should a rep drive there and knock today" score. For the next 3-6 months TerraGenie wants reps spending door-knock time on the SWEET SPOT: mid-size local builders/contractors in the Orlando driving radius.

   Compute in three layers:

   Layer 1 — base fit (0-65 points):
     Project volume signal (0-30): mid-volume sweet spot (10-100 homes/yr residential OR 5+ commercial projects/yr) scores full. Tiny (<10 homes/yr) scores low. Giants score low here too. Inferred from revenue + size when not stated explicitly.
     Decision-maker accessibility (0-20): owner/principal findable = full. Multi-layer org with gatekeeper = low. Lead-form contact is a real decision-maker = bonus.
     Business operational complexity (0-15): companies whose work requires field layout regularly (commercial GC, heavy civil, utility, high-end residential, large-scale landscape) score full. Mow-and-blow landscapers, pure interior-only finish work, pure paperwork brokers score low.

   Layer 2 — business-type multiplier (apply to base_fit before adding drive points; clamp to 0-65):
     1.00x  Mid-size residential builder (10-100 homes/yr)
     1.00x  Mid-size commercial contractor (5+ projects/yr)
     1.00x  Heavy civil / site work contractor in the size sweet spot
     0.95x  Utility contractor (water/sewer/gas) in size sweet spot
     0.85x  High-end landscape design / hardscape (NOT general mow-and-blow)
     0.75x  Pool / outdoor structure builder (size sweet spot)
     0.40x  Small residential GC (<10 homes/yr)
     0.30x  Enterprise GC (200+ employees, multi-state, deep org chart) — too big for D2D motion
     0.10x  General landscaping (mow-and-blow / lawn maintenance)
     0.00x  Out of vertical (property management, insurance, retail, etc.)

   Layer 3 — drive-time tier points (THIS IS A PRE-COMPUTED INTEGER IN drive_data.d2d_points_from_distance):
     The pipeline already mapped drive_time_minutes to the right tier value BEFORE you saw it. Your only job is to READ drive_data.d2d_points_from_distance and ADD it to the layer-1 result. Do NOT re-derive this from drive_time_minutes. Do NOT decide the drive lookup "failed" based on your own reading.

     RULES FOR READING drive_data:
       1. If drive_data.d2d_points_from_distance is a number (including 0): use that number verbatim as your drive_points. Do not adjust it.
       2. If drive_data.drive_time_minutes is a positive number, ALWAYS use drive_data.d2d_points_from_distance as your drive_points. The pipeline computed it correctly; trust it.
       3. The ONLY case where you can describe the lookup as "failed" or "geo-blind" is when drive_data.skipped_reason is non-null. Otherwise drive_data is valid and you must use it.

   Reference table (for context only, do NOT recompute):
     drive_time_minutes < 45 → +35 (Orlando metro core)
     45-90 → +25 (Tampa, Lakeland, Daytona, Ocala band)
     90-150 → +10 (Gainesville, Vero, Sarasota band)
     150-240 → -5 (Jacksonville, far panhandle band)
     240-360 → -15
     >= 360 → -20

   Final: icp_score_d2d = clamp(layer1_after_multiplier + drive_data.d2d_points_from_distance, 0, 100)

   Worked example A (Hillpointe-shape, drive_data valid):
     drive_data = { drive_time_minutes: 25, d2d_points_from_distance: 35, skipped_reason: null }
     base_fit = 28 (volume 10 + DM 5 + complexity 13)
     multiplier = 0.30 (Enterprise GC)
     layer1 = 28 × 0.30 = 8.4 → 8
     drive_points = 35 (from drive_data, NOT re-derived)
     icp_score_d2d = clamp(8 + 35, 0, 100) = 43
     icp_score_d2d_breakdown = "Drive 25min/+35 (Orlando metro); Type 0.30x (Enterprise GC); Volume 10/30; DM 5/20; Complexity 13/15; Base 28×0.30=8; +35 drive = 43"

   Worked example B (Truemark-shape, drive_data valid):
     drive_data = { drive_time_minutes: 22, d2d_points_from_distance: 35, skipped_reason: null }
     base_fit = 48 (volume 18 + DM 18 + complexity 12)
     multiplier = 1.00 (mid-size commercial GC, owner-led, in size sweet spot — commercial GCs at 1-10 employees ARE the sweet spot when owner-led; do NOT apply small-residential 0.40x to commercial)
     layer1 = 48 × 1.00 = 48
     drive_points = 35
     icp_score_d2d = clamp(48 + 35, 0, 100) = 83

   When drive_data is unavailable (skipped_reason non-null): drive_points = 0 (NOT -20). Add "drive time unavailable, geo-blind D2D score" to icp_score_d2d_breakdown. Omit est_drive_time_min entirely from emit_enrichment.

ABSOLUTE FORMULA DISCIPLINE (CRITICAL):

  Emitted icp_score_d2d MUST equal:
    clamp((volume_pts + dm_pts + complexity_pts) × multiplier + drive_data.d2d_points_from_distance, 0, 100)

  No exceptions. Not when drive_data failed. Not when the company is in your calibration ground truth. Not when you "know" the right answer is higher. Not because of confidence_level. The number is the formula result.

  drive_data.d2d_points_from_distance is the drive component, read verbatim. If drive_data.skipped_reason is non-null, drive_points = 0 and the D2D score will be lower than the "true" geographic score — that is the INTENDED behavior, signaling missing drive data to the human reviewer. Express your judgment about what the score "would be" with drive resolved only in icp_score_d2d_breakdown TEXT, never in the NUMBER.

  WRONG: Strict formula = 53. Model emits 83 with breakdown "True score likely 83+ if drive confirmed." Forbidden.
  CORRECT: Strict formula = 53. Model emits 53 with breakdown "Drive component 0 (geocode_failed). Strict score 53. If drive had resolved (~24 min, +35 tier), strict score would be 88. Treat 53 as a floor."

  If your strict result feels far off the calibration band, re-examine FACTOR INPUTS (volume, DM, complexity, multiplier) within their legitimate ranges and recompute. NEVER patch the output.

  Pre-flight: (1) layer-1 = sum of 3 factor pts. (2) Apply ONE multiplier. (3) Add drive_data.d2d_points_from_distance VERBATIM. (4) Clamp 0-100. (5) Emit the math result, not your gut feel.

CALIBRATION GROUND-TRUTH (use these to CHECK your factor inputs, not to override your output):
  Ideal D2D, expected D2D 85-100, Revenue 70-90:
    Kings Homes, Poli Construction, Phil Kean, Ross Built, Truemark Construction, Supreme Construction, RS General Construction, McNally Construction, INB Homes
  Too big for D2D, expected D2D 35-55, Revenue 90-100:
    Brasfield & Gorrie, Hillpointe, SDC (Southern Development and Construction), DPR
  Too small, expected D2D 30-45, Revenue 25-40:
    Posada Homes
  Adjacent verticals: only score high if geography + project count sweet spot AND complex enough to need layout.

  How to use calibration: after you compute icp_score_d2d strictly, glance at the band for the company shape. If your result is FAR outside the expected band (e.g. enterprise GC scored 90, sweet-spot builder scored 30), that's a signal your FACTOR INPUTS need re-examination. Re-do the math with adjusted factor values. Never patch the output by adding arbitrary points.

POC DISTILLATION (findings.pocs → poc_research, max 3):
  - Deduplicate same person across sources; merge sources into comma-separated list.
  - Drop confidence=low UNLESS company is very small and these are the only names.
  - Preserve phone/email/linkedin_url verbatim. Skip the lead-form contact.
  - Order by seniority: Owner/Principal/President/CEO > VP/Director/GM/COO > ops/field.
  - name_drop_hook only when Stage 1 surfaced specific context (press, co-founder relationship, alma mater, prior employer overlap). Empty string otherwise — do not fabricate.
  - Empty array if no POC passes the gate.

BRIEF SECTIONS (by classification):
  - customer: who, company, lead_source, customer_why_fits, opening_angles[2-3], optional customer_deal_size + contact_info + header_flag
  - partner: who, partner_partnership_potential, partner_referral_angle, optional partner_considerations + company, opening_angles[2-3], contact_info
  - low_fit: who, company, lead_source, low_fit_icp_notes, low_fit_possible_angles, opening_angles[2-3], contact_info
  - failure: failure_what_we_know, failure_what_we_tried, failure_next_steps, opening_angles[2-3], optional who

OPENING_ANGLES is MANDATORY for every classification (2-3 entries). Do NOT prefix with "1." / "2." — Stage 3 numbers them. When data is thin, anchor on lead source / form responses / geography / company name and note the limitation. Section content is plain prose: no emoji headers, no "WHO HE/SHE IS:" prefixes, no section labels (Stage 3 wraps the template).

ENRICHMENT_FOUNDATION: follow the schema description, which contains the binding TIER A/B/C definitions, length bands (A 100-150 / B 60-100 / C 40-60 words), no-name-when-unverified rule, no-third-parties rule, no-specific-pitch-in-B-or-C rule, no-sub-segment-without-primary-source rule, and a worked correct-vs-incorrect example. Plain prose only.

WRITING STYLE: no em dashes (—) or en dashes (–) anywhere in any field. Use commas, periods, semicolons, parens, or restructure. Hyphens (-) are fine for compound modifiers (design-build, ground-up, mid-market).
  WRONG: "Apollo seniority tag — manager — likely undersells real authority."
  RIGHT: "Apollo seniority tag (manager) likely undersells real authority."

emit_enrichment is your only valid output. Call it exactly once.

---

${SKILL_CONTENT}`;
}

// ─── Anthropic call with retry ─────────────────────────────────────────────

async function callAnthropic({ model = MODEL, maxTokens, system, messages, tools, toolChoice, betaHeaders, timeoutMs }) {
  const body = {
    model,
    max_tokens: maxTokens,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages
  };
  if (tools) body.tools = tools;
  if (toolChoice) body.tool_choice = toolChoice;

  console.log(`[anthropic] POST body=${JSON.stringify(body).length}b model=${model} tools=${tools ? tools.length : 0} timeout=${timeoutMs / 1000}s`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    console.warn(`[anthropic] aborting fetch after ${timeoutMs / 1000}s`);
    controller.abort();
  }, timeoutMs);

  const headers = {
    'x-api-key': process.env.ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json'
  };
  if (betaHeaders) headers['anthropic-beta'] = betaHeaders;

  let res;
  try {
    res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (err) {
    clearTimeout(timeoutId);
    console.error(`[anthropic] fetch threw: ${err.name}: ${err.message}`);
    throw err;
  }
  clearTimeout(timeoutId);

  const text = await res.text();
  console.log(`[anthropic] response status=${res.status} body=${text.length}b`);
  if (!res.ok) {
    console.error(`[anthropic] error body: ${text.substring(0, 2000)}`);
    throw new Error(`Anthropic API ${res.status}: ${text.substring(0, 1000)}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    console.error(`[anthropic] JSON parse failed: ${err.message}; preview: ${text.substring(0, 500)}`);
    throw err;
  }
}

async function callAnthropicWithRetry(args, maxAttempts = 2) {
  const baseTimeout = args.timeoutMs || PER_TURN_TIMEOUT_MS;
  const timeoutSchedule = [baseTimeout, Math.min(300 * 1000, Math.round(baseTimeout * 1.7))];
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const attemptTimeout = timeoutSchedule[attempt - 1] || timeoutSchedule[timeoutSchedule.length - 1];
    try {
      return await callAnthropic({ ...args, timeoutMs: attemptTimeout });
    } catch (err) {
      lastErr = err;
      const msg = (err && err.message) || '';
      const isTransient =
        /\b(429|500|502|503|504|529)\b/.test(msg) ||
        /Connection error|overloaded/i.test(msg) ||
        /ECONNRESET|ETIMEDOUT|fetch failed|socket hang up|aborted/i.test(msg) ||
        err.name === 'AbortError';
      if (!isTransient || attempt === maxAttempts) {
        if (attempt > 1) {
          console.error(`[anthropic] giving up after ${attempt} attempts: ${msg.substring(0, 200)}`);
        }
        throw err;
      }
      const backoffMs = attempt === 1 ? 1000 : 3000;
      console.warn(`[anthropic] transient failure attempt=${attempt}/${maxAttempts} reason="${msg.substring(0, 200)}" retrying in ${backoffMs}ms`);
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  throw lastErr;
}

// ─── Failure notification (Slack-friendly universal payload) ───────────────

// Map terse stage / source / reason codes to a human-readable explanation.
// Helps Rob and anyone else reading the Slack alert understand what failed
// without having to know the codebase's internal vocabulary.
function humanizeStage(stage) {
  switch (stage) {
    case 'preflight': return 'Preflight (loading contact / idempotency check)';
    case 'research': return 'Stage 1 (Research)';
    case 'synthesis_or_classification_failure': return 'Stage 2 (Synthesis) or classification fell through to Failure brief';
    case 'writeback': return 'Stage 3 (Writeback to GHL) — uncaught exception';
    case 'writeback_partial_failure': return 'Stage 3 (Writeback to GHL) — partial failure (some writes succeeded, some failed)';
    case 'brief_not_written': return 'Stage 3 (Writeback to GHL) — Pre-Call Brief note was not created';
    case 'pipeline': return 'Pipeline (uncaught exception)';
    case 'complete': return 'Complete (writeback failures present)';
    case 'unknown': default: return stage || 'Unknown';
  }
}

function humanizeSource(source) {
  switch (source) {
    case 'thrown_error': return 'The pipeline function threw an uncaught exception.';
    case 'returned_failure': return 'The pipeline returned a structured failure result.';
    case 'missing_brief': return 'Stage 1 completed but the Pre-Call Brief note was not created.';
    default: return source || 'Unknown';
  }
}

function humanizeReason(reason) {
  if (!reason) return 'Unknown reason.';
  if (/get_contact_failed/.test(reason)) {
    return 'Could not load the contact from GHL during preflight. Most likely a transient GHL API outage or an invalid contact ID. Detail: ' + reason;
  }
  if (/aborted/i.test(reason)) {
    return 'The fetch was aborted (timeout or cancellation). Most often this is the Anthropic API call exceeding its per-turn timeout window. Detail: ' + reason;
  }
  if (/writeback_threw/.test(reason)) {
    return 'GHL writeback threw an uncaught exception. Most likely a GHL API outage or auth / payload issue. Detail: ' + reason;
  }
  if (/writeback partial/.test(reason)) {
    return 'GHL accepted some writes but rejected others. Detail: ' + reason;
  }
  if (/create_contact_note did not return a note_id/.test(reason)) {
    return 'The GHL create_contact_note call returned without a note_id. The Pre-Call Brief was not persisted. Detail: ' + reason;
  }
  if (/brief fallback also failed to write/.test(reason)) {
    return 'Both the synthesis path and the failure-brief fallback failed to write. Likely a GHL API outage. Detail: ' + reason;
  }
  return reason;
}

function buildNotificationPayload({ source, contactId, contactName, reason, stage, turns, timestamp, briefWritten, classification }) {
  const ghlLoc = process.env.GHL_LOCATION_ID;
  const contactUrl = ghlLoc
    ? `https://app.gohighlevel.com/v2/location/${ghlLoc}/contacts/detail/${contactId}`
    : null;
  // Deep-link Vercel logs to events mentioning the contact ID. The query
  // filter matches against log message text — every meaningful log line
  // includes the contact ID, so this scopes to just this run's events.
  const logsUrl = `https://vercel.com/robvaniglia-gmailcoms-projects/go-high-level-mcp/logs?query=${encodeURIComponent(contactId)}`;
  const userMention = process.env.SLACK_NOTIFY_USER_ID
    ? `<@${process.env.SLACK_NOTIFY_USER_ID}>`
    : '';

  const stageHuman = humanizeStage(stage);
  const sourceHuman = humanizeSource(source);
  const reasonHuman = humanizeReason(reason);
  const displayName = contactName && contactName.trim() ? contactName.trim() : '(name unavailable)';

  // Soft failure vs hard failure framing.
  // Soft failure: synthesis classified the lead as Failure due to thin
  //   data, but the Failure-template brief was written successfully.
  //   The pipeline did its job; the alert is informational so the user
  //   knows manual research is recommended.
  // Hard failure: real system error (exception, timeout, missing brief).
  //   This is the actionable case.
  const isSoftFailure =
    (stage === 'synthesis_or_classification_failure' && briefWritten === true)
    || (classification === 'failure' && briefWritten === true);

  const headline = isSoftFailure
    ? '*Lead enriched as Failure-template brief* (manual research recommended, no system error)'
    : '*Lead enrichment failed*';

  const lines = [
    `${userMention ? userMention + ' — ' : ''}${headline}`.trim(),
    `*Contact:* ${displayName} (\`${contactId}\`)`,
    `*Stage:* ${stageHuman}`,
    `*Source:* ${sourceHuman}`,
    `*Reason:* ${reasonHuman}`
  ];
  if (briefWritten === true) lines.push(`*Brief written:* yes (visible in the GHL contact timeline)`);
  if (turns != null) lines.push(`*Research turns:* ${turns}`);
  lines.push(`*Time:* ${timestamp}`);
  const linkParts = [];
  if (contactUrl) linkParts.push(`<${contactUrl}|View contact in GHL>`);
  linkParts.push(`<${logsUrl}|Open Vercel logs (filtered to this contact)>`);
  lines.push(linkParts.join(' | '));

  return {
    text: lines.join('\n'),
    event: isSoftFailure ? 'lead_enriched_as_failure' : 'lead_enrichment_failed',
    soft_failure: isSoftFailure,
    source,
    source_human: sourceHuman,
    stage,
    stage_human: stageHuman,
    contact_id: contactId,
    contact_name: contactName || null,
    reason,
    reason_human: reasonHuman,
    classification: classification || null,
    brief_written: briefWritten === true,
    turns,
    timestamp,
    contact_url: contactUrl,
    logs_url: logsUrl,
    deployment_url: process.env.VERCEL_URL || 'unknown'
  };
}

async function postFailureNotification(args) {
  const url = process.env.NOTIFY_WEBHOOK_URL;
  if (!url) return;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildNotificationPayload(args))
    });
    console.log(`[enrich-webhook] notification posted status=${res.status}`);
  } catch (err) {
    console.error(`[enrich-webhook] notification webhook errored: ${err.message}`);
  }
}

// Best-effort name fetch for the Slack alert when runEnrichment didn't
// surface one (e.g., a thrown exception before contact load completed).
// Wrapped in try/catch so notification failures never mask the original
// error.
async function fetchContactNameBestEffort(contactId) {
  try {
    const resp = await ghlGetContact(contactId);
    const c = (resp && resp.contact) || {};
    const full = [c.firstName, c.lastName].filter(Boolean).join(' ').trim();
    if (full) return full;
    if (c.companyName) return c.companyName;
    if (c.email) return c.email;
    return null;
  } catch (err) {
    console.warn(`[enrich-webhook] fetchContactNameBestEffort failed: ${err.message}`);
    return null;
  }
}

// ─── Stage 1: Research loop ────────────────────────────────────────────────

async function runResearchLoop(contactId, deadline) {
  const startTime = Date.now();
  console.log(`[research] start contact=${contactId}`);

  const messages = [
    {
      role: 'user',
      content: `Research GHL contact ${contactId}. Run Phases 1-5 of the lead-enrichment skill. Begin with get_contact to load the contact record (look at the businessId so you can call get_business if there is one). Then run Apollo person, Apollo org (or skip if person.organization is rich enough), Firecrawl website intelligence, and the Phase 4b multi-source fallback chain if needed. When research is complete, call emit_research_findings with the structured payload. Do not write to GHL — Stage 3 handles all writes.`
    }
  ];

  const systemPrompt = buildResearchSystemPrompt();
  let turn = 0;
  let emittedFindings = null;
  let lastAssistantText = '';

  while (turn < MAX_RESEARCH_TURNS) {
    const elapsed = Date.now() - startTime;
    if (elapsed > deadline) {
      console.warn(`[research] deadline exceeded at ${(elapsed / 1000).toFixed(1)}s, ${turn} turns`);
      return {
        ok: false,
        turns: turn,
        error: `research_deadline_exceeded after ${(elapsed / 1000).toFixed(1)}s`,
        partialAssistantText: lastAssistantText
      };
    }
    turn++;

    const response = await callAnthropicWithRetry({
      maxTokens: MAX_TOKENS_RESEARCH,
      system: systemPrompt,
      messages,
      tools: STAGE1_TOOLS,
      timeoutMs: PER_TURN_TIMEOUT_MS
    });

    const usage = response.usage || {};
    console.log(`[research] turn=${turn} stop=${response.stop_reason} ` +
                `in=${usage.input_tokens || 0} cache_read=${usage.cache_read_input_tokens || 0} ` +
                `out=${usage.output_tokens || 0}`);

    const assistantContent = response.content || [];
    const textBlocks = assistantContent.filter(b => b.type === 'text').map(b => b.text);
    if (textBlocks.length) lastAssistantText = textBlocks.join('\n').substring(0, 4000);

    if (response.stop_reason === 'tool_use') {
      const toolUses = assistantContent.filter(b => b.type === 'tool_use');
      const emitBlock = toolUses.find(b => b.name === 'emit_research_findings');

      if (emitBlock) {
        emittedFindings = emitBlock.input || {};
        console.log(`[research] emit_research_findings received (sufficient=${emittedFindings.sufficient}, intent=${emittedFindings.classification_intent}, sources=${(emittedFindings.sources_used || []).join(',')})`);
        // Acknowledge the emit so the agent terminates cleanly. We don't
        // need to actually loop again — emit means done.
        return {
          ok: true,
          turns: turn,
          findings: emittedFindings,
          elapsedSeconds: ((Date.now() - startTime) / 1000).toFixed(1)
        };
      }

      const toolResults = [];
      for (const block of toolUses) {
        const result = await executeStage1Tool(block.name, block.input);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: typeof result === 'string' ? result : JSON.stringify(result)
        });
      }
      messages.push({ role: 'assistant', content: assistantContent });
      messages.push({ role: 'user', content: toolResults });
    } else if (response.stop_reason === 'end_turn') {
      console.warn(`[research] end_turn at turn=${turn} without emit_research_findings`);
      return {
        ok: false,
        turns: turn,
        error: 'research_ended_without_emit',
        partialAssistantText: lastAssistantText,
        elapsedSeconds: ((Date.now() - startTime) / 1000).toFixed(1)
      };
    } else {
      console.warn(`[research] unexpected stop_reason: ${response.stop_reason}`);
      return {
        ok: false,
        turns: turn,
        error: `unexpected_stop_reason: ${response.stop_reason}`,
        partialAssistantText: lastAssistantText
      };
    }
  }

  console.warn(`[research] hit MAX_RESEARCH_TURNS=${MAX_RESEARCH_TURNS}`);
  return {
    ok: false,
    turns: turn,
    error: 'max_research_turns_exceeded',
    partialAssistantText: lastAssistantText
  };
}

// ─── Drive time enrichment (between Stage 1 and Stage 2) ───────────────────

// Resolve the best-known HQ address string from Stage 1 findings + business
// record, in this priority order:
//   1. findings.hq_address.full_address (the model's own best read)
//   2. apollo_organization.{street, city, state, postal_code}
//   3. business record address fields
//   4. apollo_organization.{city, state} (city-level fallback)
//   5. fallback_findings.sunbiz / google_maps free-text (last resort, just
//      pass to the geocoder — it will fail cleanly if nothing parseable)
// Returns { address, source, confidence } where confidence reflects the
// resolution path, not the geocoder's match quality.
function resolveHqAddress(findings, businessRecord) {
  const business = (businessRecord && businessRecord.business) || businessRecord || null;

  // 1. Stage 1's own choice (highest priority — the model saw everything)
  const hq = (findings && findings.hq_address) || {};
  if (hq.full_address && hq.full_address.trim()) {
    return {
      address: hq.full_address.trim(),
      source: hq.source || 'stage1_emit',
      confidence: hq.confidence || 'medium'
    };
  }

  // 2. Apollo organization full street address
  const apolloOrg = (findings && findings.apollo_organization) || {};
  if (apolloOrg.street && apolloOrg.city && apolloOrg.state) {
    const parts = [apolloOrg.street, apolloOrg.city, apolloOrg.state, apolloOrg.postal_code]
      .filter(Boolean)
      .join(', ');
    return { address: parts, source: 'apollo_org_full', confidence: 'high' };
  }

  // 3. Business record
  if (business && business.address && business.city && business.state) {
    const parts = [business.address, business.city, business.state, business.postalCode]
      .filter(Boolean)
      .join(', ');
    return { address: parts, source: 'ghl_business_full', confidence: 'high' };
  }

  // 4. Apollo org city-only fallback
  if (apolloOrg.city && apolloOrg.state) {
    return { address: `${apolloOrg.city}, ${apolloOrg.state}`, source: 'apollo_org_city', confidence: 'medium' };
  }

  // 5. Business record city-only fallback
  if (business && business.city && business.state) {
    return { address: `${business.city}, ${business.state}`, source: 'ghl_business_city', confidence: 'medium' };
  }

  // No usable geographic signal
  return { address: null, source: 'none', confidence: 'none' };
}

// Compute drive time + distance + tier points from TerraGenie HQ. Returns
// a small summary object that the synthesis stage receives via user message.
// Falls back to a structured "skipped" payload on any failure so synthesis
// can degrade gracefully (geo-blind D2D score). The skipped_reason field
// distinguishes the failure mode so the synthesis prompt can give an
// accurate breakdown text and the operator can debug.
async function computeDriveData(findings, businessRecord) {
  const resolved = resolveHqAddress(findings, businessRecord);
  const baseSkipped = {
    drive_time_minutes: null,
    distance_miles: null,
    d2d_points_from_distance: 0,
    hq_address_resolved: resolved.address,
    hq_address_source: resolved.source,
    hq_address_confidence: resolved.confidence
  };
  if (!resolved.address) {
    console.log('[drive-time] no usable HQ address from any source, skipping ORS call');
    return { ...baseSkipped, skipped_reason: 'no_address' };
  }
  try {
    // Two-step lookup so we can distinguish geocode failure from ORS failure
    const { geocodeAddress, getDriveRoute, getOriginCoords } = require('./_maps');
    const destCoords = await geocodeAddress(resolved.address);
    if (!destCoords) {
      console.log(`[drive-time] geocode failed for "${resolved.address}"`);
      return { ...baseSkipped, skipped_reason: 'geocode_failed' };
    }
    const route = await getDriveRoute(getOriginCoords(), destCoords);
    if (!route) {
      console.log(`[drive-time] ORS route failed for "${resolved.address}" (coords resolved ok)`);
      return { ...baseSkipped, skipped_reason: 'ors_route_failed' };
    }
    const points = driveTimeToD2DPoints(route.duration_minutes);
    console.log(`[drive-time] "${resolved.address}" -> ${route.duration_minutes}min, ${route.distance_miles}mi, tier=${points}`);
    return {
      drive_time_minutes: route.duration_minutes,
      distance_miles: route.distance_miles,
      d2d_points_from_distance: points,
      hq_address_resolved: resolved.address,
      hq_address_source: resolved.source,
      hq_address_confidence: resolved.confidence,
      skipped_reason: null
    };
  } catch (err) {
    console.warn(`[drive-time] threw: ${err.message}`);
    return { ...baseSkipped, skipped_reason: `error: ${err.message}` };
  }
}

// ─── Stage 2: Synthesis ────────────────────────────────────────────────────

async function synthesizeEnrichment({ findings, contactId, contactRecord, businessRecord, driveData }) {
  console.log(`[synthesis] start contact=${contactId}`);
  const startTime = Date.now();

  // Compact contact + business snapshot to give the synthesis stage just
  // enough source-of-truth state without bloating context. The skill's
  // classification rules and rubric come from SKILL_CONTENT in the system
  // prompt; this user message is just the inputs.
  const contact = (contactRecord && contactRecord.contact) || contactRecord || {};
  const business = (businessRecord && businessRecord.business) || businessRecord || null;
  const contactSnapshot = {
    id: contact.id || contactId,
    firstName: contact.firstName,
    lastName: contact.lastName,
    email: contact.email,
    phone: contact.phone,
    companyName: contact.companyName,
    businessId: contact.businessId,
    contactSource: contact.source,
    tags: contact.tags
  };
  const businessSnapshot = business
    ? {
        id: business.id,
        name: business.name,
        website: business.website,
        phone: business.phone,
        email: business.email,
        address: business.address,
        city: business.city,
        state: business.state,
        postalCode: business.postalCode,
        country: business.country,
        description: business.description
      }
    : null;

  const userMessage = [
    'Here is the structured research payload from Stage 1, plus the current GHL contact and business records, plus the deterministically-computed driving distance from TerraGenie HQ. Synthesize the complete enrichment per the skill rules and emit via emit_enrichment.',
    '',
    '<research_findings>',
    JSON.stringify(findings, null, 2),
    '</research_findings>',
    '',
    '<ghl_contact>',
    JSON.stringify(contactSnapshot, null, 2),
    '</ghl_contact>',
    businessSnapshot ? `<ghl_business>\n${JSON.stringify(businessSnapshot, null, 2)}\n</ghl_business>` : '<ghl_business>none</ghl_business>',
    '',
    '<drive_data>',
    driveData ? JSON.stringify(driveData, null, 2) : '{ "drive_time_minutes": null, "skipped_reason": "drive_data_not_computed" }',
    '</drive_data>'
  ].join('\n');

  const messages = [{ role: 'user', content: userMessage }];

  const response = await callAnthropicWithRetry({
    maxTokens: MAX_TOKENS_SYNTHESIS,
    system: buildSynthesisSystemPrompt(),
    messages,
    tools: [EMIT_ENRICHMENT_TOOL],
    toolChoice: { type: 'tool', name: 'emit_enrichment' },
    timeoutMs: SYNTHESIS_TIMEOUT_MS
  });

  const usage = response.usage || {};
  console.log(`[synthesis] stop=${response.stop_reason} in=${usage.input_tokens || 0} out=${usage.output_tokens || 0} elapsed=${((Date.now() - startTime) / 1000).toFixed(1)}s`);

  const assistantContent = response.content || [];
  const emitBlock = assistantContent.find(b => b.type === 'tool_use' && b.name === 'emit_enrichment');
  if (!emitBlock) {
    const fallbackText = assistantContent.filter(b => b.type === 'text').map(b => b.text).join('\n').substring(0, 1000);
    throw new Error(`synthesis_no_emit: stop_reason=${response.stop_reason} text="${fallbackText}"`);
  }
  return emitBlock.input || {};
}

// Build a synthetic emit_enrichment payload for the failure path when Stage 1
// could not gather enough data to even call emit_research_findings. This keeps
// Stage 3 deterministic — it always receives a well-formed enrichment object.
function buildFailureEnrichment({ findings, partialAssistantText, contactRecord, error }) {
  const contact = (contactRecord && contactRecord.contact) || {};
  const knownLines = [];
  if (contact.firstName || contact.lastName) knownLines.push(`Name: ${[contact.firstName, contact.lastName].filter(Boolean).join(' ')}`);
  if (contact.email) knownLines.push(`Email: ${contact.email}`);
  if (contact.phone) knownLines.push(`Phone: ${contact.phone}`);
  if (contact.companyName) knownLines.push(`Company: ${contact.companyName}`);
  if (contact.source) knownLines.push(`Lead source: ${contact.source}`);
  const what_we_know = knownLines.join('\n') || 'Only the contact record exists.';

  const sources = (findings && findings.sources_used) || [];
  const what_we_tried = sources.length
    ? `Attempted: ${sources.join(', ')}. ${error ? `Stage 1 outcome: ${error}.` : ''}`.trim()
    : `Stage 1 outcome: ${error || 'research did not complete'}. Sources attempted unknown.`;

  return {
    classification: 'failure',
    icp_score: 0,
    icp_score_d2d: 0,
    icp_score_d2d_breakdown: 'Not scored, insufficient data to compute D2D fit.',
    confidence_level: 'Very Low',
    icp_segment: 'Enrichment Failed',
    engagement_signal: '',
    icp_scoring_breakdown: 'Not scored, insufficient data.',
    poc_research: [],
    name_corrections: {},
    contact_fields: {
      enrichment_status: 'Enrichment Failed',
      enrichment_source: sources.length ? sources.join(' | ') : 'None'
    },
    business_fields: {},
    brief: {
      who: contact.firstName || contact.lastName ? `${[contact.firstName, contact.lastName].filter(Boolean).join(' ')} (limited data available).` : '',
      failure_what_we_know: what_we_know,
      failure_what_we_tried: what_we_tried,
      failure_next_steps: 'Manual research recommended: try Sunbiz.org, reverse phone lookup, Google Maps for business listings, LinkedIn search by name + city. The call itself is likely the best enrichment source.',
      opening_angles: [
        contact.source
          ? `Open with the lead source: "Hi ${contact.firstName || 'there'}, thanks for reaching out via ${contact.source} — I'd love to learn a bit more about what you're working on."`
          : `Open warm: "Hi ${contact.firstName || 'there'}, reaching out as a follow-up — wanted to learn a bit more about what you do and see if there's a fit."`,
        'Limited enrichment data: ask discovery questions early to learn industry, services, and geography.'
      ],
      contact_info: [
        contact.email ? `Email: ${contact.email}` : null,
        contact.phone ? `Phone: ${contact.phone}` : null
      ].filter(Boolean).join('\n')
    }
  };
}

// ─── Stage 3: Brief formatter (deterministic) ──────────────────────────────

// Strip any number of leading number-dot-space prefixes from a string.
// Example: "1. 2. text" -> "text". The synthesis stage occasionally emits
// pre-numbered opening angle entries; Stage 3 always re-numbers, so we
// normalize first to avoid "1. 1. text" output.
function stripLeadingNumbering(s) {
  if (typeof s !== 'string') return s;
  return s.replace(/^(\s*\d+[.)]\s*)+/, '').trim();
}

// Replace em dashes and en dashes with safer punctuation. Defense-in-depth
// safety net for Rob's no-em-dashes-in-briefs rule. The synthesis prompt
// also instructs the model to avoid them, but model compliance isn't 100%
// so we scrub at the formatter boundary too.
//   " — " (parenthetical) -> ", "
//   "—"   (no spaces)     -> ","
function scrubDashes(s) {
  if (typeof s !== 'string') return s;
  return s.replace(/\s+[—–]\s+/g, ', ').replace(/[—–]/g, ',');
}

// Format the POC Research section appended to the end of every customer /
// low_fit / partner brief (skipped on failure briefs). Renders the lead-form
// contact info plus the distilled decision-maker POCs from enrichment.poc_research.
function formatPocResearchSection(enrichment, { contactName }) {
  const pocs = Array.isArray(enrichment.poc_research) ? enrichment.poc_research : [];
  const lines = [
    '',
    '================',
    'POC RESEARCH',
    '================',
    '',
    'PRIMARY CONTACT (lead form):',
    `  Name:  ${contactName || 'Unknown'}`
  ];
  // The existing brief.contact_info block already carries the form contact's
  // email/phone/LinkedIn. We keep the POC section purely additive (other
  // decision-makers) to avoid duplication; reps can scroll up for the form
  // contact's channels.
  lines.push('  (Email/Phone/LinkedIn shown in CONTACT INFO above)');
  lines.push('');

  if (pocs.length === 0) {
    lines.push('OTHER DECISION-MAKER POCs:');
    lines.push('  No additional POCs surfaced by research. Try the company main line if listed on the website.');
    return lines.join('\n');
  }

  lines.push(`OTHER DECISION-MAKER POCs (${pocs.length} found, for name-dropping when calling the main line):`);
  pocs.forEach((p, idx) => {
    lines.push('');
    const title = p.title ? ` | ${p.title}` : '';
    lines.push(`  ${idx + 1}. ${p.name || '(name missing)'}${title}`);
    if (p.phone) lines.push(`     Phone:    ${p.phone}`);
    if (p.email) lines.push(`     Email:    ${p.email}`);
    if (p.linkedin_url) lines.push(`     LinkedIn: ${p.linkedin_url}`);
    const meta = [p.source ? `Source: ${p.source}` : null, p.confidence ? `Confidence: ${p.confidence}` : null].filter(Boolean).join(' | ');
    if (meta) lines.push(`     ${meta}`);
    if (p.name_drop_hook && p.name_drop_hook.trim()) lines.push(`     Hook: ${p.name_drop_hook.trim()}`);
  });

  return lines.join('\n');
}

function formatBrief(enrichment, { contactName, companyName }) {
  const today = new Date().toISOString().slice(0, 10);
  const scoreRevenue = enrichment.icp_score != null ? enrichment.icp_score : 0;
  const scoreD2D = enrichment.icp_score_d2d != null ? enrichment.icp_score_d2d : 0;
  const confidence = enrichment.confidence_level || 'Very Low';
  const segment = enrichment.icp_segment || '';
  const classification = enrichment.classification || 'failure';
  const driveTime = enrichment.est_drive_time_min;
  const brief = enrichment.brief || {};
  const angles = (brief.opening_angles || [])
    .map(stripLeadingNumbering)
    .map((line, idx) => `${idx + 1}. ${line}`)
    .join('\n');

  const headerLine1 = (header) => `${header} - ${contactName || 'Unknown Contact'} / ${companyName || 'Unknown Company'}`;

  // Compact dual-score metadata line. Drive time is only included when known
  // (positive integer). 0 means the geocoder couldn't resolve the HQ; show
  // "unknown" rather than misleading "0min from HQ".
  const driveSuffix = (driveTime != null && Number.isFinite(driveTime) && driveTime > 0)
    ? ` | Drive: ${Math.round(driveTime)}min from HQ`
    : ' | Drive: unknown';
  const scoresLine = `D2D Score: ${scoreD2D}/100 | Revenue Score: ${scoreRevenue}/100 (${confidence}) | Segment: ${segment}${driveSuffix}`;
  const d2dBreakdownBlock = enrichment.icp_score_d2d_breakdown
    ? `D2D SCORING: ${enrichment.icp_score_d2d_breakdown}`
    : null;
  const revBreakdownBlock = enrichment.icp_scoring_breakdown
    ? `REVENUE SCORING: ${enrichment.icp_scoring_breakdown}`
    : null;

  const pocSection = (classification === 'failure') ? null : formatPocResearchSection(enrichment, { contactName });

  if (classification === 'partner') {
    const text = [
      headerLine1('🤝 PARTNER BRIEF'),
      `Generated: ${today} | Partner Classification | Segment: ${segment}${driveSuffix}`,
      '',
      'WHO THEY ARE:',
      brief.who || '',
      ...(brief.company ? ['', 'THE COMPANY:', brief.company] : []),
      '',
      'PARTNERSHIP POTENTIAL:',
      brief.partner_partnership_potential || '',
      '',
      'REFERRAL/INTEGRATION ANGLE:',
      brief.partner_referral_angle || '',
      ...(brief.partner_considerations ? ['', 'CONSIDERATIONS:', brief.partner_considerations] : []),
      '',
      'OPENING ANGLES:',
      angles,
      ...(brief.contact_info ? ['', brief.contact_info] : []),
      ...(pocSection ? [pocSection] : [])
    ].filter(s => s !== undefined).join('\n').replace(/\n{3,}/g, '\n\n').trim();
    return scrubDashes(text);
  }

  if (classification === 'low_fit') {
    const text = [
      headerLine1('🔍 AI ENRICHMENT PRE-CALL BRIEF'),
      `Generated: ${today} | ${scoresLine}`,
      '',
      'ℹ️ LOW ICP MATCH - SEE NOTES',
      '',
      'WHO HE/SHE IS:',
      brief.who || '',
      '',
      'THE COMPANY:',
      brief.company || '',
      ...(brief.lead_source ? ['', `LEAD SOURCE: ${brief.lead_source}`] : []),
      '',
      'ICP NOTES:',
      brief.low_fit_icp_notes || '',
      '',
      'POSSIBLE ANGLES:',
      brief.low_fit_possible_angles || '',
      '',
      'OPENING ANGLES:',
      angles,
      ...(d2dBreakdownBlock ? ['', d2dBreakdownBlock] : []),
      ...(revBreakdownBlock ? [revBreakdownBlock] : []),
      ...(brief.contact_info ? ['', brief.contact_info] : []),
      ...(pocSection ? [pocSection] : [])
    ].filter(s => s !== undefined).join('\n').replace(/\n{3,}/g, '\n\n').trim();
    return scrubDashes(text);
  }

  if (classification === 'failure') {
    const text = [
      '⚠️ ENRICHMENT FAILED - MANUAL RESEARCH REQUIRED',
      `Generated: ${today}`,
      '',
      'WHAT WE KNOW:',
      brief.failure_what_we_know || '',
      '',
      'WHAT WE TRIED:',
      brief.failure_what_we_tried || '',
      '',
      `Scores: D2D ${scoreD2D}/100, Revenue ${scoreRevenue}/100 (${confidence}). Scores cannot be trusted due to insufficient data.`,
      '',
      'RECOMMENDED NEXT STEPS:',
      brief.failure_next_steps || '',
      '',
      'OPENING ANGLES:',
      angles,
      ...(brief.contact_info ? ['', brief.contact_info] : [])
    ].filter(s => s !== undefined).join('\n').replace(/\n{3,}/g, '\n\n').trim();
    return scrubDashes(text);
  }

  // Default: customer. TOP PRIORITY now triggers on D2D score (not revenue)
  // because Gal's near-term focus is door-knock motion. A massive revenue-
  // potential lead that's too far / too enterprise should NOT get the
  // top-priority flag for this sales cycle; it gets a high revenue score and
  // a moderate D2D score, which is the correct signal.
  let customerHeader;
  if (scoreD2D >= 90) {
    customerHeader = '⭐⭐ TOP PRIORITY D2D LEAD';
  } else if (scoreRevenue >= 90 && scoreD2D < 70) {
    customerHeader = '💎 HIGH REVENUE / LOW D2D - long sales cycle, plan accordingly';
  } else {
    customerHeader = brief.header_flag || '';
  }
  const text = [
    headerLine1('🔍 AI ENRICHMENT PRE-CALL BRIEF'),
    `Generated: ${today} | ${scoresLine}`,
    ...(enrichment.engagement_signal ? [`Signal: ${enrichment.engagement_signal}`] : []),
    ...(customerHeader ? ['', customerHeader] : []),
    '',
    'WHO HE/SHE IS:',
    brief.who || '',
    '',
    'THE COMPANY:',
    brief.company || '',
    ...(brief.lead_source ? ['', `LEAD SOURCE: ${brief.lead_source}`] : []),
    '',
    'WHY TerraGenie FITS:',
    brief.customer_why_fits || '',
    '',
    'OPENING ANGLES:',
    angles,
    ...(brief.customer_deal_size ? ['', `POTENTIAL DEAL SIZE: ${brief.customer_deal_size}`] : []),
    ...(d2dBreakdownBlock ? ['', d2dBreakdownBlock] : []),
    ...(revBreakdownBlock ? [revBreakdownBlock] : []),
    ...(brief.contact_info ? ['', brief.contact_info] : []),
    ...(pocSection ? [pocSection] : [])
  ].filter(s => s !== undefined).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return scrubDashes(text);
}

// ─── Stage 3: Writeback ────────────────────────────────────────────────────

async function writeContactFields({ contactId, enrichment, existingContactSource, existingCommunicationMemory }) {
  const today = new Date().toISOString().slice(0, 10);
  const cf = enrichment.contact_fields || {};
  const corr = enrichment.name_corrections || {};

  // Build custom field values. ICP Score (Revenue), ICP Score D2D, ICP Segment,
  // Est Drive Time, and the AI outreach foundation are all top-level
  // emit_enrichment outputs (not nested under contact_fields), so we
  // explicitly merge them here. The schema doesn't list them under
  // contact_fields to avoid redundancy, but every contact custom field
  // write must include them.
  const fieldValues = {
    ...cf,
    icp_score: enrichment.icp_score,
    icp_score_d2d: enrichment.icp_score_d2d,
    icp_segment: enrichment.icp_segment,
    enrichment_foundation: enrichment.enrichment_foundation,
    enrichment_date: today
  };

  // est_drive_time_min: only write when synthesis emitted a positive value.
  // 0 leaks through as a "missing" sentinel (the model occasionally emits 0
  // when drive_data.drive_time_minutes was null, despite schema saying to
  // omit). Treating 0 as missing prevents GHL from displaying "0 min" for
  // contacts where the geocoder couldn't resolve their HQ address.
  if (enrichment.est_drive_time_min != null
    && Number.isFinite(enrichment.est_drive_time_min)
    && enrichment.est_drive_time_min > 0) {
    fieldValues.est_drive_time_min = enrichment.est_drive_time_min;
  }

  // Communication Memory is initialized to a sentinel ONLY on first-time
  // enrichment. If existing memory already contains real conversation data
  // (anything that's not the sentinel), we preserve it across re-enrichments.
  // The /refresh-memory webhook (v2) is the only thing that should mutate
  // accumulated memory after first contact.
  const memoryIsEmpty =
    !existingCommunicationMemory ||
    !String(existingCommunicationMemory).trim() ||
    String(existingCommunicationMemory).trim() === COMMUNICATION_MEMORY_SENTINEL;
  if (memoryIsEmpty) {
    fieldValues.communication_memory = COMMUNICATION_MEMORY_SENTINEL;
  }
  // else: leave communication_memory out of the payload entirely so existing
  // accumulated memory is preserved.

  // Skip year_founded = 0. The schema is integer, so the model uses 0
  // as a "skip" sentinel when the year is unknown. Writing 0 to GHL
  // displays as "Year Founded: 0" which is misleading.
  if (fieldValues.year_founded === 0 || fieldValues.year_founded === '0') {
    delete fieldValues.year_founded;
  }

  // Preserve existing Contact Source if it has a value (skill rule).
  if (existingContactSource && fieldValues.contact_source) {
    delete fieldValues.contact_source;
  }

  // Append " | AI Synthesis" to enrichment_source if not already present.
  if (fieldValues.enrichment_source && !/AI Synthesis/i.test(fieldValues.enrichment_source)) {
    fieldValues.enrichment_source = `${fieldValues.enrichment_source} | AI Synthesis`.replace(/^\s*\|\s*/, '');
  } else if (!fieldValues.enrichment_source) {
    fieldValues.enrichment_source = 'AI Synthesis';
  }

  const customFields = buildContactCustomFieldsArray(fieldValues);

  const payload = { customFields };
  if (corr.first_name) payload.firstName = corr.first_name;
  if (corr.last_name) payload.lastName = corr.last_name;
  if (corr.company_name) payload.companyName = corr.company_name;

  return ghlUpdateContact(contactId, payload);
}

async function writeBusinessFields({ businessId, enrichment }) {
  if (!businessId) {
    console.log('[writeback] no businessId on contact — skipping update_business');
    return { skipped: true };
  }
  const bf = enrichment.business_fields || {};
  const corr = enrichment.name_corrections || {};

  const payload = {};
  // Apply name correction to the business as well.
  if (corr.company_name) payload.name = corr.company_name;
  else if (bf.name) payload.name = bf.name;

  for (const key of ['website', 'phone', 'email', 'address', 'city', 'state', 'description']) {
    if (bf[key] && String(bf[key]).trim()) payload[key] = bf[key];
  }
  if (bf.postal_code && String(bf.postal_code).trim()) payload.postalCode = bf.postal_code;
  if (bf.country && String(bf.country).trim()) payload.country = bf.country;

  if (Object.keys(payload).length === 0) {
    console.log('[writeback] no business fields to write — skipping update_business');
    return { skipped: true };
  }
  return ghlUpdateBusiness(businessId, payload);
}

async function createPreCallBriefNote({ contactId, enrichment, contactName, companyName }) {
  const briefText = formatBrief(enrichment, { contactName, companyName });
  return ghlCreateContactNote(contactId, briefText);
}

async function runWriteback({ contactId, contactRecord, enrichment }) {
  const contact = (contactRecord && contactRecord.contact) || {};
  const businessId = contact.businessId || null;
  const existingContactSource = contact.source || null;
  const existingCommunicationMemory = readContactCustomField(contactRecord, 'communication_memory');
  const corr = enrichment.name_corrections || {};
  const contactName = [
    corr.first_name || contact.firstName,
    corr.last_name || contact.lastName
  ].filter(Boolean).join(' ').trim() || contact.email || 'Unknown Contact';
  const companyName = corr.company_name || contact.companyName || 'Unknown Company';

  // Run all three writes in parallel. Each is exactly once. Failure of one
  // does not block the others — collect results and downgrade status if any
  // failed.
  const [contactResult, businessResult, noteResult] = await Promise.allSettled([
    writeContactFields({ contactId, enrichment, existingContactSource, existingCommunicationMemory }),
    writeBusinessFields({ businessId, enrichment }),
    createPreCallBriefNote({ contactId, enrichment, contactName, companyName })
  ]);

  const failures = [];
  if (contactResult.status === 'rejected') failures.push(`update_contact: ${contactResult.reason && contactResult.reason.message}`);
  if (businessResult.status === 'rejected') failures.push(`update_business: ${businessResult.reason && businessResult.reason.message}`);
  if (noteResult.status === 'rejected') failures.push(`create_contact_note: ${noteResult.reason && noteResult.reason.message}`);

  if (failures.length > 0) {
    console.error(`[writeback] ${failures.length} write(s) failed: ${failures.join(' | ')}`);
    // Best-effort: try to mark Enrichment Status as Partially Enriched so the
    // GHL UI reflects reality. Skip if the original update_contact already
    // succeeded — the existing write captured the field. If update_contact
    // failed, attempt a smaller follow-up.
    if (contactResult.status === 'rejected') {
      try {
        await ghlUpdateContact(contactId, {
          customFields: buildContactCustomFieldsArray({
            enrichment_status: 'Partially Enriched',
            enrichment_date: new Date().toISOString().slice(0, 10)
          })
        });
        console.log('[writeback] Partially Enriched marker applied via fallback update_contact');
      } catch (err) {
        console.error(`[writeback] fallback update_contact failed: ${err.message}`);
      }
    }
  }

  return {
    ok: failures.length === 0,
    contactId,
    failures,
    note_id: noteResult.status === 'fulfilled' ? (noteResult.value && noteResult.value.note && noteResult.value.note.id) : null
  };
}

// ─── Idempotency guard (function-level) ────────────────────────────────────

function isAlreadyEnrichedToday(contactRecord) {
  const today = new Date().toISOString().slice(0, 10);
  const status = readContactCustomField(contactRecord, 'enrichment_status');
  const date = readContactCustomField(contactRecord, 'enrichment_date');
  if (!status || !date) return false;
  // Enrichment Date is stored as YYYY-MM-DD. Trim any time component just in case.
  const dateStr = String(date).slice(0, 10);
  return status === 'Fully Enriched' && dateStr === today;
}

// ─── Pipeline orchestrator ─────────────────────────────────────────────────

async function runEnrichment(contactId) {
  const startTime = Date.now();
  console.log(`[enrich] start contact=${contactId}`);

  // Load contact up front for idempotency check + Stage 2 input.
  let contactRecord;
  try {
    contactRecord = await ghlGetContact(contactId);
  } catch (err) {
    return { ok: false, stage: 'preflight', contactName: null, error: `get_contact_failed: ${err.message}` };
  }

  // Capture display name early so failures downstream can surface a
  // human-readable identifier in the Slack alert.
  const contact = (contactRecord && contactRecord.contact) || {};
  const contactName =
    [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim()
    || contact.companyName
    || contact.email
    || null;

  if (isAlreadyEnrichedToday(contactRecord)) {
    console.log(`[enrich] idempotency: contact already Fully Enriched today — skipping`);
    return { ok: true, skipped: true, reason: 'already_enriched_today', contactName };
  }

  // Try to load the linked business early so Stage 2 has it.
  let businessRecord = null;
  if (contact.businessId) {
    try {
      businessRecord = await ghlGetBusiness(contact.businessId);
    } catch (err) {
      console.warn(`[enrich] get_business failed (non-fatal): ${err.message}`);
    }
  }

  // Stage 1: research loop.
  const stageDeadline = ENRICHMENT_DEADLINE_MS - (Date.now() - startTime);
  const research = await runResearchLoop(contactId, Math.max(60_000, stageDeadline - 120_000));

  // Between Stage 1 and Stage 2: compute driving distance from TerraGenie
  // HQ to the company's resolved HQ address. Deterministic and cheap; failure
  // here falls back to a null drive_data which synthesis handles by giving
  // a geo-blind D2D score (0 distance points).
  let driveData = null;
  if (research.ok) {
    try {
      driveData = await computeDriveData(research.findings, businessRecord);
    } catch (err) {
      console.warn(`[enrich] driveData compute threw: ${err.message}`);
      driveData = null;
    }
  }

  // Stage 2: synthesis (or failure-payload fallback).
  let enrichment;
  if (research.ok) {
    try {
      enrichment = await synthesizeEnrichment({
        findings: research.findings,
        contactId,
        contactRecord,
        businessRecord,
        driveData
      });
    } catch (err) {
      console.error(`[enrich] synthesis failed: ${err.message}`);
      enrichment = buildFailureEnrichment({
        findings: research.findings,
        partialAssistantText: research.findings && research.findings.research_summary,
        contactRecord,
        error: `synthesis_failed: ${err.message}`
      });
    }
  } else {
    console.warn(`[enrich] research failed: ${research.error} — falling through to failure-brief writeback`);
    enrichment = buildFailureEnrichment({
      findings: null,
      partialAssistantText: research.partialAssistantText,
      contactRecord,
      error: research.error
    });
  }

  // Stage 3: writeback (deterministic, runs even on the failure path).
  let writeback;
  try {
    writeback = await runWriteback({ contactId, contactRecord, enrichment });
  } catch (err) {
    console.error(`[enrich] writeback threw: ${err.message}`);
    return {
      ok: false,
      stage: 'writeback',
      contactName,
      error: `writeback_threw: ${err.message}`,
      research_turns: research.turns,
      classification: enrichment && enrichment.classification
    };
  }

  const elapsedSeconds = ((Date.now() - startTime) / 1000).toFixed(1);

  // Outcome classification policy:
  //   The pipeline succeeded if it delivered a Pre-Call Brief to GHL with
  //   no writeback errors. Classification (customer / partner / low_fit /
  //   failure) is just metadata — a Failure-template brief is still a
  //   valid delivery; it gives the sales rep WHAT WE TRIED + manual
  //   research next steps. The user's policy: only alert when the system
  //   fails to deliver, not when the data was just thin.
  //
  //   This means:
  //     - research.ok=false but brief landed via fallback path -> ok:true
  //     - synthesis classified as failure but brief landed       -> ok:true
  //     - any case where note_id is null or writeback had errors -> ok:false
  const briefDelivered = writeback.note_id != null && (writeback.failures || []).length === 0;

  if (briefDelivered) {
    return {
      ok: true,
      stage: 'complete',
      contactName,
      research_turns: research.turns,
      research_ok: research.ok,
      research_error: research.ok ? null : research.error,
      classification: enrichment.classification,
      icp_score: enrichment.icp_score,
      icp_segment: enrichment.icp_segment,
      confidence_level: enrichment.confidence_level,
      note_id: writeback.note_id,
      writeback_failures: [],
      elapsedSeconds
    };
  }

  // Brief did NOT land (or writeback had failures). This is a real system
  // problem the user needs to know about.
  return {
    ok: false,
    stage: writeback.note_id == null ? 'brief_not_written' : 'writeback_partial_failure',
    contactName,
    error: writeback.note_id == null
      ? (research.ok ? 'create_contact_note did not return a note_id' : `${research.error}; brief fallback also failed to write`)
      : `writeback partial: ${(writeback.failures || []).join(' | ')}`,
    research_turns: research.turns,
    research_ok: research.ok,
    research_error: research.ok ? null : research.error,
    writeback_failures: writeback.failures || [],
    brief_written: writeback.note_id != null,
    classification: enrichment.classification,
    elapsedSeconds
  };
}

// ─── Main webhook handler ──────────────────────────────────────────────────

const handler = async (req, res) => {
  const SECRET = process.env.WEBHOOK_SECRET;
  if (!SECRET || SECRET.length < 16) {
    res.status(500).json({ error: 'Server configuration error' });
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  if (!req.headers || req.headers.authorization !== `Bearer ${SECRET}`) {
    console.log('[enrich-webhook] Rejected: bad or missing Authorization header');
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const required = ['ANTHROPIC_API_KEY', 'APOLLO_API_KEY', 'FIRECRAWL_API_KEY', 'GHL_API_KEY'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.error('[enrich-webhook] Missing env vars:', missing);
    res.status(500).json({ error: 'Server misconfigured', missing });
    return;
  }

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
    res.status(400).json({ error: 'Invalid JSON' });
    return;
  }

  const contactId =
    payload.contact_id || payload.contactId || payload.id ||
    (payload.contact && (payload.contact.id || payload.contact.contact_id));

  if (!contactId) {
    console.error('[enrich-webhook] No contact ID in payload:', JSON.stringify(payload).substring(0, 500));
    res.status(400).json({ error: 'No contact ID found in payload' });
    return;
  }

  console.log(`[enrich-webhook] Webhook received for contact ${contactId}`);

  res.status(200).json({
    ok: true,
    contactId,
    status: 'enrichment_started',
    received_at: new Date().toISOString()
  });

  waitUntil(
    runEnrichment(contactId)
      .then(async (result) => {
        if (result && result.ok) {
          console.log(`[enrich-webhook] Background enrichment complete: ${JSON.stringify(result).substring(0, 800)}`);
          return;
        }
        const reason = (result && result.error) || 'unknown';
        const stage = (result && result.stage) || 'unknown';
        const contactName = (result && result.contactName) || await fetchContactNameBestEffort(contactId);
        const briefWritten = !!(result && result.brief_written);
        const classification = result && result.classification;
        console.error(`[ENRICHMENT_FAILURE] contact=${contactId} name="${contactName || ''}" stage=${stage} reason=${reason} briefWritten=${briefWritten}`);
        await postFailureNotification({
          source: 'returned_failure',
          contactId,
          contactName,
          reason,
          stage,
          turns: result && result.research_turns,
          timestamp: new Date().toISOString(),
          briefWritten,
          classification
        });
      })
      .catch(async (err) => {
        const msg = (err && err.message) || 'unknown error';
        const contactName = await fetchContactNameBestEffort(contactId);
        console.error(`[ENRICHMENT_FAILURE] contact=${contactId} name="${contactName || ''}" threw: ${msg}`);
        if (err && err.stack) console.error(err.stack);
        await postFailureNotification({
          source: 'thrown_error',
          contactId,
          contactName,
          reason: msg.substring(0, 500),
          stage: 'pipeline',
          turns: null,
          timestamp: new Date().toISOString()
        });
      })
  );
};

module.exports = handler;
