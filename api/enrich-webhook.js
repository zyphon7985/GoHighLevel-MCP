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
  enrichment_source: 'pu7XXEeb8y0195Dj2V4S'
};

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
        }
      },
      required: ['sufficient', 'classification_intent', 'contact_summary', 'sources_used', 'research_summary']
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
      icp_score: { type: 'integer', minimum: 0, maximum: 100 },
      confidence_level: { type: 'string', enum: ['High', 'Medium', 'Low', 'Very Low'] },
      icp_segment: {
        type: 'string',
        description: 'Per Phase 6 Step 4. Use the dash form exactly as defined in the skill (e.g. "Primary - Civil/Construction", "Partner - Technology Vendor", "Low Fit - Property Management").'
      },
      engagement_signal: { type: 'string', description: 'One-liner per Phase 6 Step 5.' },
      icp_scoring_breakdown: {
        type: 'string',
        description: 'Factor-by-factor breakdown text. Example: "Industry 35/35 (Construction); Geography 22/25 (FL projects); Decision Maker 15/15 (CEO); Company Size 12/15 (Small 11-50); Revenue 0/5 (Unknown); Digital Presence 5/5 (Full website)". Used by Stage 3 in the brief.'
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
    required: ['classification', 'icp_score', 'confidence_level', 'icp_segment', 'contact_fields', 'brief']
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

If you exhaust all sources and still cannot score 3 factors, set sufficient=false in the emit_research_findings payload and emit anyway. Stage 3 will produce a Failure brief.

After emit_research_findings returns successfully, end your turn. Do not call any other tools.

---

${SKILL_CONTENT}`;
}

function buildSynthesisSystemPrompt() {
  return `You are running Stage 2 (Synthesis) of an automated lead-enrichment pipeline. Your input is a structured research payload from Stage 1. Your output is exactly ONE call to emit_enrichment with a complete structured enrichment object. You do NOT write to GHL — Stage 3 (function code) handles all writeback deterministically based on what you emit.

Steps to perform, in order:
1. Classify the lead per Phase 6 Step 1: customer, partner, low_fit, or failure. Use Stage 1's classification_intent as a starting point but refine if the data warrants it.
2. Compute the ICP score (0-100) and confidence level using the rubric in Phase 6 Steps 2 and 3. Apply the gatekeeper modifier and the geography "project footprint, not HQ" rule.
3. Determine the ICP segment per Phase 6 Step 4 (e.g., "Primary - Civil/Construction", "Partner - Technology Vendor", "Low Fit - Property Management").
4. Populate icp_scoring_breakdown with a one-line per-factor breakdown for the brief.
5. Compute the 16 contact custom field values per the field mappings in Phase 6. Leave a field as empty string ("") if you cannot determine its value — Stage 3 will skip empties so existing GHL data is preserved. enrichment_date is set automatically by Stage 3; do not include it.
6. Compute business standard field values from discovered website / address / phone / description. Only include fields you confidently want to write. Stage 3 skips empties.
7. If the research provided name_correction_candidates with medium-or-high confidence, populate name_corrections. Always apply Title Case fixes for all-lower or ALL-CAPS names.
8. Generate the pre-call brief sections matching the classification:
   - customer: who, company, lead_source, customer_why_fits, opening_angles[2-3], optional customer_deal_size, contact_info, optional header_flag
   - partner: who, partner_partnership_potential, partner_referral_angle, optional partner_considerations, opening_angles[2-3], contact_info, optionally company
   - low_fit: who, company, lead_source, low_fit_icp_notes, low_fit_possible_angles, opening_angles[2-3], contact_info
   - failure: failure_what_we_know, failure_what_we_tried, failure_next_steps, opening_angles[2-3], who is optional

OPENING_ANGLES is MANDATORY for every classification, never empty. Provide 2-3 ready-to-use opening lines as separate array entries. DO NOT prefix entries with "1.", "2.", "3.", or any leading numbering, Stage 3 numbers them automatically when assembling the brief. Each array entry should start directly with the opener text or the leading quote. When data is thin (low confidence, sparse research), anchor openers on lead source, form responses, geography, or company name and explicitly note the limitation inside the array text.

Section content is plain prose. Do not include emoji headers, "WHO HE/SHE IS:" prefixes, or section labels. Stage 3 wraps content with the appropriate template scaffolding based on classification.

WRITING STYLE, ABSOLUTE RULE: do not use em dashes (—) or en dashes (–) anywhere in any field of emit_enrichment. This includes brief sections (who, company, why_fits, opening_angles, etc.), icp_segment, icp_scoring_breakdown, engagement_signal, contact_info, name_corrections, and every other string. Use commas, periods, semicolons, parentheses, or restructure the sentence. Hyphens (-) are fine for compound modifiers like "design-build", "ground-up", or "mid-market". Examples of the rewrite:
- WRONG: "He runs the field, not just the office — every quote goes through him."
- RIGHT: "He runs the field, not just the office. Every quote goes through him."
- WRONG: "Apollo seniority tag — manager — likely undersells real authority."
- RIGHT: "Apollo seniority tag (manager) likely undersells real authority."
- WRONG: "Segment: Primary — Civil/Construction"
- RIGHT: "Segment: Primary - Civil/Construction"

Do not call any other tools. emit_enrichment is your only valid output. Call it exactly once.

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

function buildNotificationPayload({ source, contactId, reason, stage, turns, timestamp }) {
  const ghlLoc = process.env.GHL_LOCATION_ID;
  const contactUrl = ghlLoc
    ? `https://app.gohighlevel.com/v2/location/${ghlLoc}/contacts/detail/${contactId}`
    : null;
  const logsUrl = 'https://vercel.com/robvaniglia-gmailcoms-projects/go-high-level-mcp/logs';

  const lines = [
    '*Lead enrichment failed*',
    `*Contact:* \`${contactId}\``,
    `*Stage:* ${stage}`,
    `*Reason:* ${reason}`,
    `*Source:* ${source}`
  ];
  if (turns != null) lines.push(`*Research turns:* ${turns}`);
  lines.push(`*Time:* ${timestamp}`);
  const linkParts = [];
  if (contactUrl) linkParts.push(`<${contactUrl}|View contact in GHL>`);
  linkParts.push(`<${logsUrl}|Open Vercel logs>`);
  lines.push(linkParts.join(' | '));

  return {
    text: lines.join('\n'),
    event: 'lead_enrichment_failed',
    source,
    stage,
    contact_id: contactId,
    reason,
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

// ─── Stage 2: Synthesis ────────────────────────────────────────────────────

async function synthesizeEnrichment({ findings, contactId, contactRecord, businessRecord }) {
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
    'Here is the structured research payload from Stage 1, plus the current GHL contact and business records. Synthesize the complete enrichment per the skill rules and emit via emit_enrichment.',
    '',
    '<research_findings>',
    JSON.stringify(findings, null, 2),
    '</research_findings>',
    '',
    '<ghl_contact>',
    JSON.stringify(contactSnapshot, null, 2),
    '</ghl_contact>',
    businessSnapshot ? `<ghl_business>\n${JSON.stringify(businessSnapshot, null, 2)}\n</ghl_business>` : '<ghl_business>none</ghl_business>'
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
    confidence_level: 'Very Low',
    icp_segment: 'Enrichment Failed',
    engagement_signal: '',
    icp_scoring_breakdown: 'Not scored — insufficient data.',
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

function formatBrief(enrichment, { contactName, companyName }) {
  const today = new Date().toISOString().slice(0, 10);
  const score = enrichment.icp_score != null ? enrichment.icp_score : 0;
  const confidence = enrichment.confidence_level || 'Very Low';
  const segment = enrichment.icp_segment || '';
  const classification = enrichment.classification || 'failure';
  const brief = enrichment.brief || {};
  const angles = (brief.opening_angles || [])
    .map(stripLeadingNumbering)
    .map((line, idx) => `${idx + 1}. ${line}`)
    .join('\n');

  const headerLine1 = (header) => `${header} - ${contactName || 'Unknown Contact'} / ${companyName || 'Unknown Company'}`;

  if (classification === 'partner') {
    const text = [
      headerLine1('🤝 PARTNER BRIEF'),
      `Generated: ${today} | ICP Score: ${score}/100 (Partner Classification) | Segment: ${segment}`,
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
      ...(brief.contact_info ? ['', brief.contact_info] : [])
    ].filter(s => s !== undefined).join('\n').replace(/\n{3,}/g, '\n\n').trim();
    return scrubDashes(text);
  }

  if (classification === 'low_fit') {
    const text = [
      headerLine1('🔍 AI ENRICHMENT PRE-CALL BRIEF'),
      `Generated: ${today} | ICP Score: ${score}/100 (${confidence} Confidence) | Segment: ${segment}`,
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
      ...(enrichment.icp_scoring_breakdown ? ['', `ICP SCORING BREAKDOWN: ${enrichment.icp_scoring_breakdown}`] : []),
      ...(brief.contact_info ? ['', brief.contact_info] : [])
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
      `ICP SCORE: ${score}/100 (${confidence} Confidence) - score cannot be trusted due to insufficient data`,
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

  // Default: customer
  const customerHeader = score >= 90
    ? '⭐⭐ TOP PRIORITY LEAD'
    : (brief.header_flag || '');
  const text = [
    headerLine1('🔍 AI ENRICHMENT PRE-CALL BRIEF'),
    `Generated: ${today} | ICP Score: ${score}/100 (${confidence} Confidence) | Segment: ${segment}`,
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
    ...(enrichment.icp_scoring_breakdown ? ['', `ICP SCORING BREAKDOWN: ${enrichment.icp_scoring_breakdown}`] : []),
    ...(brief.contact_info ? ['', brief.contact_info] : [])
  ].filter(s => s !== undefined).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return scrubDashes(text);
}

// ─── Stage 3: Writeback ────────────────────────────────────────────────────

async function writeContactFields({ contactId, enrichment, existingContactSource }) {
  const today = new Date().toISOString().slice(0, 10);
  const cf = enrichment.contact_fields || {};
  const corr = enrichment.name_corrections || {};

  // Build custom field values, with stage-injected fields appended.
  const fieldValues = { ...cf, enrichment_date: today };

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
    writeContactFields({ contactId, enrichment, existingContactSource }),
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
    return { ok: false, stage: 'preflight', error: `get_contact_failed: ${err.message}` };
  }

  if (isAlreadyEnrichedToday(contactRecord)) {
    console.log(`[enrich] idempotency: contact already Fully Enriched today — skipping`);
    return { ok: true, skipped: true, reason: 'already_enriched_today' };
  }

  // Try to load the linked business early so Stage 2 has it.
  const contact = (contactRecord && contactRecord.contact) || {};
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

  // Stage 2: synthesis (or failure-payload fallback).
  let enrichment;
  if (research.ok) {
    try {
      enrichment = await synthesizeEnrichment({
        findings: research.findings,
        contactId,
        contactRecord,
        businessRecord
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
      error: `writeback_threw: ${err.message}`,
      research_turns: research.turns,
      classification: enrichment && enrichment.classification
    };
  }

  const elapsedSeconds = ((Date.now() - startTime) / 1000).toFixed(1);

  if (!research.ok || enrichment.classification === 'failure') {
    return {
      ok: false,
      stage: research.ok ? 'synthesis_or_classification_failure' : 'research',
      error: research.ok ? `synthesis_classified_as_failure` : research.error,
      research_turns: research.turns,
      writeback_failures: writeback.failures || [],
      brief_written: writeback.note_id != null,
      classification: enrichment.classification,
      elapsedSeconds
    };
  }

  return {
    ok: writeback.ok,
    stage: 'complete',
    research_turns: research.turns,
    classification: enrichment.classification,
    icp_score: enrichment.icp_score,
    icp_segment: enrichment.icp_segment,
    confidence_level: enrichment.confidence_level,
    note_id: writeback.note_id,
    writeback_failures: writeback.failures || [],
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
        console.error(`[ENRICHMENT_FAILURE] contact=${contactId} stage=${stage} reason=${reason}`);
        await postFailureNotification({
          source: 'returned_failure',
          contactId,
          reason,
          stage,
          turns: result && result.research_turns,
          timestamp: new Date().toISOString()
        });
      })
      .catch(async (err) => {
        const msg = (err && err.message) || 'unknown error';
        console.error(`[ENRICHMENT_FAILURE] contact=${contactId} threw: ${msg}`);
        if (err && err.stack) console.error(err.stack);
        await postFailureNotification({
          source: 'thrown_error',
          contactId,
          reason: msg.substring(0, 500),
          stage: 'pipeline',
          turns: null,
          timestamp: new Date().toISOString()
        });
      })
  );
};

module.exports = handler;
