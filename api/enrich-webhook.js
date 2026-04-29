// Lead Enrichment Webhook — Phase 2 (full enrichment via Anthropic API)
// Receives "new lead" webhook from GHL → kicks off Claude agent loop:
//   - Reads contact + business from GHL via MCP server
//   - Calls Apollo for person + company enrichment
//   - Calls Firecrawl for website scraping
//   - Synthesizes ICP score + pre-call brief
//   - Writes enrichment back to GHL contact
// Returns 200 to GHL within ~1s; runs enrichment async (up to maxDuration on the plan).

// ─── Config ────────────────────────────────────────────────────────────────
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_BETA = 'mcp-client-2025-11-20';
const MODEL = 'claude-sonnet-4-6';  // Switch to 'claude-opus-4-7' for max quality at ~5x cost
const MAX_TOKENS_PER_TURN = 4096;
const MAX_TURNS = 30;  // Safety cap on agent loop iterations

// The lead-enrichment skill content, JSON-escaped at build time so it can be
// embedded as a JS string literal. The agent's system prompt wraps this with
// a small preamble explaining tool names in this environment.
const SKILL_CONTENT = "---\nname: lead-enrichment\ndescription: >\n  Enrich GHL contacts with company intel, ICP scoring, and pre-call briefs using Apollo, Firecrawl, and AI synthesis.\n  Use this skill whenever the user says \"enrich\", \"enrich this contact\", \"enrich [name]\", \"run enrichment\",\n  \"look up this lead\", \"score this lead\", \"ICP score\", \"pre-call brief\", \"research this company for sales\",\n  \"what do we know about [company]\", \"fill in the data on [contact]\", \"enrich all contacts tagged [X]\",\n  \"batch enrich\", or any variation of wanting a GHL contact's data filled in with company intelligence\n  and sales readiness scoring. Also trigger when the user pastes a contact name or company name and\n  wants to know if they're a good fit. This skill is for TerraGenie's GHL CRM — it writes enrichment\n  data directly to contact custom fields and business records.\n---\n\n# Lead Enrichment Pipeline v2.2\n\nEnrich GHL contacts with company intelligence, ICP scoring, and AI-generated pre-call briefs. This skill orchestrates a waterfall across Apollo (person + company data), Firecrawl (website intelligence), multi-source fallbacks (Sunbiz, Google Maps, LinkedIn), and optionally Fullenrich (email/phone verification), then synthesizes everything into an ICP score with confidence modifiers and writes it all back to GHL.\n\n**v2.2 changes (from TerraGenie sales team feedback):**\n- Landscaping/hardscaping/grading reclassified as Primary ICP (35/35 Industry) — they do layout, grade checking, and excavation daily and are core TerraGenie customers\n- Expanded ICP to include any company that regularly puts equipment in the ground: irrigation, paving, fencing, solar ground-mount, septic/drain, demolition\n- Pool builders upgraded from Adjacent to Primary (30/35) — heavy excavation + utility detection needs\n- Conversation starters (OPENING ANGLES) now MANDATORY on every pre-call brief regardless of data quality — sales team reports these are the single most valuable part of the enrichment\n- When enrichment data is thin, conversation starters anchor on lead source, form responses, and industry context with explicit note about data limitations\n- Softened Non-ICP language — removed directives like \"do not pursue\" and \"remove from pipeline.\" Briefs present facts and let the sales team decide\n- Non-ICP brief template rewritten: factual tone, no negative directives, always includes opening angles\n\n**v2.1 changes (from Batch 1-3 learnings, 30 contacts enriched):**\n- Non-ICP classification path for contacts outside TerraGenie's market (property managers, RE brokers, etc.)\n- Real estate taxonomy: RE developers (Adjacent, builds things) vs RE brokers/property managers (Non-ICP)\n- Apollo org credit optimization: check `person.organization` before spending a separate org credit\n- Geographic scoring revised: project footprint matters, not office/HQ location. Central FL = top score\n- Revenue scoring fixed: proportional tiers, no penalty for large companies (they're whales)\n- Enrichment Status criteria formalized with specific conditions\n- Company name AND contact name auto-correction during writeback (typos + capitalization)\n- Pre-call brief template updated to match production narrative style\n\n**v2.0 changes:** Domain discovery intercept for personal emails, Firecrawl raw-markdown self-synthesis (no more hallucinated jq filters), multi-source fallback chain when Apollo org returns empty, confidence modifiers on ICP scores, partner/adjacent classification gate for non-ICP contacts.\n\n## When to Use This Skill\n\n- Single contact: \"Enrich Jonathan Bell\" or \"Enrich contact ID xyz\"\n- Batch: \"Enrich all contacts tagged d2d\" or \"Enrich contacts in the prospecting stage\"\n- Research: \"What do we know about INB Homes?\" or \"Is this contact a good fit?\"\n- Re-enrichment: \"Re-enrich [name]\" (overrides the 30-day freshness check)\n\n## Connector Rules\n\nThis skill operates in the **Consulting** context. Use only:\n- **GHL MCP** (prefix `mcp__baacf2a8`) — contact/business reads and writes\n- **Apollo MCP** (prefix `mcp__1dd65755`) — person and company enrichment\n- **Firecrawl MCP** (via Zapier, prefix `mcp__5e8c1470`) — website scraping and search\n- **Fullenrich** (via GHL MCP tools) — email/phone verification (optional, credit-gated)\n\nDo NOT use Zapier MCP Google Workspace tools, Figma, or GitHub — those are Aurora connectors.\n\n---\n\n## Pipeline Phases\n\n### Phase 1 — Input & Identification\n\n1. Accept a contact name, contact ID, or search query\n2. Search or fetch the contact via `search_contacts` or `get_contact`\n3. Pull the linked business record via `get_business` if `businessId` exists\n4. Read existing custom field values to check what's already populated\n5. **Freshness gate:** If `Enrichment Status` = \"Fully Enriched\" AND `Enrichment Date` < 30 days old, ask the user before proceeding: \"This contact was enriched on [date]. Re-enrich anyway?\"\n6. Extract the company domain from the email address (everything after @) or from the business website field\n\n**Output:** A working record with all known data points and identified gaps.\n\n### Phase 1.5 — Domain Discovery (Pre-Apollo Intercept)\n\nBefore spending Apollo credits, check whether the contact's email domain is usable for company enrichment. Many leads — especially from door-to-door (d2d) campaigns — use personal email providers, which means the email domain tells us nothing about the company.\n\n**Personal email providers to intercept:** gmail.com, yahoo.com, hotmail.com, outlook.com, aol.com, icloud.com, me.com, mac.com, live.com, msn.com, comcast.net, att.net, verizon.net, sbcglobal.net, bellsouth.net, cox.net, charter.net, earthlink.net, protonmail.com, zoho.com, mail.com, ymail.com\n\n**If the email domain is personal (or no email exists):**\n\n1. Check the GHL business record's `website` field — if populated, extract the domain and use it\n2. If no business website, check if Apollo person match (Phase 2) returns an `organization.website_url` — use that\n3. If still no domain after Phase 2, run `firecrawl_search_data` with query: `\"[Company Name] [City, State] site\"` to discover the website\n4. If Firecrawl search finds a plausible match, verify it by checking whether the company name appears on the page (scrape and confirm)\n5. Once a domain is discovered, store it for use in Phase 3 (Apollo org) and Phase 4 (Firecrawl scrape)\n\n**If the email domain is NOT personal:** Use it directly as the company domain. Proceed normally.\n\nThis intercept prevents wasting an Apollo org credit on `gmail.com` and ensures smaller companies without corporate email still get full enrichment. The key insight: discovering the domain early unlocks the entire downstream pipeline.\n\n### Phase 2 — Apollo Person Enrichment\n\n**Tool:** `apollo_people_match`\n\n**Minimum data required:** First name + last name + (email OR domain). If last name is missing, skip this phase entirely — Apollo cannot match on first name alone.\n\n**Input parameters:** `first_name`, `last_name`, `email`, `domain`, `organization_name`\n\n**Data captured:**\n- Job title → **Company Position** field\n- LinkedIn URL → **LinkedIn URL** field\n- Seniority level → feeds **Decision Maker** logic in Phase 6\n- Company domain (if we didn't have it — critical for Phase 3)\n\n**Cost:** 1 Apollo credit per person\n\n**If no match:** Note the gap and continue. Firecrawl becomes more important.\n\n### Phase 3 — Apollo Company Enrichment\n\n**Tool:** `apollo_organizations_enrich`\n\n**Minimum data required:** Company domain. If no domain is available (not from email, not from business record, not discovered in Phase 1.5 or Phase 2), skip this phase.\n\n**⚡ Credit optimization — check Phase 2 data first:** Before calling `apollo_organizations_enrich`, check whether Phase 2's person match returned a populated `person.organization` object. If `person.organization` contains meaningful data (industry, estimated_num_employees, short_description, and/or annual_revenue), **use that data and skip the separate org enrichment call** to save 1 Apollo credit. The person match often embeds rich org data — especially when the org itself is too small/new to return data from the standalone endpoint. Only call `apollo_organizations_enrich` separately when:\n- Phase 2's `person.organization` is null or empty\n- Phase 2's `person.organization` exists but is missing key fields you need (industry, employee count, description)\n- You want to double-check or supplement thin person-embedded org data\n\n**Input:** `domain`\n\n**Data captured:**\n- Industry → **Industry** field\n- Employee count → maps to **Company Size Tier** in Phase 6\n- Annual revenue → maps to **Revenue Tier** in Phase 6\n- Founded year → **Year Founded** field\n- HQ address (street, city, state, zip) → Business standard fields\n- Phone → Business phone field\n- Description → Business description field\n- Website URL → Business website field AND **Company Website** contact custom field\n\n**Cost:** 1 Apollo credit per organization (skip if person.organization is sufficient — see above)\n\n**Empty result handling:** If Apollo returns an empty object `{}` or a result with no meaningful data (no industry, no employees, no revenue), this is common for smaller/newer companies. Do NOT treat this as final — proceed to Phase 4 and Phase 4b for alternative data sources. Flag the contact for multi-source fallback.\n\n**Batch optimization:** If multiple contacts share the same company domain, enrich the org only once and reuse the data. Use `apollo_organizations_bulk_enrich` for up to 10 domains at once in batch mode.\n\n### Phase 4 — Firecrawl Website Intelligence (Self-Synthesis)\n\nThis phase captures TerraGenie-specific intelligence that Apollo doesn't provide — what services the company offers, where they operate, and signals that indicate product fit.\n\n**Critical rule: YOU are the synthesizer.** Firecrawl returns raw page content. You read it and extract the intelligence yourself. Never rely on Firecrawl's auto-generated extraction filters or jq transforms — they hallucinate generic content that looks plausible but is fabricated. Bad data is worse than no data. The sales team makes calls based on what we write here.\n\n**Primary tool:** `firecrawl_scrape_page` with `onlyMainContent: true` and `formats: [\"markdown\"]`\n\n**Process:**\n1. Scrape the company homepage as raw markdown\n2. Read the returned markdown yourself and extract:\n   - Services offered (construction types, specialties, project types)\n   - Geographic service areas (cities, counties, regions, states)\n   - Company description / mission / about content\n   - Team size, certifications, years in business, notable projects\n   - Equipment or technology mentions (GPS, drones, 3D scanners, laser scanning — signals TerraGenie fit)\n   - Whether the company is a **direct customer prospect** vs. a **technology vendor/supplier/partner**\n3. If the homepage is thin on detail, also scrape `/about`, `/services`, or `/our-work` if those paths exist (check the markdown for nav links)\n\n**Hallucination check:** After extracting data from Firecrawl, sanity-check the results:\n- Does the extracted industry/services actually match the company name and domain?\n- If you're processing a batch, compare the extracted text against previous contacts — if two different companies produce identical service descriptions, the data is hallucinated. Discard it and note \"Firecrawl extraction unreliable\" in the enrichment source.\n- If the scrape returns very generic content (e.g., \"Commercial construction, office/medical building renovation, remodeling\" with no company-specific details), treat it as low-confidence and flag it.\n\n**Fallback chain:**\n1. If scrape times out (>30s), try `firecrawl_search_data` with the company name + location\n2. If no domain exists, go straight to `firecrawl_search_data` to try to find the company website\n3. If Firecrawl search also fails, proceed to Phase 4b (multi-source fallback)\n\n**Data captured:**\n- Services analysis → feeds **ICP Segment** logic in Phase 6\n- Geographic areas → **Service Area** field\n- Additional company details → supplements Business description\n- Discovered company URL → **Company Website** contact field + Business website field (if not already populated from Apollo)\n\n### Phase 4b — Multi-Source Fallback Chain (When Apollo Org Returns Empty)\n\nWhen Apollo org enrichment returns empty or Firecrawl scrape yields insufficient data, don't stop — there are free/low-cost sources that can fill the gaps. The goal is to gather enough data for a confident ICP score. Use these sources in order until you have what you need:\n\n**Source 1: Firecrawl Search (Google Index)**\n- Already attempted in Phase 4 fallback, but try broader queries if the first attempt was narrow\n- Query patterns: `\"[Company Name] construction Florida\"`, `\"[Company Name] contractor [City]\"`\n- Good for: finding the company website, basic description, service area\n\n**Source 2: Sunbiz.org (Florida Division of Corporations)**\n- Use `firecrawl_scrape_page` on `https://search.sunbiz.org/` or `firecrawl_search_data` with `\"[Company Name] site:sunbiz.org\"`\n- Good for: confirming the company exists, registered agent, filing date (proxy for year founded), registered address (proxy for geography), officer names (confirms decision-maker status)\n- Free, no credits required\n- Especially valuable for Florida-based companies that are too small for Apollo\n\n**Source 3: Google Maps / Google My Business**\n- Use `firecrawl_search_data` with `\"[Company Name] [City] site:google.com/maps\"` or search for the company name + \"reviews\"\n- Good for: confirming address/geography, business category (construction, landscaping, etc.), review count (proxy for company activity level), phone number, website URL\n- Free, no credits required\n\n**Source 4: LinkedIn Company Page**\n- Use `firecrawl_search_data` with `\"[Company Name] site:linkedin.com/company\"`\n- Good for: employee count, industry classification, company description, headquarters location\n- Free, no credits required\n- Note: LinkedIn scraping may return limited data; use what's available\n\n**When to stop the fallback chain:** You have enough data when you can confidently score at least 3 of the 6 ICP factors (Industry, Geography, Decision Maker, Company Size, Revenue, Digital Presence). If after all sources you still can't score 3 factors, mark the contact as \"Enrichment Failed\" and move on.\n\n**Source tracking:** Add each source that returned usable data to the Enrichment Source field. Example: `\"Apollo | Firecrawl | Sunbiz | AI Synthesis\"`\n\n### Phase 5 — Fullenrich Email/Phone Verification (Optional)\n\n**Default: OFF.** Only runs when explicitly requested (\"enrich with verification\", \"verify this email\") or when the contact has no email at all.\n\n**Tools:** `fullenrich_check_credits` → `fullenrich_submit_batch` → `fullenrich_get_results`\n\n**Process:**\n1. Check credit balance first — report to user\n2. Submit contact with firstname, lastname, domain or company_name, and ghl_contact_id\n3. Poll `fullenrich_get_results` until status is complete (may take 30s–3min)\n4. Write result to **Verified Email** field: \"Valid\", \"Invalid\", \"Catch-All\", or \"Unverified\"\n\n**Cost:** 1 credit per email find, 3 per personal email, 10 per mobile phone. Always announce cost before running.\n\n### Phase 6 — AI Synthesis\n\nThis phase takes all raw data from Phases 2–5 and produces the intelligence layer. No external tools — pure reasoning.\n\n#### Step 1: Classification Gate (Partner / Non-ICP / Customer)\n\nBefore scoring, determine what category this contact falls into. The ICP rubric is designed for customers — scoring a property management company or software vendor against it produces misleading numbers. Classify first, then score.\n\n**Classification A — Partner/Vendor (not a buyer, but has referral/integration potential):**\n- Company sells software, technology, or SaaS products (not construction services)\n- Company manufactures or distributes equipment, materials, or supplies\n- Company provides professional services to construction companies (insurance, legal, HR, staffing)\n- Apollo industry classification is \"Information Technology\", \"Computer Software\", \"Staffing\", etc.\n- Website describes products/platforms rather than project work or field operations\n\n→ Set ICP Segment = `\"Partner — [Type]\"` (e.g., \"Partner — Technology Vendor\", \"Partner — Supplier\")\n→ Still calculate the ICP score using the customer rubric, but use the Partner Pre-Call Brief format\n→ Reframe the brief to focus on partnership/referral potential\n\n**Classification B — Non-ICP (wrong industry entirely, no TerraGenie fit):**\n- Company is in an industry with no construction, excavation, surveying, or site work connection\n- Common Non-ICP industries encountered in TerraGenie's lead pool:\n  - **Real estate brokerages/agents** — they sell/list existing properties, they don't build. Company names can be misleading (e.g., \"21 New Homes\" is a brokerage, not a builder). Check for MLS participation, \"listing specialist,\" \"buyer's agent\" language.\n  - **Property management companies** — they manage/maintain existing properties, they don't excavate or do site work. Look for \"tenant screening,\" \"rent collection,\" \"leasing\" in their description.\n  - **Real estate holding companies** (without active development) — passive investors, not builders\n  - **Insurance, financial services, staffing agencies** that happen to serve construction clients\n- Key test: **Does this company ever put a shovel in the ground?** If the answer is no, it's likely a low-fit lead. But even then, present the facts without negative directives — the sales team decides what to pursue.\n- **Important: Landscaping IS a shovel-in-the-ground industry.** Landscapers do layout, grading, excavation, irrigation trenching, hardscaping, and drainage work. They are PRIMARY ICP, not adjacent or non-ICP. If Apollo or any other source classifies a company as \"landscaping\" — that's a green flag, not a red one.\n\n→ Set ICP Segment = `\"Low Fit — [Industry]\"` (e.g., \"Low Fit — Property Management\", \"Low Fit — Real Estate Brokerage\")\n→ Calculate the ICP score normally (it will naturally be lower due to industry mismatch)\n→ Use the Low-Fit Pre-Call Brief format (see below) — factual tone, includes conversation starters, no negative directives\n→ Header: `ℹ️ LOW ICP MATCH — SEE NOTES` (informational flag, not a directive to stop outreach)\n\n**Classification C — Customer (potential TerraGenie buyer):**\nEverything else — construction, surveying, infrastructure detection, **landscaping/hardscaping** (Primary — they do layout, grading, and excavation daily), **pool construction** (Primary — heavy excavation), **irrigation/paving/fencing/solar/septic/demolition** (Primary — regular ground disturbance), and importantly:\n- **Real estate DEVELOPERS** — they DO build things. They commission ground-up construction, manage site work, and need utility detection during development. Look for \"development,\" \"ground-up,\" \"mixed-use,\" \"multi-family construction,\" active project portfolios, \"design-build\" language. These are **Adjacent** segment, not Non-ICP.\n\n→ Proceed with normal ICP scoring and customer Pre-Call Brief format\n\n**The real estate distinction is critical:** Apollo tags developers, brokers, and property managers all as `industry: \"real estate\"`. You MUST look at the company description, services, and website content to distinguish them. The key question: **does this company build, develop, or do ground-up construction?** If yes → Adjacent customer. If they just sell, lease, or manage → Non-ICP.\n\n#### Step 2: ICP Score (0–100)\n\nUnknowns score 0. The score only reflects confirmed data. A low score on a sparse contact means \"we don't know enough\" — not \"they're a bad fit.\"\n\n| Factor | Max Points | Scoring |\n|--------|:----------:|---------|\n| **Industry fit** | 35 | Construction/Civil/GC = 35, Landscaping/Hardscaping/Grading = 35 (layout + grade checking + excavation = core TerraGenie use case), Pool Construction = 30 (heavy excavation + utility detection), RE Developer (ground-up construction) = 25, Surveying = 28, Infrastructure Detection = 22, Irrigation/Paving/Fencing/Solar Ground-Mount/Septic/Demolition = 25 (regular ground disturbance + utility locate needs), Engineering/Inspections (adjacent) = 20, RE Brokerage/Property Mgmt/Unrelated = 5, Guessed from company name only = 5, Unknown = 0 |\n| **Geographic fit** | 25 | Central FL project footprint = 25, Other FL project footprint (South, North, Panhandle) = 22, FL statewide / multi-region FL = 24, Confirmed FL projects but primarily out-of-state = 18, Southeast US (no confirmed FL activity) = 10, Other US = 5, Inferred from area code only = 8, Unknown = 0 |\n| **Decision maker** | 15 | C-suite/VP/SVP/Owner = 15, Director/Partner = 12, Manager = 8, Individual contributor = 3, Gatekeeper (admin/assistant/receptionist) = 2, Unknown = 0 |\n| **Company size** | 15 | Mid-Market (51-200) = 15, Small (11-50) = 12, Enterprise (200+) = 8, Micro (1-10) = 5, Unknown = 0 |\n| **Revenue** | 5 | $50M+ = 5 (whale — multi-project recurring potential), $10M-$50M = 5 (strong mid-market), $5M-$10M = 4, $1M-$5M = 3, Under $1M = 1, Unknown = 0 |\n| **Digital presence** | 5 | Full website with services = 5, Website but thin content = 3, No website = 0 |\n\n**Geography scoring note:** Score based on where the company does PROJECTS, not where their office or HQ is located. A company HQ'd in Illinois with active FL project sites scores on the FL tier matching their project footprint. Look for: service area on website, project portfolio locations, \"florida\" in Apollo keywords, FL license records, FL-tagged in GHL. Office location is a secondary signal, not the primary one.\n\n**Gatekeeper modifier:** If the contact's title indicates they're an admin, assistant, receptionist, office manager, or similar non-decision-making role, cap the Decision Maker factor at 2 points. These contacts can still be valuable as entry points but shouldn't inflate the score.\n\n#### Step 3: Confidence Modifier\n\nAfter calculating the raw ICP score, assess how much of it is based on confirmed data vs. gaps. This helps the sales team distinguish between \"we know they're a 45\" and \"we're guessing they're a 45.\"\n\n| Confidence Level | Criteria | Display |\n|:----------------:|----------|---------|\n| **High** | 5-6 of 6 factors have real data (not \"Unknown = 0\") | `ICP: 85/100 (High Confidence)` |\n| **Medium** | 3-4 of 6 factors have real data | `ICP: 65/100 (Medium Confidence)` |\n| **Low** | 2 of 6 factors have real data | `ICP: 40/100 (Low Confidence)` |\n| **Very Low** | 0-1 of 6 factors have real data | `ICP: 15/100 (Very Low Confidence — manual research needed)` |\n\nThe confidence level is displayed alongside the ICP score in the Pre-Call Brief and in the batch summary table. It does NOT change the numeric score — it provides context for interpreting it.\n\n#### Step 4: ICP Segment\n\nDerived from the services/industry analysis:\n\n**Customer segments:**\n- **Primary — Civil/Construction:** civil engineering, general contracting, residential construction, commercial construction, excavation, grading, site work\n  - Sub-segments: `Residential`, `Commercial`, `Civil/Infrastructure`, `General Contractor`\n- **Primary — Landscaping/Hardscaping:** commercial landscaping, hardscaping, landscape grading, land clearing, outdoor construction. These companies do layout, grade checking, and excavation on virtually every job — they are core TerraGenie customers, not adjacent. Includes companies that do retaining walls, outdoor kitchens, drainage systems, and landscape design-build.\n  - Sub-segments: `Commercial Landscaping`, `Hardscaping`, `Landscape Design-Build`, `Land Clearing/Grading`\n- **Primary — Pool Construction:** pool builders, pool excavation. Heavy excavation work requiring utility detection before every dig. Score 30/35 on Industry.\n- **Primary — Ground Disturbance Trades:** irrigation installation, paving/asphalt, fencing, solar ground-mount, septic/drain field, demolition. Any trade that regularly trenches, excavates, or disturbs the ground needs utility detection and benefits from layout/grade tools. Score 25/35 on Industry.\n- **Secondary — Surveying:** land surveying, geospatial, boundary surveys, topographic surveys\n- **Tertiary — Infrastructure Detection:** utility locating, SUE, underground detection\n- **Adjacent — Real Estate Development:** ground-up developers doing mixed-use, multi-family, or residential development with active construction projects. Key signal: they BUILD things, not just sell/manage. Include sub-type in segment label, e.g., \"Adjacent — Real Estate Development (Mixed-Use & Multi-Family)\"\n- **Adjacent — Engineering/Inspections:** licensed professional engineers, building inspectors, testing labs that operate in the construction ecosystem\n\n**Non-customer segments:**\n- **Partner — Technology Vendor:** software, SaaS, tech products serving construction\n- **Partner — Supplier/Distributor:** materials, equipment, supplies for construction\n- **Partner — Professional Services:** insurance, legal, HR, staffing for construction\n- **Low Fit — Property Management:** companies that manage/maintain existing properties (tenant screening, leasing, rent collection). No excavation or site work. Score will be low, but present factually — they may know contractors who are a fit.\n- **Low Fit — Real Estate Brokerage:** companies that sell/list existing properties (MLS participants, listing agents, buyer's agents). Not builders. Note: company names can be misleading — \"New Homes\" in the name doesn't mean they build. May have referral value.\n- **Low Fit — Other:** any other industry without a clear construction/surveying/ground-disturbance connection. Present the facts and let the sales team decide.\n\n#### Step 5: Engagement Signal\n\nBased on what's visible in the data, note one key engagement signal for the sales team:\n- Technology mentions on website (GPS, drones, 3D scanning) → \"Tech-forward — likely receptive to new tools\"\n- Recent projects or growth signals → \"Active and growing — good timing\"\n- Multiple locations or expanding service area → \"Scaling operations — pain point for fleet/asset management\"\n- No website or minimal digital presence → \"Traditional operator — may need education on tech value\"\n\nInclude this as a one-liner in the Pre-Call Brief under the ICP score.\n\n#### Field Mappings\n\n| Derived Field | Source Logic |\n|---------------|-------------|\n| Company Size Tier | Apollo `estimated_num_employees`: 1-10 → \"Micro (1-10)\", 11-50 → \"Small (11-50)\", 51-200 → \"Mid-Market (51-200)\", 200+ → \"Enterprise (200+)\" |\n| Revenue Tier | Apollo `annual_revenue`: <1M → \"Under $1M\", 1-5M → \"$1M-$5M\", 5-10M → \"$5M-$10M\", 10-50M → \"$10M-$50M\", 50-100M → \"$50M-$100M\", 100M+ → \"$100M+\" |\n| Decision Maker | Apollo `seniority`: c_suite/vp/owner → \"Yes\", director/partner → \"Yes\", manager → \"Unknown\", gatekeeper titles → \"Gatekeeper\", other/null → \"Unknown\", entry_level → \"No\" |\n| Enrichment Status | See criteria below |\n\n**Enrichment Status criteria (formalized):**\n- **Fully Enriched** = At least one rich data source returned company details (industry, employee count, OR detailed services) AND contact role/title is known AND all 3 GHL writes completed successfully\n- **Partially Enriched** = Some useful data found but significant gaps remain: no company details beyond the name, OR no title/role for the contact, OR no domain/website discovered, OR one or more GHL writes could not be completed\n- **Enrichment Failed** = No meaningful data returned from any source after the full fallback chain was attempted. Set confidence to \"Very Low\" and generate the failure Pre-Call Brief with manual research next steps\n| Enrichment Source | Pipe-delimited list of sources that returned data, e.g., \"Apollo \\| Firecrawl \\| Sunbiz \\| AI Synthesis\" |\n\n#### Pre-Call Brief\n\nGenerate a narrative note for the sales team with these sections:\n\n**For customer prospects (narrative style — write for a sales rep who has 2 minutes before a call):**\n```\n🔍 AI ENRICHMENT PRE-CALL BRIEF — [Contact Name] / [Company Name]\nGenerated: [Date] | ICP Score: [X]/100 ([Confidence Level]) | Segment: [ICP Segment]\n\n[If ICP 90+: ⭐⭐ TOP PRIORITY LEAD — or similar flag]\n[If any data discrepancies: ⚠️ flags here]\n\nWHO HE/SHE IS:\n[2-4 sentences, narrative prose. Role, how long at company, career trajectory if known, what they control/decide. Write like you're briefing a colleague, not filling a form.]\n\nTHE COMPANY:\n[2-4 sentences, narrative prose. What they do, size, revenue, where they operate, notable projects or specialties. Include specific numbers when available.]\n\nLEAD SOURCE: [Source] — [one sentence on what this means for outreach context, e.g., \"proactively submitted at IBS\" or \"door-to-door cold contact\"]\n\nWHY TerraGenie FITS:\n[2-3 sentences connecting THIS specific company's operations to TerraGenie's value prop. Be specific — reference their project types, service areas, or operational model. Don't be generic.]\n\nOPENING ANGLES:\n[MANDATORY — never skip this section, even when enrichment data is thin. Generate 2-3 numbered, ready-to-use opening lines or conversation starters. When rich data is available, reference specific details from the enrichment — project names, role specifics, company milestones. The sales rep should be able to read one of these verbatim on the call. When data is sparse, anchor openers on: (1) how the lead came in (ad campaign, form submission, trade show, d2d), (2) what they selected on the form (industry, demo type), (3) their geography or company name. Add a note: \"⚠️ Limited enrichment data — these starters are based on lead source and form responses only. Ask discovery questions early to learn more about their specific needs.\"]\n\n[Optional: POTENTIAL DEAL SIZE if inferable from company scale]\n\n[Contact info: Verified Email, Phone, LinkedIn — whatever is available]\n```\n\n**For low-fit contacts (industry doesn't match core segments):**\n```\n🔍 AI ENRICHMENT PRE-CALL BRIEF — [Contact Name] / [Company Name]\nGenerated: [Date] | ICP Score: [X]/100 ([Confidence Level]) | Segment: [Low Fit — Industry]\n\nℹ️ LOW ICP MATCH — SEE NOTES\n\nWHO HE/SHE IS:\n[2-3 sentences on the person and their role]\n\nTHE COMPANY:\n[2-3 sentences — what they actually do. Be factual and neutral. Do not say \"this is not a fit\" or \"do not pursue.\"]\n\nLEAD SOURCE: [Source]\n\nICP NOTES:\n[2-3 sentences explaining factually why the ICP score is low — e.g., \"Industry is property management, which doesn't typically involve excavation or site work.\" Stay factual, not prescriptive. Never say \"do not reach out,\" \"remove from pipeline,\" or \"not worth pursuing.\"]\n\nPOSSIBLE ANGLES:\n[1-2 sentences — referral potential, edge-case connections, or discovery questions. e.g., \"They may work with builders who need utility detection — worth asking.\" If the angle is thin, say \"Limited direct fit based on available data — a short discovery call could reveal connections not visible in the enrichment.\"]\n\nOPENING ANGLES:\n[2-3 numbered conversation starters. Even for low-fit contacts, generate openers based on whatever data is available — lead source, form responses, industry, geography. These help the sales rep if they choose to make the call. If data is very thin, note: \"⚠️ Limited enrichment data — these starters are based on lead source and form responses only. Use discovery questions early.\"]\n\n[Contact info]\n```\n\n**For partner/vendor contacts:**\n```\n🤝 PARTNER BRIEF — [Contact Name] / [Company Name]\nGenerated: [Date] | ICP Score: [X]/100 (Partner Classification) | Segment: Partner — [Type]\n\nWHO THEY ARE:\n[2-3 sentences on company and contact]\n\nPARTNERSHIP POTENTIAL:\n[2-3 sentences: how this company's offering relates to TerraGenie's market]\n\nREFERRAL/INTEGRATION ANGLE:\n[2-3 sentences: specific ways to collaborate — shared customers, integrations, co-selling]\n\nCONSIDERATIONS:\n[1-2 sentences: competitive risk, alignment questions]\n\nOPENING ANGLES:\n[MANDATORY — 2-3 numbered conversation starters focused on partnership/referral angle rather than direct sale. Reference their product/service and how it intersects with TerraGenie's customer base.]\n\n[Contact info]\n```\n\n**For enrichment failures:**\n```\n⚠️ ENRICHMENT FAILED — MANUAL RESEARCH REQUIRED\n\nWHAT WE KNOW:\n[List all data points we have]\n\nWHAT WE TRIED:\n[Which sources were called and why they failed]\n\nICP SCORE: [X]/100 (Very Low Confidence) — score cannot be trusted due to insufficient data\n\nRECOMMENDED NEXT STEPS:\n[Specific actions: ask the sales rep, check sunbiz.org, reverse phone lookup, Google Maps search]\n\nOPENING ANGLES:\n[MANDATORY — even when enrichment failed, generate 2-3 basic conversation starters from whatever data exists (name, phone area code, lead source, form responses, company name). Note: \"⚠️ Very limited data — these starters use only basic lead info. The call itself is the best enrichment source.\"]\n```\n\n### Phase 7 — GHL Writeback\n\nThree write operations, all in the same turn when possible.\n\n#### Pre-Write: Name & Capitalization Correction\n\nBefore writing, check for and fix data quality issues in the contact and business records:\n\n**Company name correction:** If enrichment sources (Apollo, Firecrawl, FL license records, company website) reveal that the GHL company name has a typo or misspelling, and there is medium-to-high confidence the corrected name is accurate, **overwrite both:**\n- `companyName` on the contact record (via `update_contact`)\n- `name` on the business record (via `update_business`)\n- Examples: \"Sldom Seen Construction Inc\" → \"Seldom Seen Construction Inc\", \"21newhones\" → \"21 New Homes Inc\"\n\n**Contact name correction:** If enrichment sources reveal the contact's first or last name is misspelled AND there is medium-to-high confidence in the correction (e.g., Apollo returns a verified LinkedIn profile with a different spelling), **overwrite `firstName` and/or `lastName`** on the contact record. Include `firstName` and `lastName` parameters in the `update_contact` call.\n- Examples: if GHL has \"Jorosh\" but Apollo + LinkedIn both show \"Jarosh\", correct to \"Jarosh\"\n- If confidence is lower (only one source disagrees), flag the discrepancy in the pre-call brief instead of auto-correcting: \"⚠️ NAME DISCREPANCY: GHL has 'X' but [source] shows 'Y' — verify before outreach\"\n\n**Capitalization fix:** If contact or company names are all-lowercase or ALL-UPPERCASE in GHL, convert to proper Title Case during writeback. This is a formatting fix, not a data correction — always apply it.\n- \"cory spaziani\" → \"Cory Spaziani\"\n- \"ESSEX PROPERTY MANAGEMENT INC\" → \"Essex Property Management Inc\"\n- Include corrected `firstName`, `lastName` on the contact and `name` on the business in the respective update calls\n\n#### Write 1: Contact Custom Fields\n\nUse `update_contact` with field IDs (not fieldKeys — GHL requires IDs for reliable writes):\n\n| Field | ID | Type |\n|-------|----|:----:|\n| Company Position | `8GBZUD9i0v4YwmN5D8ql` | TEXT |\n| LinkedIn URL | `Fs3vd5aDkfmCmMi5ezR5` | TEXT |\n| Industry | `YmQKLcFMLHngYLPqNrQ1` | SINGLE_OPTIONS |\n| Decision Maker | `hug3WGqPGpmWSTDIMCbQ` | TEXT |\n| Verified Email | `KZLIXx1cqpjyxkp7nlGV` | TEXT |\n| Contact Source | `GY8ouGyz20gvT4kOchnu` | TEXT |\n| Company Size Tier | `UVccVccVWu9bEapOHcHP` | TEXT |\n| Revenue Tier | `xksJTkHj856hdcMwGB5P` | TEXT |\n| ICP Score | `huDhxJeTQwziNa1ieNhc` | NUMERICAL |\n| ICP Segment | `e0MhZI4Mz6Byy4KimPsU` | TEXT |\n| Service Area | `JVDIFcZbbIg9q3rKeEOP` | TEXT |\n| Year Founded | `tZjxUT4WsJwGQGtraUZM` | NUMERICAL |\n| Enrichment Date | `mKxoh4updlE5gTHn5rE4` | DATE |\n| Enrichment Status | `fWKopv1EoEk7w05xUbUZ` | TEXT |\n| Company Website | `BYci9oLWTdYipwsuAzH3` | TEXT |\n| Enrichment Source | `pu7XXEeb8y0195Dj2V4S` | TEXT |\n\n**Custom field write format:** `[{\"key\": \"<field_id>\", \"field_value\": \"<value>\"}]`\n\nThe `key` parameter maps to the field `id` (not `fieldKey`). This is a GHL API quirk — the MCP's `toContactCustomFields` helper handles the remapping. For NUMERICAL fields, send the number as a string (e.g., `\"80\"`) — GHL converts it.\n\n#### Write 2: Business Standard Fields\n\nUse `update_business` with standard fields only (custom fields on Business don't work via API):\n- `website`, `phone`, `address`, `city`, `state`, `postalCode`, `country`, `description`\n- Only write fields that are currently empty — never overwrite existing business data unless the user explicitly says to\n\n**Company Website dual-write:** The company website URL is written to BOTH:\n1. Business standard `website` field (via `update_business`) — canonical source\n2. Contact custom field **Company Website** (`BYci9oLWTdYipwsuAzH3`) — visible in contact list views and smart lists\n\nSource priority for website: Apollo org `website_url` > Firecrawl discovery > email domain inference. The same URL goes to both locations.\n\n#### Write 3: Contact Note\n\nUse `create_contact_note` with the Pre-Call Brief as the body. This appears in the contact's timeline in GHL.\n\n---\n\n## Batch Mode\n\nWhen enriching multiple contacts:\n\n1. **Credit estimate:** Before starting, calculate: (number of contacts × 2 Apollo credits) + any Fullenrich credits. Announce: \"This batch of N contacts will use approximately X Apollo credits. Proceed?\"\n2. **Org deduplication:** Track domains already enriched in this batch. If 3 contacts share `inbhomes.com`, call `apollo_organizations_enrich` once and reuse the result. For 2-10 unique domains, use `apollo_organizations_bulk_enrich`.\n3. **Hallucination tracking:** In batch mode, keep a running list of Firecrawl-extracted service descriptions. If a new contact's extraction produces text identical (or near-identical) to a previous contact's, the extraction is hallucinated — discard it and note the gap.\n4. **Sequential execution:** Run the pipeline per contact, one at a time. Print a progress line after each: `[3/15] ✅ Jonathan Bell — ICP: 90 (High) — Fully Enriched`\n5. **Summary table:** After the batch completes, print:\n\n```\n| Contact | Company | ICP Score | Confidence | Segment | Status |\n|---------|---------|:---------:|:----------:|---------|--------|\n| Jonathan Bell | INB Homes | 90 | High | Primary — Civil/Construction | Fully Enriched |\n| Debby Dearth | McNally Construction | 70 | Medium | Primary — Civil/Construction | Partially Enriched |\n| Eddie | Kings Homes | 13 | Very Low | Primary — Civil/Construction | Enrichment Failed |\n| Janie Linscott | Optic Systems | 53 | High | Partner — Technology Vendor | Fully Enriched |\n\nCredits used: 5 Apollo | 0 Fullenrich\nFallback sources used: Sunbiz (2) | Google Maps (1)\n```\n\n6. **Batch limits:** Default max 25 contacts per run. Over 10, require explicit confirmation. Over 25, suggest splitting into batches.\n\n---\n\n## Error Handling\n\n| Scenario | Action |\n|----------|--------|\n| Apollo returns no person match | Set Company Position = \"Unknown\", skip LinkedIn/seniority. Note in Enrichment Source. |\n| Apollo returns no org match | Do NOT stop. Proceed to Phase 4 (Firecrawl) and Phase 4b (multi-source fallback). Flag for fallback chain. |\n| Apollo org returns empty `{}` | Same as no match — common for small/new companies. Proceed to Firecrawl + fallback sources. |\n| Personal email domain detected | Trigger Phase 1.5 domain discovery before Apollo org. Do not call Apollo org on gmail.com, yahoo.com, etc. |\n| Firecrawl scrape times out | Retry with `firecrawl_search_data`. If that also fails, proceed to Phase 4b fallback sources. |\n| Firecrawl finds wrong company | Cross-check domain against contact's email domain or company name. Discard if mismatch. |\n| Firecrawl returns hallucinated/generic content | Discard the extraction. In batch mode, compare against previous extractions — identical text across different companies = hallucinated. Note \"Firecrawl extraction unreliable\" in Enrichment Source. Proceed to Phase 4b. |\n| No domain available at all | Skip Apollo org + Firecrawl scrape. Go straight to Firecrawl search → Phase 4b fallback chain. If all fail, mark as Enrichment Failed. |\n| Contact has no last name | Skip Apollo person match entirely. Note in Pre-Call Brief. |\n| Contact is a partner/vendor, not a customer | Apply classification gate (Phase 6 Step 1). Score normally but use Partner Pre-Call Brief format. Set ICP Segment to \"Partner — [Type]\". |\n| Contact is low-fit (industry doesn't match core segments) | Apply classification gate (Phase 6 Step 1). Score normally (will be low). Use Low-Fit Pre-Call Brief format with \"ℹ️ LOW ICP MATCH — SEE NOTES\" flag. Set ICP Segment to \"Low Fit — [Industry]\". Always include OPENING ANGLES — the sales team decides whether to pursue. |\n| Company name has typo in GHL | Correct during Phase 7 Pre-Write if medium+ confidence from enrichment sources. Overwrite `companyName` on contact and `name` on business. |\n| Contact name misspelled or wrong case | If medium+ confidence correction available, fix `firstName`/`lastName` in `update_contact`. If lower confidence, flag in pre-call brief only. Always fix capitalization (all-lower/ALL-CAPS → Title Case). |\n| Apollo tags company as \"real estate\" | Do NOT auto-classify. Check description and services: RE developer (builds things) = Adjacent customer, RE brokerage (sells properties) = Low Fit, Property management (manages rentals) = Low Fit. See Phase 6 Step 1 for details. |\n| GHL write fails | Report the error. Do not retry automatically — the user should investigate. |\n| Fullenrich returns no results after polling | Set Verified Email = \"Unverified\". Note in Enrichment Source. |\n| All fallback sources exhausted with insufficient data | Mark as \"Enrichment Failed\". Set confidence to \"Very Low\". Generate the failure Pre-Call Brief with specific next steps for manual research. |\n\n---\n\n## Important Notes\n\n- **Credit awareness:** Always announce credit costs before making Apollo or Fullenrich calls. Never burn credits silently.\n- **Contact Source preservation:** If Contact Source already has a value (e.g., \"Trade Show\", \"Web Form\"), do not overwrite it. Only set it if it's currently empty.\n- **Industry field:** The Industry field on Contact (`YmQKLcFMLHngYLPqNrQ1`) is SINGLE_OPTIONS with values: Construction, Surveyors, Infrastructure Detectors, Landscape or Playgrounds, Pools, Other. Map Apollo's industry string to the closest match. For partner/vendor and low-fit contacts, use \"Other\". For RE developers with active construction, use \"Construction\". For landscaping/hardscaping companies, use \"Landscape or Playgrounds\" — these are PRIMARY ICP customers.\n- **Landscaping is Primary ICP.** This is a v2.2 change based on direct client feedback. Landscaping companies do layout, grading, excavation, and irrigation work — they need utility detection and grade-checking tools on virtually every job. Never classify a landscaping company as low-fit or adjacent. Score them at 35/35 on Industry, same as construction/civil.\n- **Date format:** Enrichment Date expects ISO format: `YYYY-MM-DD`\n- **Re-enrichment:** When re-enriching, overwrite all fields with fresh data except Contact Source.\n- **Data integrity:** Bad data is worse than no data. When in doubt about the accuracy of extracted information, mark the field as unknown rather than writing unreliable data. The sales team makes real calls based on these briefs.\n- **Source attribution:** Always track which sources contributed data in the Enrichment Source field. This helps diagnose issues and builds confidence in the data quality over time.\n- **Real estate taxonomy:** Apollo classifies developers, brokers, and property managers all as `industry: \"real estate\"`. Never trust this label alone. Always check the company description, website, and services to determine: Does this company BUILD things (→ Adjacent customer) or just sell/manage properties (→ Low Fit)? This distinction has the biggest impact on ICP accuracy for TerraGenie's lead pool.\n- **Conversation starters are the #1 value-add.** TerraGenie's sales team specifically called out OPENING ANGLES as the most helpful part of the enrichment. They help newer reps open calls confidently by connecting the prospect's business to TerraGenie's value prop. NEVER skip this section on any brief — customer, partner, low-fit, or enrichment failure. When data is thin, anchor on lead source, form responses, and industry. When data is rich, get specific about projects, services, and company details. Accuracy is critical — a hallucinated talking point can kill the relationship before it starts. When you don't have enough data for confident talking points, say so explicitly rather than making things up.\n- **Name auto-correction:** During Phase 7, fix company name typos and capitalization issues (all-lower → Title Case, ALL-CAPS → Title Case) with medium+ confidence. Fix contact name misspellings when multiple sources confirm the correction. Flag rather than correct when only one source disagrees.\n";

const SYSTEM_PROMPT = `You are running as an automated lead-enrichment agent triggered by a GoHighLevel webhook (a new lead just landed). You execute the lead-enrichment skill below autonomously — there is no user to ask follow-up questions of. Make best-judgment calls and proceed.

Tool names available in THIS environment (ignore any "mcp__..." prefixes the skill mentions):
- GHL tools (via MCP): search_contacts, get_contact, get_business, get_businesses, update_contact, update_business, create_contact_note, get_location_custom_fields, get_pipelines, fullenrich_check_credits, fullenrich_submit_batch, fullenrich_get_results, plus the full GHL tool set
- apollo_people_match — Apollo person enrichment
- apollo_organizations_enrich — Apollo company enrichment by domain
- firecrawl_scrape_page — scrape a webpage as markdown
- firecrawl_search_data — Google search via Firecrawl

Fullenrich rule from the skill (Default: OFF) applies here too — do not call Fullenrich tools unless the contact has no email at all.

Operate autonomously. Perform all writes (update_contact, update_business, create_contact_note). Do not ask for confirmation. When finished, return a brief one-paragraph summary of what was enriched and the ICP score assigned.

---

${SKILL_CONTENT}`;

// ─── Custom tool schemas (Apollo + Firecrawl as direct API tools) ──────────
const CUSTOM_TOOLS = [
  {
    name: 'apollo_people_match',
    description: 'Match a person on Apollo by name + email or domain. Returns title, seniority, LinkedIn URL, and embedded organization data. Cost: 1 Apollo credit.',
    input_schema: {
      type: 'object',
      properties: {
        first_name: { type: 'string', description: 'First name (required)' },
        last_name: { type: 'string', description: 'Last name (required)' },
        email: { type: 'string', description: 'Email address (recommended for match accuracy)' },
        domain: { type: 'string', description: 'Company domain (alternative to email)' },
        organization_name: { type: 'string', description: 'Company name (fallback)' }
      },
      required: ['first_name', 'last_name']
    }
  },
  {
    name: 'apollo_organizations_enrich',
    description: 'Enrich a company by domain on Apollo. Returns industry, employee count, annual revenue, founded year, address, description, website. Cost: 1 Apollo credit. Skip if person.organization from people_match already has the data.',
    input_schema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Company domain (e.g. acme.com) — required' }
      },
      required: ['domain']
    }
  },
  {
    name: 'firecrawl_scrape_page',
    description: 'Scrape a webpage and return main content as markdown. Read the markdown yourself and extract intelligence — never trust auto-extraction. Use for company website analysis (services, geography, equipment mentions).',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL to scrape' },
        only_main_content: { type: 'boolean', description: 'Strip nav/ads/footer (default true)' }
      },
      required: ['url']
    }
  },
  {
    name: 'firecrawl_search_data',
    description: 'Google search via Firecrawl. Returns ranked URLs and snippets. Use to find company websites (when domain is unknown), Sunbiz records, Google Maps listings, LinkedIn pages.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Max results (default 5)' }
      },
      required: ['query']
    }
  }
];

// ─── Custom tool executors ─────────────────────────────────────────────────

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

async function executeCustomTool(name, input) {
  const inputPreview = JSON.stringify(input).substring(0, 200);
  console.log(`[enrich] tool_call: ${name} ${inputPreview}`);
  try {
    let result;
    switch (name) {
      case 'apollo_people_match': result = await execApolloPeopleMatch(input); break;
      case 'apollo_organizations_enrich': result = await execApolloOrgEnrich(input); break;
      case 'firecrawl_scrape_page': result = await execFirecrawlScrape(input); break;
      case 'firecrawl_search_data': result = await execFirecrawlSearch(input); break;
      default: throw new Error(`Unknown custom tool: ${name}`);
    }
    return result;
  } catch (err) {
    console.error(`[enrich] tool ${name} failed: ${err.message}`);
    return { error: err.message };
  }
}

// ─── Anthropic API call ────────────────────────────────────────────────────

async function callAnthropic(messages) {
  const mcpUrl = `https://go-high-level-mcp-theta.vercel.app/${process.env.MCP_PATH_SECRET}/sse`;

  const body = {
    model: MODEL,
    max_tokens: MAX_TOKENS_PER_TURN,
    system: [
      { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }
    ],
    messages,
    // The mcp-client-2025-11-20 beta requires an explicit mcp_toolset entry in
    // tools to bind the model to a declared MCP server. Without it, the API
    // returns "MCP server 'ghl' is defined but [not used]".
    tools: [
      ...CUSTOM_TOOLS,
      { type: 'mcp_toolset', mcp_server_name: 'ghl' }
    ],
    mcp_servers: [
      { type: 'url', url: mcpUrl, name: 'ghl' }
    ]
  };

  console.log(`[anthropic] POST ${ANTHROPIC_API_URL} body=${JSON.stringify(body).length}b`);

  // Per-turn fetch timeout. Vercel Fluid Compute Hobby max is 300s.
  // Set high enough that the agent has room to breathe; we'd rather see real
  // results than abort prematurely.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    console.warn('[anthropic] aborting fetch after 280s');
    controller.abort();
  }, 280000);

  let res;
  try {
    res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': ANTHROPIC_BETA,
        'content-type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (err) {
    clearTimeout(timeoutId);
    console.error(`[anthropic] fetch threw: ${err.name}: ${err.message}`);
    throw err;
  }
  clearTimeout(timeoutId);

  console.log(`[anthropic] response status=${res.status}`);

  const text = await res.text();
  console.log(`[anthropic] response body=${text.length}b status=${res.status}`);

  if (!res.ok) {
    console.error(`[anthropic] error body: ${text.substring(0, 2000)}`);
    throw new Error(`Anthropic API ${res.status}: ${text.substring(0, 1000)}`);
  }

  try {
    return JSON.parse(text);
  } catch (err) {
    console.error(`[anthropic] JSON parse failed: ${err.message}; body preview: ${text.substring(0, 500)}`);
    throw err;
  }
}

// ─── Agent loop ────────────────────────────────────────────────────────────

async function runEnrichment(contactId) {
  const startTime = Date.now();
  console.log(`[enrich] start contact=${contactId}`);

  let messages = [
    {
      role: 'user',
      content: `Enrich GHL contact ${contactId}. Run the full pipeline (read contact + business, Apollo person + org enrichment, Firecrawl website scrape, ICP scoring, GHL writeback for contact custom fields + business standard fields + pre-call brief note). Return a one-paragraph summary when done.`
    }
  ];

  let turn = 0;
  while (turn < MAX_TURNS) {
    turn++;
    console.log(`[enrich] turn=${turn} calling Anthropic`);

    const response = await callAnthropic(messages);
    const usage = response.usage || {};
    console.log(`[enrich] turn=${turn} stop=${response.stop_reason} ` +
                `in=${usage.input_tokens || 0} cache_read=${usage.cache_read_input_tokens || 0} ` +
                `cache_create=${usage.cache_creation_input_tokens || 0} out=${usage.output_tokens || 0}`);

    const assistantContent = response.content;

    if (response.stop_reason === 'tool_use') {
      const toolUseBlocks = assistantContent.filter(b => b.type === 'tool_use');
      const customToolUses = toolUseBlocks.filter(b => CUSTOM_TOOLS.some(t => t.name === b.name));

      if (customToolUses.length === 0) {
        // Anthropic resolves MCP tool calls server-side, so we shouldn't see them here.
        // If we do see tool_use with no custom tools, something's off.
        console.warn(`[enrich] turn=${turn} stop=tool_use but no custom tools to execute`);
        break;
      }

      const toolResults = [];
      for (const block of customToolUses) {
        const result = await executeCustomTool(block.name, block.input);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: typeof result === 'string' ? result : JSON.stringify(result)
        });
      }

      messages.push({ role: 'assistant', content: assistantContent });
      messages.push({ role: 'user', content: toolResults });
    } else if (response.stop_reason === 'end_turn') {
      const finalText = assistantContent
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n');
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[enrich] DONE in ${elapsed}s, ${turn} turns. Summary: ${finalText.substring(0, 1500)}`);
      return { ok: true, turns: turn, elapsedSeconds: elapsed, finalText };
    } else {
      console.warn(`[enrich] unexpected stop_reason: ${response.stop_reason}`);
      break;
    }
  }

  console.warn(`[enrich] hit MAX_TURNS=${MAX_TURNS}`);
  return { ok: false, turns: turn, error: 'max_turns_exceeded' };
}

// ─── Main webhook handler ──────────────────────────────────────────────────

const handler = async (req, res) => {
  // 1. Server-config sanity check (auth secret must exist)
  const SECRET = process.env.WEBHOOK_SECRET;
  if (!SECRET || SECRET.length < 16) {
    res.status(500).json({ error: 'Server configuration error' });
    return;
  }

  // 2. Method
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // 3. Auth
  if (!req.headers || req.headers.authorization !== `Bearer ${SECRET}`) {
    console.log('[enrich-webhook] Rejected: bad or missing Authorization header');
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  // 4. Required env vars (need all four for Phase 2 to work)
  const required = ['ANTHROPIC_API_KEY', 'APOLLO_API_KEY', 'FIRECRAWL_API_KEY', 'MCP_PATH_SECRET'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.error('[enrich-webhook] Missing env vars:', missing);
    res.status(500).json({ error: 'Server misconfigured', missing });
    return;
  }

  // 5. Parse body
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

  // 6. Extract contact ID (GHL field names vary by trigger)
  const contactId =
    payload.contact_id || payload.contactId || payload.id ||
    (payload.contact && (payload.contact.id || payload.contact.contact_id));

  if (!contactId) {
    console.error('[enrich-webhook] No contact ID in payload:', JSON.stringify(payload).substring(0, 500));
    res.status(400).json({ error: 'No contact ID found in payload' });
    return;
  }

  console.log(`[enrich-webhook] Webhook received for contact ${contactId}`);

  // 7. Run enrichment SYNCHRONOUSLY (Vercel serverless tends to kill post-response
  // background work, so we work first and respond after). GHL's webhook timeout
  // is generous enough for a typical 30-50s enrichment.
  let result;
  try {
    result = await runEnrichment(contactId);
    console.log(`[enrich-webhook] Result: ${JSON.stringify(result).substring(0, 800)}`);
  } catch (err) {
    console.error(`[enrich-webhook] Enrichment failed: ${err.message}`);
    if (err.stack) console.error(err.stack);
    res.status(500).json({ ok: false, error: err.message, contactId });
    return;
  }

  // 8. Respond to GHL with the outcome
  res.status(200).json({
    ok: true,
    contactId,
    enrichment: {
      ok: result.ok,
      turns: result.turns,
      elapsedSeconds: result.elapsedSeconds
    },
    finished_at: new Date().toISOString()
  });
};

module.exports = handler;
// Tell Vercel this function may run up to 60s (matches Hobby-tier max).
module.exports.config = { maxDuration: 300 };
