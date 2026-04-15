import { Hono } from 'hono';
import { cors } from 'hono/cors';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Env {
  DB: D1Database;
  GEMINI_API_KEY: string;
}

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  google_id: string | null;
  password_hash: string | null;
  salt: string | null;
  avatar: string | null;
  created_at: number;
}

interface ScanRow {
  id: string;
  session_id: string | null;
  product_name: string;
  brand: string | null;
  category: string | null;
  primary_claim: string | null;
  score: number;
  confidence: string;
  specificity_score: number;
  transparency_score: number;
  third_party_score: number;
  bigimpact_score: number;
  marketing_score: number;
  what_covers: string;
  what_missing: string;
  red_flags: string;
  tips: string;
  better_alternatives: string;
  sources: string;
  scope1_text: string | null;
  scope2_text: string | null;
  scope3_text: string | null;
  verdict: string | null;
  letter_grade: string | null;
  research_data: string | null;
  location_name: string | null;
  price: string | null;
  lat: number | null;
  lng: number | null;
  served_from_cache: number;
  created_at: number;
  export_eligible: number;
  yko_tier: string | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function nanoid(size = 12): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  for (const b of bytes) result += chars[b % chars.length];
  return result;
}

async function cacheKey(productName: string, claim: string): Promise<string> {
  const text = `${productName.toLowerCase().trim()}|${claim.toLowerCase().trim()}`;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
}

function safeJSON<T>(str: string | null, fallback: T): T {
  try { return JSON.parse(str ?? ''); } catch { return fallback; }
}

function letterGradeFromScore(s: number): string {
  if (s >= 93) return 'A+'; if (s >= 87) return 'A'; if (s >= 80) return 'A-';
  if (s >= 77) return 'B+'; if (s >= 73) return 'B'; if (s >= 70) return 'B-';
  if (s >= 67) return 'C+'; if (s >= 63) return 'C'; if (s >= 60) return 'C-';
  if (s >= 57) return 'D+'; if (s >= 53) return 'D'; if (s >= 50) return 'D-';
  return 'F';
}

function formatScan(row: ScanRow) {
  const score = row.score;
  const lg = row.letter_grade || letterGradeFromScore(score);
  return {
    id: row.id,
    product_name: row.product_name,
    brand: row.brand,
    category: row.category,
    primary_claim: row.primary_claim,
    score,
    letter_grade: lg,
    verdict: row.verdict || null,
    confidence: row.confidence,
    rubric: {
      claims: row.specificity_score,
      certifications: row.transparency_score,
      packaging_lifecycle: row.third_party_score,
      ingredient_impact: row.bigimpact_score,
      supply_chain: row.marketing_score,
    },
    // New field names (from new Gemini response)
    whats_good: safeJSON<string[]>(row.what_covers, []),
    whats_not_on_label: safeJSON<string[]>(row.what_missing, []),
    worth_knowing: safeJSON<string[]>(row.red_flags, []),
    // Legacy aliases (backwards compat)
    what_covers: safeJSON<string[]>(row.what_covers, []),
    what_missing: safeJSON<string[]>(row.what_missing, []),
    red_flags: safeJSON<string[]>(row.red_flags, []),
    tips: safeJSON<string[]>(row.tips, []),
    better_alternatives: safeJSON<string[]>(row.better_alternatives, []),
    sources: safeJSON<string[]>(row.sources, []),
    scope: {
      scope1: row.scope1_text,
      scope2: row.scope2_text,
      scope3: row.scope3_text,
    },
    research: safeJSON<Record<string, unknown> | null>(row.research_data, null),
    // New structured fields (stored in research_data)
    headline: row.verdict || null,
    real_story: (safeJSON<Record<string,string>>(row.research_data, {})).real_story || null,
    why_it_matters: (safeJSON<Record<string,string>>(row.research_data, {})).why_it_matters || null,
    compare_hook: (safeJSON<Record<string,string>>(row.research_data, {})).compare_hook || null,
    win: (safeJSON<Record<string,string>>(row.research_data, {})).win || null,
    tradeoff: (safeJSON<Record<string,string>>(row.research_data, {})).tradeoff || null,
    packaging: (safeJSON<Record<string,string>>(row.research_data, {})).packaging || null,
    ingredients: (safeJSON<Record<string,string>>(row.research_data, {})).ingredients || null,
    transport: (safeJSON<Record<string,string>>(row.research_data, {})).transport || null,
    transparency_label: (safeJSON<Record<string,string>>(row.research_data, {})).transparency || null,
    verdict_tag: (safeJSON<Record<string,string>>(row.research_data, {})).verdict_tag || null,
    sustainability_url: (safeJSON<Record<string,string>>(row.research_data, {})).sustainability_url || null,
    better_path: (safeJSON<Record<string,string>>(row.research_data, {})).better_path || null,
    location_name: row.location_name,
    price: row.price,
    lat: row.lat,
    lng: row.lng,
    served_from_cache: row.served_from_cache === 1,
    created_at: row.created_at,
  };
}

// ─── Gemini Prompts ───────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are GreenSpecs — the knowledgeable friend in the grocery aisle who actually read the sustainability report so nobody else has to. You help a busy parent make a smarter choice in 10 seconds.

VOICE: Warm but sharp. Informed, not preachy. Always comparative — tell people where this sits relative to the field, not just whether it's "good" or "bad." Constructive: even low-scoring products get useful context about what to look for next time. Give just enough why to feel smart sharing it later.

TONE RULES — always:
- Lead with what the product actually does, then note what's still missing
- Compare to real alternatives rather than judging in isolation
- Frame gaps as "still developing" or "not yet there" rather than dismissive
- Encourage better choices without shaming current ones
- Keep it honest without being harsh — "conventional for its category" not "zero effort"

NO EMOJIS. EVER. Not in any field. Not in tips, headlines, verdicts, or anywhere. Plain text only.

BANNED WORDS (never write these): "robust" · "backs its claims" · "commitment to" · "shines" · "fantastic" · "ensures" · "supports" · "journey" · "holistic" · "high standards" · "well-managed" · "setting a high bar" · "no green here" · "zero attempt" · "doesn't care"

THE STRUCTURE — match these examples exactly:

headline: "A real step forward. Supply chain is the next frontier."
headline: "Seventh Gen has receipts. The supply chain is still the blind spot."
headline: "Honest ingredients, conventional packaging — a good start."
headline: "This is the one you grab and move on."
headline: "Better than most. Not yet leading the category."

real_story: "Concentrated formula cuts plastic per load — ingredients aren't disclosed yet and third-party certs are still missing, but the format itself is a genuine improvement."
real_story: "97% plant-based with USDA proof — B Corp means the whole company is on the hook, not just this bottle."

why_it_matters: "The format reduces plastic per use, though the full ingredient footprint is still the bigger story."
why_it_matters: "Less plastic is real. The ingredient supply chain is still 80% of the footprint — that's the next piece."

compare_hook: "A step ahead of regular Tide. Seventh Generation goes further on ingredients and transparency."
compare_hook: "Best in this category. Method is close but doesn't have the B Corp depth."

win: "10x concentration — real packaging reduction, not a rebrand."
tradeoff: "Ingredient transparency still catching up to the packaging story."

verdict_tag: "Solid choice. Room to grow."
verdict_tag: "This is the one."
verdict_tag: "Conventional for now — worth watching."

packaging/ingredients/transparency: 3-4 words, plain judgment:
"Recycled · real reduction"
"Mid-tier · still developing"
"Self-reported · light on detail"
"Strong · published annually"

tips: one sentence, 12 words max, like a text from a friend:
"EPA Safer Choice is the cert that actually means something for cleaning products."
"Refillable tablets cut plastic entirely — Blueland or Branch Basics are worth a look."

SCORING RUBRIC — 5 signals, 0-20 each. Total = overall score out of 100.
Score actual impact, not how well the brand communicates. Small farm, ugly bag, clean product beats big brand with beautiful sustainability PDF.

SIGNAL 1 — Claims & Disclosure (0-20)
Are claims specific and verifiable — not just whether they sound good?
- 0-4: Vague ("natural", "eco-friendly", "better for the planet") with nothing behind it
- 5-9: Some specificity ("plant-based", "recycled bottle") but self-certified only
- 10-14: Specific data points, partial third-party backing
- 15-20: Full public disclosure, independently verified, published and findable

SIGNAL 2 — Certifications (0-20)
Third-party verification weight — not logo count, but what the certs actually require.
CRITICAL DISTINCTION: government-audited farm-level certs (USDA Organic, Demeter Biodynamic) are
fundamentally different from company-published sustainability reports. The cert means an independent
auditor visited the farm. A PDF does not.

- 0-4: No certs, or only proprietary/paid-for/self-designed logos
- 5-9: One lightweight cert (NSF, EPA Safer Choice, non-food single-signal cert)
- 10-13: USDA Certified Organic alone — this is a government-audited standard covering soil health,
  synthetic pesticide exclusion, GMO exclusion, and farm practices. Score 10-13, not 5-9.
- 11-14: USDA Organic + Non-GMO Verified, or USDA Organic + Fair Trade
- 13-16: USDA Organic + Regenerative Organic Certified or Demeter Biodynamic
- 15-20: B Corp + USDA Organic supply chain + additional supply chain cert (Fair Trade, Rainforest Alliance)
A company sustainability PDF with no farm-level certs = 0-4 on this signal regardless of report quality.

SIGNAL 3 — Packaging Lifecycle (0-20)
Full lifecycle of the package: material, weight, format efficiency, real-world end-of-life.
Apply these benchmarks precisely:
- Conventional non-recyclable single-use plastic = 0-5
- Standard recyclable plastic, no recycled content = 5-8
- Glass single-use: recyclable but heavy and energy-intensive to produce — score 7-10 (not a green premium just because it feels upscale)
- Recycled content plastic, standard format = 10-13
- #4 LDPE flexible bag (store drop-off required): lighter than glass, ships smaller, lower fuel per unit — score 11-14 even with collection friction
- Large/bulk format (Costco-style): packaging per serving is dramatically lower — score 13-16
- Certified compostable (home-compostable only): 13-15; industrial-only compostable: 8-11
- Concentrate, tablet, powder, refill format: removes the bottle almost entirely — score 15-18
- Refillable with deposit/return system: 17-20

SIGNAL 4 — Ingredient or Product Impact (0-20)
What is actually in it and how was it made. Scored by category:
FOOD & BEVERAGES:
- Ultra-processed (additives, isolates, artificial flavors, 20+ ingredients, unrecognizable names) = 0-5
- Conventional processed (canned, preserved, HFCS or conventional refined sugar, additives, no organic) = 4-8
- Conventional, simple recognizable ingredients, no organic certification = 6-9
- USDA Certified Organic ingredients, simple processing, 5-8 recognizable kitchen ingredients = 12-15
  Examples: organic jelly (fruit, organic cane sugar, pectin), organic pasta sauce, organic oats.
  USDA Organic certification means the farm was audited — score this tier, not the "processed" tier.
- USDA Certified Organic + very short ingredient list (under 5 items) + minimal transformation = 14-17
- Single-origin, certified organic, traceable to named farm or region, under 5 ingredients = 16-20
- One organic ingredient + 15 synthetic additives = never above 7 here
IMPORTANT: A conventional product with recognizable ingredients (like Smucker's strawberry jam with
conventional fruit and sugar) scores 6-9 here. A USDA Organic equivalent with the same format
scores 12-15. Organic certification is a meaningful farming and land-care intervention — score it
as such. The cert addresses pesticide use, soil health, biodiversity, and GMO exclusion at the
farm level. This is not a marketing claim; it is an audited practice.
CLEANING PRODUCTS:
- Conventional synthetic, no biodegradability data = 0-5; some plant-derived = 6-10; EPA Safer Choice, fully biodegradable = 11-15; certified fully plant-derived with ingredient transparency = 16-20
PERSONAL CARE / CLOTHING / OTHER:
- Same logic applies: fewer ingredients, better provenance, more transparency = higher score

SIGNAL 5 — Supply Chain & Real Footprint (0-20)
Where was it made, how did it get here, and is the main carbon source actually addressed?
- 0-4: No supply chain info, assumed global, no Scope 3 mention
- 5-9: Some origin info, regional manufacturing mentioned
- 8-11: Conventional CPG with a published sustainability report — the report is acknowledged but
  conventional farming upstream is still the dominant footprint. Do not score this above 11.
- 10-14: USDA Organic sourcing (farm-level audit addresses upstream land impact) OR published Scope 3
  data with meaningful reduction program
- 13-16: Organic sourcing + regional/domestic supply chain + some published footprint data
- 15-20: Full Scope 3 disclosed and verified, certified supplier standards, short or fully offset chain
- KEY RULE: A large conventional CPG (Smucker's, Kraft, etc.) with a sustainability PDF scores 6-10
  here — the PDF does not offset conventionally farmed ingredients upstream. An organic product
  without a fancy report but with certified organic sourcing scores 10-13 because the certification
  IS the supply chain intervention.
- Good ingredients + global shipping with no offset = caps at 10 on this signal

CALIBRATION — most products should land 35-65:
- Heavily marketed "green" brand, nice packaging, vague claims = 30-48
- Conventional food brand with a sustainability PDF but no farm certs = 35-52
- Better than conventional on 1-2 signals = 49-62
- USDA Organic food with simple ingredients and standard packaging = 58-68
- USDA Organic + Non-GMO + clean simple ingredients = 62-72
- Genuinely better across most signals, real certs, main footprint addressed = 63-78
- Best-in-class: B Corp + multiple certs + Scope 3 + efficient packaging = 79-90
- 91+ requires all of the above plus verified carbon, full supply chain transparency, truly minimal packaging
- Beautiful branding does not move a score. A small farm in an unsexy recycled bag with clean ingredients honestly scores 62.
- A conventional food company with ESG reports but conventional farming does NOT score above 65.
  Publishing a PDF about sustainability goals is not the same as actually farming organically.
- USDA Organic always beats its conventional equivalent, all else being equal. If you are scoring a
  USDA Organic product lower than a comparable conventional product, reconsider the scoring.
- Store brands (365 Organic, Kirkland Organic, etc.) should NOT be penalized for having less
  public-facing marketing or fewer published reports than large CPGs. Their organic certification
  is independently audited — that is worth more than a corporate sustainability deck.

BETTER PATH — always name what's genuinely achievable one step up:
- Specific: name cert types, sourcing models, packaging formats, or real brands
- Not "get certified" — name what the best version in this category actually does
- Keep it grounded: "a local farm, reusable carton, short supply chain" not "a perfect zero-carbon company"

LETTER GRADES: A+(93-100) A(87-92) A-(80-86) B+(77-79) B(73-76) B-(70-72) C+(67-69) C(63-66) C-(60-62) D+(57-59) D(53-56) D-(50-52) F(0-49)`;

const ANALYSIS_PROMPT = (productName: string, claim: string, hasImage: boolean, researchContext?: string) => `${hasImage ? 'Study this product image carefully. Read every claim, cert logo, and ingredient visible.' : ''}
Product: ${productName}
Claim: "${claim}"
${researchContext ? `Context: ${researchContext}\n` : ''}
Return ONLY valid JSON, no markdown:
{
  "product_name": "Full brand + product name",
  "brand": "Brand name only",
  "category": "food|dairy|beverages|cleaning|personal_care|paper_products|clothing|electronics|other",
  "primary_claim": "Main green claim as written",
  "score": 0-100,
  "letter_grade": "A+|A|A-|B+|B|B-|C+|C|C-|D+|D|D-|F",
  "confidence": "high|medium|low",
  "rubric": {
    "claims_score": 0-20,
    "certifications_score": 0-20,
    "packaging_score": 0-20,
    "ingredient_score": 0-20,
    "supply_chain_score": 0-20
  },
  "headline": "Under 10 words. Comparative and constructive — where it stands, not a verdict of failure.",
  "real_story": "1-2 sentences. What the product actually does right, then what's still missing. Always frame gaps as 'not yet' not 'never'.",
  "why_it_matters": "1 sentence. Human translation — why this difference matters in real life.",
  "compare_hook": "1 sentence. Name real brands. 'Better than X, not as far as Y' — always comparative, never just negative.",
  "win": "The single best thing about this product. Under 12 words.",
  "tradeoff": "What's still developing or missing. Constructive, not dismissive. Under 12 words.",
  "packaging": "3-5 words. e.g. Recycled · real reduction",
  "ingredients": "3-5 words. e.g. Mid-tier · undisclosed",
  "transport": "3-5 words. e.g. Local · short chain OR Global · no offset",
  "transparency": "3-5 words. e.g. Self-reported · thin",
  "verdict_tag": "5-8 words. The take. e.g. Safe default. Not leading.",
  "scope3_text": "1 sentence. Everything upstream — where the real footprint hides.",
  "sustainability_url": "URL to brand's official sustainability page, or null if unknown",
  "tips": ["1 sentence, 12 words max. Real, useful. Max 2 items."],
  "better_path": "1-2 sentences. What genuinely better looks like in this category. Specific and real — name formats, certs, sourcing models, or actual brands. Sets the ceiling so this score stays honest."
}`;

// ─── Comparison System Prompt ─────────────────────────────────────────────────

const COMPARE_SYSTEM_PROMPT = `You are the GreenSpecs product comparison voice. Your job is to help a busy shopper compare up to 3 products side by side in seconds. Write like a sharp, trustworthy friend in the aisle who knows the real story and says it fast. The user should feel more confident, not more overwhelmed.

CORE GOAL: Give the real information in a quick, clear, urban-pragmatic voice that works especially well for busy moms, everyday shoppers, and people making fast decisions. Be plainspoken, useful, and honest. Never sound academic, corporate, preachy, or self-important.

VOICE RULES:
- Short, punchy sentences.
- No fluff. No ESG jargon.
- If technical concepts matter, translate them into normal human language.
- Never make the shopper feel dumb. Never overclaim certainty.
- Sound smart, grounded, fast, and real.
- Slight edge is okay. Snark is okay in tiny amounts. Mean is not okay.
- Avoid breathless hype.
- NO EMOJIS. Ever. Not a single one. Plain text only in every field.

GOOD TONE EXAMPLES:
"Good, not great." | "Looks clean, but the story is thin." | "Better packaging. Murky sourcing."
"This is the one you grab and move on." | "Paying extra for branding here." | "Trying, but not leading."

BAD TONE EXAMPLES:
"This product demonstrates moderate sustainability performance."
"This company is committed to a better future."

SCORING LENS (hidden — translate into plain language):
1. Packaging  2. Ingredients / materials  3. Transport / footprint signals
4. Transparency  5. Certifications / third-party credibility  6. Greenwashing risk

RELATIVE LABELS: Best in class · Above average · Middle of the pack · Weak for the category · Mostly marketing

WHEN INFORMATION IS LIMITED: say so, downgrade confidence, reward transparency, penalize vagueness. Do not invent facts.

BEGINNER-FIRST TRANSLATION: "Packaging" not "packaging lifecycle emissions". "They actually show proof" not "disclosure quality is high".`;

// ─── Auth Helpers ─────────────────────────────────────────────────────────────

async function hashPassword(password: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: new TextEncoder().encode(salt), iterations: 100000, hash: 'SHA-256' },
    key, 256
  );
  return Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2,'0')).join('');
}

// ─── Gemini Flash Analysis ────────────────────────────────────────────────────

// Phase 1: Web research with Google Search grounding
async function researchWithGemini(
  apiKey: string,
  brand: string,
  productName: string,
  category: string,
  claim: string,
): Promise<{ researchText: string; cost: number }> {
  const query = `Quick sustainability facts for "${productName}" by ${brand}:
1. Any published ESG metrics (carbon, certifications, recycled content)?
2. Does "${claim}" have a verified standard behind it, or is it self-declared?
3. Who leads ${category} sustainability and what sets them apart?
Be brief and factual. Numbers with sources only.`;

  const controller = new AbortController();
  const abort = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: query }] }],
          tools: [{ google_search: {} }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 800 },
        }),
      }
    );

    if (!response.ok) {
      console.error('Research phase failed:', response.status, await response.text());
      return { researchText: '', cost: 0 };
    }

    const data = await response.json() as {
      candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
      usageMetadata?: { promptTokenCount: number; candidatesTokenCount: number };
    };

    const researchText = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const inputTokens = data.usageMetadata?.promptTokenCount ?? 400;
    const outputTokens = data.usageMetadata?.candidatesTokenCount ?? 600;
    const cost = (inputTokens / 1_000_000) * 0.10 + (outputTokens / 1_000_000) * 0.40;

    return { researchText, cost };
  } catch (err) {
    // AbortError = timed out, any other error — skip research, don't block scoring
    return { researchText: '', cost: 0 };
  } finally {
    clearTimeout(abort);
  }
}

// Phase 2: Structured JSON analysis (with research context injected)
async function analyzeWithGemini(
  apiKey: string,
  productName: string,
  claim: string,
  imageBase64?: string,
  mediaType?: string,
  researchContext?: string,
): Promise<{ result: Record<string, unknown>; cost: number }> {

  const parts: unknown[] = [];

  if (imageBase64 && mediaType) {
    parts.push({ inline_data: { mime_type: mediaType, data: imageBase64 } });
  }
  parts.push({ text: ANALYSIS_PROMPT(productName, claim, !!imageBase64, researchContext) });

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts }],
        generationConfig: { temperature: 0.3, response_mime_type: 'application/json', maxOutputTokens: 1200, thinkingConfig: { thinkingBudget: 0 } },
      }),
    }
  );

  if (!response.ok) throw new Error(`Gemini API error: ${await response.text()}`);

  const data = await response.json() as {
    candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
    usageMetadata?: { promptTokenCount: number; candidatesTokenCount: number };
  };

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const result = JSON.parse(clean);

  const inputTokens = data.usageMetadata?.promptTokenCount ?? 500;
  const outputTokens = data.usageMetadata?.candidatesTokenCount ?? 400;
  const cost = (inputTokens / 1_000_000) * 0.10 + (outputTokens / 1_000_000) * 0.40;

  return { result, cost };
}

// Comparison agent — single Gemini Flash call
async function compareWithGemini(
  apiKey: string,
  products: Array<{ id: string; name: string; brand: string; score: number; letter_grade: string; claim: string; headline: string | null; win: string | null; tradeoff: string | null; packaging: string | null; ingredients: string | null; transparency: string | null; verdict_tag: string | null }>,
): Promise<{ result: Record<string, unknown>; cost: number }> {

  const productLines = products.map((p, i) =>
    `Product ${i + 1}:
  id: "${p.id}"
  name: "${p.name}"
  brand: "${p.brand}"
  score: ${p.score}/100 (${p.letter_grade})
  claim: "${p.claim}"
  ${p.headline ? `headline: "${p.headline}"` : ''}
  ${p.win ? `win: "${p.win}"` : ''}
  ${p.tradeoff ? `tradeoff: "${p.tradeoff}"` : ''}
  ${p.packaging ? `packaging: "${p.packaging}"` : ''}
  ${p.ingredients ? `ingredients: "${p.ingredients}"` : ''}
  ${p.transparency ? `transparency: "${p.transparency}"` : ''}
  ${p.verdict_tag ? `verdict_tag: "${p.verdict_tag}"` : ''}`
  ).join('\n\n');

  const prompt = `Compare these ${products.length} products for a shopper who needs the fast truth right now.

${productLines}

Return ONLY valid JSON, no markdown:
{
  "overall_verdict": "One punchy line. The fast truth about this whole comparison.",
  "products": [
    {
      "id": "exact product id from input",
      "headline": "2-5 words. Punchy label.",
      "packaging": "very short verdict",
      "ingredients": "very short verdict",
      "transparency": "very short verdict",
      "takeaway": "One sentence. Fast and useful."
    }
  ],
  "winner_id": "id of best product",
  "why_it_wins": "1-2 sentences. Why this one.",
  "watch_out": "One sentence. The key compromise even for the winner.",
  "good_enough": "product name or null — the decent fallback",
  "looks_greener": "product name or null — the one that talks bigger than it acts",
  "confidence": "One sentence. Honest note if proof was thin."
}`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: COMPARE_SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, response_mime_type: 'application/json' },
      }),
    }
  );

  if (!response.ok) throw new Error(`Gemini compare error: ${await response.text()}`);

  const data = await response.json() as {
    candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
    usageMetadata?: { promptTokenCount: number; candidatesTokenCount: number };
  };

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const result = JSON.parse(clean);

  const inputTokens = data.usageMetadata?.promptTokenCount ?? 600;
  const outputTokens = data.usageMetadata?.candidatesTokenCount ?? 400;
  const cost = (inputTokens / 1_000_000) * 0.10 + (outputTokens / 1_000_000) * 0.40;

  return { result, cost };
}

// Learn: two-phase Gemini Q&A with Google Search grounding
async function learnWithGemini(
  apiKey: string,
  question: string,
): Promise<{ answer: Record<string, unknown>; cost: number }> {

  const searchQuery = `Research this sustainability question with facts and sources: "${question}"

Please find:
1. The scientific or factual answer with specific numbers and studies
2. Key factors that determine the environmental impact
3. Common misconceptions people have about this topic
4. The most credible sources and certifications relevant to this
5. Context-dependent factors — geography, use case, scale

Be specific. Include real data and numbers where available.`;

  let researchText = '';
  let totalCost = 0;

  // Phase 1: Google Search grounding
  try {
    const r1 = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: searchQuery }] }],
          tools: [{ google_search: {} }],
          generationConfig: { temperature: 0.1 },
        }),
      }
    );
    if (r1.ok) {
      const d1 = await r1.json() as {
        candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
        usageMetadata?: { promptTokenCount: number; candidatesTokenCount: number };
      };
      researchText = d1.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      const t1 = d1.usageMetadata;
      totalCost += ((t1?.promptTokenCount ?? 400) / 1_000_000) * 0.10 + ((t1?.candidatesTokenCount ?? 600) / 1_000_000) * 0.40;
    }
  } catch (err) {
    console.error('Learn search phase error:', err);
  }

  // Phase 2: Structure into JSON
  const structurePrompt = `You are a warm sustainability educator. Based on this web research:
${researchText || 'Use your general knowledge about: ' + question}

Question: "${question}"

Return ONLY valid JSON (no markdown):
{
  "question": "the question restated clearly",
  "summary": "2-3 warm plain-language sentences giving the honest answer. Start with the direct answer, not hedging.",
  "bottom_line": "One clear practical sentence. What should someone actually do or know?",
  "dimensions": [
    {
      "label": "e.g. Carbon footprint",
      "detail": "e.g. Glass requires 6x more energy to manufacture per unit compared to plastic — but it is reusable indefinitely",
      "verdict": "better|worse|depends"
    }
  ],
  "nuance": "1-2 sentences about what makes this complicated — context, scale, geography, end-of-life.",
  "best_choice_guide": "Practical paragraph: when is each option actually the better choice? Give concrete scenarios.",
  "related_questions": ["3-4 related sustainability questions to explore next"],
  "sources": ["URLs from the research above, if any"]
}`;

  const r2 = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: structurePrompt }] }],
        generationConfig: { temperature: 0.2, response_mime_type: 'application/json' },
      }),
    }
  );

  if (!r2.ok) throw new Error(`Learn structure error: ${await r2.text()}`);

  const d2 = await r2.json() as {
    candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
    usageMetadata?: { promptTokenCount: number; candidatesTokenCount: number };
  };

  const text = d2.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
  const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const answer = JSON.parse(clean);

  const t2 = d2.usageMetadata;
  totalCost += ((t2?.promptTokenCount ?? 500) / 1_000_000) * 0.10 + ((t2?.candidatesTokenCount ?? 400) / 1_000_000) * 0.40;

  return { answer, cost: totalCost };
}

// ─── Swaps Generation ─────────────────────────────────────────────────────────

async function generateSwapsWithGemini(
  apiKey: string,
  scan: ScanRow,
): Promise<Array<{ name: string; brand: string; why_better: string; estimated_score: number }>> {
  const cat = scan.category || 'general';
  const weaknesses = [scan.what_missing, scan.better_alternatives]
    .filter(Boolean)
    .map(s => { try { return JSON.parse(s!).slice(0,2).join(', '); } catch { return s; } })
    .filter(Boolean).join('; ');

  const prompt = `A shopper just scanned: "${scan.product_name}" by ${scan.brand || 'unknown brand'}.
Category: ${cat}
Score: ${scan.score}/100
Key gaps: ${weaknesses || 'not specified'}
${scan.better_alternatives ? 'Better path hint: ' + scan.better_alternatives : ''}

Suggest 2-3 specific real products that are meaningfully better in this category and widely available (Whole Foods, Target, Amazon, mainstream grocery).
Each should score at least 10 points higher than ${scan.score}/100.
Give one sharp reason per swap — what specifically makes it better.

Return ONLY valid JSON:
{
  "swaps": [
    {
      "name": "exact product name",
      "brand": "brand name",
      "why_better": "One sentence, under 20 words. Specific improvement only.",
      "estimated_score": 65
    }
  ]
}`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          response_mime_type: 'application/json',
          maxOutputTokens: 600,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    }
  );

  if (!res.ok) throw new Error(`Gemini swaps error: ${res.status}`);

  const data = await res.json() as {
    candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
  };

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
  const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const result = JSON.parse(clean);
  return (result.swaps || []).slice(0, 3);
}

// ─── App ──────────────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors({
  origin: ['https://greenspecs.app', 'http://localhost:3000', 'http://localhost:8787'],
}));


// ─── PWA ─────────────────────────────────────────────────────────────────────

const PWA_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#1B4332">
<title>GreenSpecs</title>
<link rel="manifest" href="/manifest.json">
<link rel="apple-touch-icon" href="/icon.svg">
<style>
:root{
  --forest:#1B4332;--moss:#2D6A4F;--sage:#52B788;--mint:#95D5B2;--pale:#D8F3DC;
  --cream:#F8F6F2;--warm:#EDE8DF;--card:#fff;
  --amber:#F59E0B;--amber-bg:#FFFBEB;
  --red:#DC2626;--red-bg:#FEF2F2;
  --text:#1C2B22;--text-mid:#5A6B62;--text-light:#9DB0A0;
  --shadow:0 2px 14px rgba(27,67,50,0.08);
  --shadow-md:0 6px 28px rgba(27,67,50,0.13);
  --safe-top:env(safe-area-inset-top,0px);
  --safe-bottom:env(safe-area-inset-bottom,0px);
}
*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{height:100%;overflow:hidden;background:#000}
body{font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;color:var(--text)}
.app{position:fixed;inset:0;max-width:430px;margin:0 auto;background:var(--cream)}

/* ── SCREENS ── */
.screen{position:absolute;inset:0;display:flex;flex-direction:column;overflow:hidden;
  background:var(--cream)}
.screen.hidden{display:none}
.scrollable{flex:1;overflow-y:auto;scrollbar-width:none;
  padding-bottom:calc(90px + var(--safe-bottom))}
.scrollable::-webkit-scrollbar{display:none}

/* ── HOME SCREEN ── */
#s-home{background:var(--cream);overflow:hidden}
.home-topbar{display:flex;align-items:center;justify-content:space-between;
  padding:calc(var(--safe-top) + 14px) 18px 14px;background:var(--cream);
  border-bottom:1px solid var(--warm);flex-shrink:0;position:relative;z-index:10}
.home-hamburger{width:40px;height:40px;display:flex;flex-direction:column;align-items:center;
  justify-content:center;gap:5px;cursor:pointer;border:none;background:none;padding:4px;flex-shrink:0}
.home-hamburger span{display:block;width:22px;height:2px;background:var(--forest);border-radius:2px;transition:all 0.2s}
.home-logo{font-family:system-ui,-apple-system,sans-serif;font-size:20px;font-weight:700;color:var(--forest);letter-spacing:-0.3px}
.home-logo em{color:var(--sage);font-style:normal}
.home-user-btn{width:34px;height:34px;border-radius:50%;background:var(--warm);border:none;
  display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;overflow:hidden}
.home-user-btn svg{width:18px;height:18px;stroke:var(--moss);fill:none;stroke-width:1.8}
.home-user-btn img{width:34px;height:34px;object-fit:cover}

/* hero */
.home-hero{padding:40px 28px 32px;display:flex;flex-direction:column;align-items:center;text-align:center}
.home-tagline{font-family:system-ui,-apple-system,sans-serif;font-size:32px;font-weight:700;color:var(--forest);
  line-height:1.18;letter-spacing:-0.5px;margin-bottom:10px}
.home-tagline em{color:var(--sage);font-style:italic}
.home-sub{font-size:16px;color:var(--text);line-height:1.6;max-width:290px;margin-bottom:8px;font-weight:500}
.home-sub2{font-size:15px;color:var(--text-mid);line-height:1.65;max-width:290px;margin-bottom:32px}

/* scan button */
.scan-btn{width:100%;max-width:300px;padding:20px 24px;border-radius:24px;
  background:linear-gradient(135deg,var(--forest),var(--moss));
  border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:14px;
  box-shadow:0 8px 32px rgba(27,67,50,0.28);transition:transform 0.14s,box-shadow 0.14s;
  -webkit-tap-highlight-color:transparent}
.scan-btn:active{transform:scale(0.96);box-shadow:0 4px 16px rgba(27,67,50,0.22)}
.scan-btn-icon{width:48px;height:48px;border-radius:50%;background:rgba(255,255,255,0.15);
  display:flex;align-items:center;justify-content:center;flex-shrink:0}
.scan-btn-icon svg{width:26px;height:26px;stroke:white;fill:none;stroke-width:1.8}
.scan-btn-text{text-align:left}
.scan-btn-label{font-family:system-ui,-apple-system,sans-serif;font-size:18px;font-weight:600;color:white;line-height:1.2}
.scan-btn-hint{font-size:11px;color:rgba(255,255,255,0.65);margin-top:2px}
.type-link{margin-top:14px;font-size:13px;color:var(--text-light);cursor:pointer;
  text-decoration:underline;text-underline-offset:2px;padding:8px}

/* recent strip */
.home-section{padding:0 18px 16px}
.home-section-title{font-size:13px;text-transform:uppercase;letter-spacing:0.5px;
  color:var(--text-light);font-weight:600;margin-bottom:12px}
.recent-strip{display:flex;gap:10px;overflow-x:auto;scrollbar-width:none;padding-bottom:4px}
.recent-strip::-webkit-scrollbar{display:none}
.recent-chip{flex-shrink:0;background:white;border-radius:14px;padding:10px 14px;
  box-shadow:var(--shadow);cursor:pointer;min-width:140px;border:1px solid var(--warm)}
.recent-chip-name{font-size:14px;font-weight:500;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:120px}
.recent-chip-grade{display:inline-block;font-size:12px;font-weight:700;margin-top:4px;padding:2px 8px;border-radius:20px;background:var(--pale);color:var(--forest)}
.home-empty{text-align:center;padding:20px;color:var(--text-light);font-size:13px}

/* stats bar */
.home-stats-bar{margin:0 18px 20px;background:white;border-radius:16px;padding:14px 18px;
  box-shadow:var(--shadow);display:flex;align-items:center;gap:12px}
.home-stats-icon{width:36px;height:36px;border-radius:50%;background:var(--pale);
  display:flex;align-items:center;justify-content:center;flex-shrink:0}
.home-stats-icon svg{width:18px;height:18px;stroke:var(--moss);fill:none;stroke-width:1.8}
.home-stats-text{font-size:14px;color:var(--text-mid);line-height:1.5}
.home-stats-text strong{color:var(--forest)}

/* ── ANALYZING OVERLAY ── */
.analyzing{position:fixed;inset:0;background:linear-gradient(160deg,var(--forest),var(--moss));
  display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:9999;gap:16px}
.analyzing.hidden{display:none}
.spin{width:52px;height:52px;border-radius:50%;border:3px solid rgba(255,255,255,0.15);
  border-top-color:var(--mint);animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.an-title{font-family:system-ui,-apple-system,sans-serif;font-size:24px;color:white;font-weight:600}
.an-sub{font-size:15px;color:rgba(255,255,255,0.55);letter-spacing:0.3px;text-align:center;max-width:240px}
.an-phases{display:flex;flex-direction:column;gap:8px;margin-top:6px}
.an-phase{font-size:14px;color:rgba(255,255,255,0.35);letter-spacing:0.3px;display:flex;align-items:center;gap:6px;transition:all 0.4s}
.an-phase.active{color:rgba(255,255,255,0.9)}.an-phase.done{color:var(--mint)}
.an-phase-dot{width:5px;height:5px;border-radius:50%;background:currentColor;flex-shrink:0}
.dots{display:flex;gap:8px}
.dot{width:7px;height:7px;border-radius:50%;background:rgba(255,255,255,0.2);animation:pulse 1.4s ease-in-out infinite}
.dot:nth-child(2){animation-delay:.2s}.dot:nth-child(3){animation-delay:.4s}
@keyframes pulse{0%,80%,100%{opacity:.2;transform:scale(1)}40%{opacity:1;transform:scale(1.3);background:var(--mint)}}

/* ── RESEARCH CARD ── */
.research-card{background:linear-gradient(135deg,#F0F9F4,#EDF7F1);border:1px solid rgba(82,183,136,0.2)}
.research-header{display:flex;align-items:center;gap:8px;margin-bottom:14px}
.research-icon{width:32px;height:32px;border-radius:50%;background:linear-gradient(135deg,var(--moss),var(--sage));
  display:flex;align-items:center;justify-content:center;font-size:15px;flex-shrink:0}
.research-title{font-family:system-ui,-apple-system,sans-serif;font-size:15px;font-weight:600;color:var(--forest)}
.web-badge{margin-left:auto;font-size:12px;color:var(--moss);background:rgba(82,183,136,0.12);
  padding:3px 9px;border-radius:20px;font-weight:500;white-space:nowrap}
.metric-row{display:flex;align-items:baseline;gap:8px;padding:8px 0;
  border-bottom:1px solid rgba(82,183,136,0.12)}
.metric-row:last-child{border-bottom:none}
.metric-label{font-size:13px;color:var(--text-light);text-transform:uppercase;letter-spacing:0.3px;flex:0 0 auto;width:110px}
.metric-value{font-size:17px;color:var(--forest);font-weight:500;flex:1}
.metric-source{font-size:13px;color:var(--text-light);font-style:italic}
.claim-reality{font-size:17px;color:var(--text-mid);line-height:1.6;padding:10px 0}
.industry-best-block{background:rgba(27,67,50,0.05);border-radius:10px;padding:12px;margin:8px 0}
.industry-best-label{font-size:12px;text-transform:uppercase;letter-spacing:0.4px;color:var(--moss);font-weight:600;margin-bottom:6px}
.industry-best-text{font-size:17px;color:var(--text);line-height:1.6}
.level-up-list{margin-top:4px}
.level-up-item{display:flex;gap:8px;font-size:17px;color:var(--text-mid);padding:8px 0;
  border-bottom:1px solid rgba(82,183,136,0.1);line-height:1.55}
.level-up-item:last-child{border-bottom:none}
.level-up-arrow{color:var(--sage);flex-shrink:0;font-weight:bold}
.sources-row{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.source-link{font-size:10px;color:var(--moss);background:rgba(82,183,136,0.1);
  padding:2px 8px;border-radius:20px;text-decoration:none;white-space:nowrap;overflow:hidden;
  max-width:150px;text-overflow:ellipsis}

/* ── BOTTOM NAV ── */
.nav{position:fixed;bottom:0;left:0;right:0;max-width:430px;margin:0 auto;
  background:rgba(248,246,242,0.95);backdrop-filter:blur(20px);
  display:flex;justify-content:space-around;align-items:center;
  padding:8px 0 calc(10px + var(--safe-bottom));
  border-top:1px solid rgba(82,183,136,0.12);z-index:200}
.nav-item{display:flex;flex-direction:column;align-items:center;gap:3px;
  cursor:pointer;padding:4px 14px;font-size:12px;font-weight:500;
  color:var(--text-light);transition:color 0.2s;letter-spacing:0.2px;text-transform:uppercase}
.nav-item.active{color:var(--moss)}
.nav-item svg{width:22px;height:22px;stroke:currentColor;fill:none;stroke-width:2;transition:stroke 0.2s}
.nav-scan{width:56px;height:56px;border-radius:50%;
  background:linear-gradient(135deg,var(--moss),var(--sage));
  display:flex;align-items:center;justify-content:center;
  cursor:pointer;margin-top:-22px;box-shadow:0 4px 20px rgba(45,106,79,0.45);
  border:4px solid var(--cream);transition:transform 0.15s}
.nav-scan:active{transform:scale(0.93)}
.nav-scan svg{width:24px;height:24px;stroke:white;fill:none;stroke-width:2.5}
.nav-item.compare-tab{color:#BA7517;font-weight:500}
.nav-item.compare-tab svg{stroke:#BA7517}
.cmp-nav-pill{background:#FAEEDA;border-radius:10px;padding:5px 7px;display:inline-flex;align-items:center;justify-content:center;margin-bottom:1px}

/* ── DRAWER ── */
.drawer-overlay{position:fixed;inset:0;background:rgba(0,0,0,0);z-index:400;
  pointer-events:none;transition:background 0.25s}
.drawer-overlay.open{background:rgba(0,0,0,0.5);pointer-events:all}
.drawer{position:fixed;top:0;left:0;bottom:0;width:78%;max-width:310px;
  background:var(--forest);z-index:401;transform:translateX(-100%);
  transition:transform 0.28s cubic-bezier(0.4,0,0.2,1);
  display:flex;flex-direction:column;padding-top:var(--safe-top)}
.drawer.open{transform:translateX(0)}
.drawer-head{padding:28px 24px 22px;border-bottom:1px solid rgba(255,255,255,0.08)}
.drawer-brand{font-family:system-ui,-apple-system,sans-serif;font-size:24px;font-weight:700;color:white;line-height:1}
.drawer-brand em{color:var(--mint);font-style:normal}
.drawer-tagline{font-size:13px;color:rgba(255,255,255,0.45);margin-top:5px;font-style:italic}
.drawer-nav{flex:1;padding:8px 0;overflow-y:auto}
.d-item{display:flex;align-items:center;gap:14px;padding:15px 24px;cursor:pointer;
  border:none;background:none;width:100%;text-align:left;font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;
  transition:background 0.15s}
.d-item:active{background:rgba(255,255,255,0.06)}
.d-item svg{width:20px;height:20px;stroke:rgba(255,255,255,0.5);fill:none;stroke-width:2;flex-shrink:0}
.d-item span{font-size:16px;font-weight:500;color:rgba(255,255,255,0.78);letter-spacing:0.2px}
.d-item.active svg{stroke:var(--mint)}
.d-item.active span{color:white}
.d-divider{height:1px;background:rgba(255,255,255,0.07);margin:5px 0}
.drawer-foot{padding:18px 24px calc(18px + var(--safe-bottom));border-top:1px solid rgba(255,255,255,0.08)}
.drawer-foot-text{font-size:12px;color:rgba(255,255,255,0.28);line-height:1.7}

/* ── TOPBAR (for non-camera screens) ── */
.topbar{display:flex;align-items:center;justify-content:space-between;
  padding:calc(var(--safe-top) + 10px) 16px 10px;flex-shrink:0;background:var(--cream)}
.topbar-menu{width:40px;height:40px;border-radius:12px;background:var(--card);
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:5px;cursor:pointer;box-shadow:var(--shadow)}
.topbar-menu span{display:block;width:18px;height:2px;background:var(--text);border-radius:2px}
.topbar-title{font-family:system-ui,-apple-system,sans-serif;font-size:19px;font-weight:700;color:var(--forest)}
.topbar-title em{color:var(--sage);font-style:normal}
.topbar-right{width:40px;height:40px;border-radius:50%;background:var(--pale);
  display:flex;align-items:center;justify-content:center;cursor:pointer}
.topbar-right svg{width:18px;height:18px;stroke:var(--moss);fill:none;stroke-width:2}

/* ── RESULT SCREEN ── */
.result-hero{background:linear-gradient(155deg,var(--forest) 0%,var(--moss) 100%);
  padding:calc(var(--safe-top) + 48px) 20px 28px;position:relative;flex-shrink:0;text-align:center}
.r-back{position:absolute;top:calc(var(--safe-top) + 12px);left:14px;
  width:36px;height:36px;border-radius:50%;background:rgba(255,255,255,0.12);
  display:flex;align-items:center;justify-content:center;cursor:pointer}
.r-back svg{width:18px;height:18px;stroke:white;fill:none;stroke-width:2.5}
.r-compare-btn{position:absolute;top:calc(var(--safe-top) + 12px);right:14px;
  background:rgba(255,255,255,0.12);padding:7px 14px;border-radius:20px;
  font-size:11px;font-weight:600;color:white;cursor:pointer;
  border:1px solid rgba(255,255,255,0.15);letter-spacing:0.3px}
.grade-circle{width:90px;height:90px;border-radius:50%;background:rgba(255,255,255,0.12);
  border:3px solid rgba(255,255,255,0.25);display:flex;flex-direction:column;
  align-items:center;justify-content:center;margin:0 auto 14px}
.grade-letter{font-family:system-ui,-apple-system,sans-serif;font-size:42px;font-weight:700;color:white;line-height:1}
.grade-num{font-size:11px;color:rgba(255,255,255,0.5);margin-top:2px;letter-spacing:0.5px}
.r-name{font-family:system-ui,-apple-system,sans-serif;font-size:21px;font-weight:700;color:white;line-height:1.25;margin-bottom:4px}
.r-brand-cat{font-size:15px;color:rgba(255,255,255,0.6);margin-bottom:6px;letter-spacing:0.2px}
.r-yko-link{display:block;font-size:12px;color:var(--mint);opacity:0.8;text-decoration:none;
  margin-bottom:12px;letter-spacing:0.3px}
.r-yko-link:hover{opacity:1}
.r-pills{display:flex;align-items:center;justify-content:center;gap:8px;flex-wrap:wrap}
.rpill{background:rgba(255,255,255,0.1);padding:5px 12px;border-radius:20px;
  font-size:13px;color:rgba(255,255,255,0.75);font-weight:500;border:1px solid rgba(255,255,255,0.1)}
.r-body{flex:1;overflow-y:auto;scrollbar-width:none;
  padding-bottom:calc(90px + var(--safe-bottom))}
.r-body::-webkit-scrollbar{display:none}

/* ── CARDS ── */
.card{background:var(--card);margin:10px 14px;border-radius:22px;padding:16px 18px;box-shadow:var(--shadow)}
.card-label{font-size:13px;font-weight:600;color:var(--text-light);text-transform:uppercase;
  letter-spacing:1.2px;margin-bottom:12px}
.verdict-text{font-size:17px;color:var(--text-mid);line-height:1.75}

/* rubric bars */
.rbar{margin-bottom:12px}
.rbar:last-child{margin-bottom:0}
.rbar-row{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:5px}
.rbar-label{font-size:17px;font-weight:600;color:var(--text)}
.rbar-sub{font-size:13px;color:var(--text-light);font-weight:400;margin-left:4px}
.rbar-val{font-size:17px;font-weight:700}
.rbar-track{height:6px;background:var(--warm);border-radius:6px;overflow:hidden}
.rbar-fill{height:100%;border-radius:6px;transition:width 1s cubic-bezier(0.4,0,0.2,1)}

/* voice card */
.voice-card{background:var(--forest);margin:0 14px 10px;border-radius:22px;padding:18px}
.voice-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
.voice-label{font-size:12px;font-weight:600;letter-spacing:1.2px;color:var(--mint);
  text-transform:uppercase;display:flex;align-items:center;gap:5px}
.voice-play{width:32px;height:32px;border-radius:50%;background:rgba(255,255,255,0.1);
  display:flex;align-items:center;justify-content:center;cursor:pointer;
  border:1px solid rgba(255,255,255,0.15)}
.voice-play svg{width:12px;height:12px;fill:white}
.voice-play.playing{background:rgba(149,213,178,0.25);border-color:var(--mint)}
.voice-body{font-size:17px;color:rgba(255,255,255,0.85);line-height:1.75}

/* scope */
.scope-row{display:flex;gap:12px;align-items:flex-start;margin-bottom:13px}
.scope-row:last-child{margin-bottom:0}
.scope-bub{min-width:32px;height:32px;border-radius:10px;display:flex;align-items:center;
  justify-content:center;font-size:10px;font-weight:800;font-family:system-ui,-apple-system,sans-serif;flex-shrink:0}
.s1{background:#e8f5e9;color:#1b5e20}.s2{background:#fff8e1;color:#e65100}.s3{background:#fce4ec;color:#b71c1c}
.scope-name{font-size:17px;font-weight:600;color:var(--text);margin-bottom:2px}
.scope-desc{font-size:15px;color:var(--text-mid);line-height:1.65}

/* chips */
.chips-wrap{padding:0 14px;margin-bottom:10px}
.chips-title{font-size:13px;font-weight:600;color:var(--text-light);text-transform:uppercase;
  letter-spacing:1.0px;margin-bottom:10px}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.chip{padding:9px 15px;border-radius:22px;font-size:15px;font-weight:500;line-height:1.35}
.chip.g{background:var(--pale);color:var(--moss)}
.chip.a{background:var(--amber-bg);color:#92400e}
.chip.r{background:var(--red-bg);color:var(--red)}

/* action row */
.action-row{display:flex;gap:10px;padding:8px 14px 16px}
.action-btn{flex:1;padding:13px 10px;border-radius:16px;font-size:13px;font-weight:600;
  cursor:pointer;font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;border:none;
  display:flex;align-items:center;justify-content:center;gap:7px;transition:opacity 0.2s}
.action-btn:active{opacity:0.8}
.action-btn.primary{background:var(--forest);color:white}
.action-btn.secondary{background:var(--card);color:var(--text);border:1.5px solid var(--warm)}

/* ── NEW RESULT CARDS ── */
.gs-headline{font-family:system-ui,-apple-system,sans-serif;font-size:26px;font-weight:700;color:var(--forest);
  line-height:1.2;padding:20px 18px 4px;letter-spacing:-0.3px}
.quick-view{padding:14px 18px}
.qv-row{display:flex;justify-content:space-between;align-items:baseline;
  padding:9px 0;border-bottom:1px solid var(--warm)}
.qv-row:last-of-type{border-bottom:none}
.qv-label{font-size:13px;font-weight:600;color:var(--text-mid);text-transform:uppercase;letter-spacing:0.8px}
.qv-val{font-size:16px;color:var(--forest);font-weight:500;text-align:right;max-width:60%}
.qv-verdict{margin-top:14px;font-size:17px;font-weight:700;color:var(--moss);
  padding-top:12px;border-top:2px solid var(--sage)}
.why-text{font-size:17px;color:var(--text-mid);line-height:1.65;margin-bottom:14px}
.win-trade{display:flex;gap:10px;margin-top:4px}
.wt-block{flex:1;border-radius:14px;padding:12px 14px}
.wt-win{background:var(--pale)}
.wt-trade{background:var(--amber-bg)}
.wt-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;
  margin-bottom:6px;color:var(--text-light)}
.wt-win .wt-label{color:var(--moss)}
.wt-trade .wt-label{color:#92400e}
.wt-text{font-size:15px;line-height:1.55;color:var(--text)}
.compare-hook{margin:0 14px 10px;padding:14px 16px;background:var(--forest);
  border-radius:16px;font-size:16px;color:rgba(255,255,255,0.9);line-height:1.5;
  font-style:italic}
.better-path-card{border-left:3px solid var(--amber);background:var(--amber-bg)}
.better-path-text{font-size:17px;color:var(--text);line-height:1.7}

/* ── MY SCANS ── */
.scans-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;padding:16px}
.sg-item{display:flex;flex-direction:column;align-items:center;gap:7px;cursor:pointer}
.sg-circ{width:78px;height:78px;border-radius:50%;position:relative}
.sg-bg{width:78px;height:78px;border-radius:50%;background:var(--pale);
  display:flex;align-items:center;justify-content:center;
  border:3px solid var(--card);box-shadow:var(--shadow)}
.sg-bg svg{width:32px;height:32px;stroke:var(--sage);fill:none;stroke-width:1.5}
.sg-grade{position:absolute;bottom:-3px;right:-3px;width:26px;height:26px;border-radius:50%;
  display:flex;align-items:center;justify-content:center;
  font-size:9px;font-weight:800;font-family:system-ui,-apple-system,sans-serif;
  border:2.5px solid var(--cream)}
.sg-name{font-size:10px;font-weight:600;color:var(--text);text-align:center;
  line-height:1.3;width:88px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* ── COMPARE ── */
.compare-summary{background:var(--forest);margin:12px 14px;border-radius:22px;padding:16px 18px}
.cs-label{font-size:10px;font-weight:600;letter-spacing:1.5px;color:var(--mint);text-transform:uppercase;margin-bottom:6px}
.cs-text{font-size:15px;color:rgba(255,255,255,0.92);line-height:1.65;font-weight:500}
.cmp-item{background:var(--card);margin:0 14px 10px;border-radius:22px;padding:14px 16px;
  cursor:pointer;box-shadow:var(--shadow);position:relative}
.cmp-item.winner{border:2px solid var(--sage)}
.winner-badge{position:absolute;top:-1px;left:50%;transform:translateX(-50%);
  background:var(--sage);color:white;font-size:9px;font-weight:700;
  padding:2px 10px;border-radius:0 0 8px 8px;letter-spacing:0.5px;text-transform:uppercase}
.cmp-top{display:flex;align-items:center;gap:12px;margin-bottom:10px}
.cmp-grade{width:48px;height:48px;border-radius:14px;display:flex;flex-direction:column;
  align-items:center;justify-content:center;flex-shrink:0}
.cmp-grade-letter{font-family:system-ui,-apple-system,sans-serif;font-size:20px;font-weight:700;line-height:1}
.cmp-grade-num{font-size:9px;opacity:0.7}
.cmp-info{flex:1;min-width:0}
.cmp-name{font-size:14px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cmp-ai-headline{font-size:13px;color:var(--moss);font-weight:600;margin-top:2px}
.cmp-brand{font-size:10px;color:var(--text-light);margin-bottom:3px}
.cmp-rows{border-top:1px solid var(--warm);padding-top:8px;display:flex;flex-direction:column;gap:4px}
.cmp-row{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
.cmp-row-label{font-size:11px;font-weight:600;color:var(--text-light);text-transform:uppercase;letter-spacing:0.7px;flex-shrink:0}
.cmp-row-val{font-size:13px;color:var(--text);text-align:right}
.cmp-takeaway{margin-top:8px;font-size:14px;color:var(--text-mid);line-height:1.55;font-style:italic}
.cmp-winner-box{background:var(--pale);margin:0 14px 10px;border-radius:18px;padding:14px 16px}
.cwb-label{font-size:10px;font-weight:700;letter-spacing:1.2px;color:var(--moss);text-transform:uppercase;margin-bottom:4px}
.cwb-name{font-family:system-ui,-apple-system,sans-serif;font-size:17px;font-weight:700;color:var(--forest);margin-bottom:4px}
.cwb-why{font-size:14px;color:var(--text-mid);line-height:1.55}
.cmp-watchout{background:var(--amber-bg);margin:0 14px 10px;border-radius:18px;padding:12px 16px}
.cwo-label{font-size:10px;font-weight:700;letter-spacing:1.2px;color:#92400e;text-transform:uppercase;margin-bottom:4px}
.cwo-text{font-size:14px;color:var(--text);line-height:1.5}
.cmp-confidence{margin:0 14px 6px;padding:10px 14px;background:var(--warm);border-radius:14px;
  font-size:12px;color:var(--text-light);line-height:1.55;font-style:italic}
.cmp-loading{padding:60px 20px;text-align:center}
.cmp-loading-spin{width:32px;height:32px;border:3px solid var(--warm);border-top-color:var(--forest);
  border-radius:50%;animation:spin 0.8s linear infinite;margin:0 auto 14px}
.cmp-loading-text{font-size:14px;color:var(--text-light)}

/* ── COMPARE SNAP ── */
.cmp-snap-hero{padding:40px 24px 28px;text-align:center}
.cmp-snap-title{font-size:22px;font-weight:700;color:var(--forest);margin-bottom:6px}
.cmp-snap-sub{font-size:14px;color:var(--text-mid);margin-bottom:28px;line-height:1.6}
.cmp-snap-btn{display:inline-flex;align-items:center;gap:10px;background:var(--forest);color:white;border:none;border-radius:16px;padding:14px 26px;font-size:15px;font-weight:600;cursor:pointer;box-shadow:0 4px 16px rgba(27,67,50,0.3)}
.cmp-snap-btn:active{opacity:0.85}
.cmp-snap-btn svg{width:20px;height:20px;stroke:white;fill:none;stroke-width:2}
.cmp-cards-wrap{padding:0 14px;display:flex;flex-direction:column;gap:12px}
.cmp-card{background:white;border-radius:18px;padding:16px;box-shadow:0 2px 12px rgba(27,67,50,0.08)}
.cmp-card-name{font-size:16px;font-weight:700;color:var(--forest);margin-bottom:3px}
.cmp-card-brand{font-size:13px;color:var(--text-mid);margin-bottom:12px}
.cmp-card-rows{display:flex;flex-direction:column}
.cmp-card-row{display:flex;justify-content:space-between;align-items:flex-start;padding:9px 0;border-bottom:1px solid var(--warm)}
.cmp-card-row:last-child{border-bottom:none}
.cmp-card-row.winner{border-left:3px solid #1D9E75;margin-left:-16px;padding-left:13px}
.cmp-row-label{font-size:12px;font-weight:600;color:var(--text-mid);text-transform:uppercase;letter-spacing:0.6px;padding-top:1px}
.cmp-row-val-wrap{text-align:right;max-width:58%}
.cmp-row-val{font-size:14px;font-weight:600;color:var(--text)}
.cmp-row-val.clean{color:#1D9E75}
.cmp-row-val.mostly-clean{color:#5DCAA5}
.cmp-row-val.mixed{color:#F59E0B}
.cmp-row-val.avoid{color:#DC2626}
.cmp-row-val.high{color:#1D9E75}
.cmp-row-val.medium{color:#F59E0B}
.cmp-row-val.low{color:var(--text-mid)}
.cmp-row-val.minimal{color:var(--text-light)}
.cmp-row-note{font-size:11px;color:var(--text-light);margin-top:2px;line-height:1.4}
.cmp-snap-add{display:flex;align-items:center;justify-content:center;background:rgba(27,67,50,0.05);border-radius:14px;padding:14px;border:2px dashed rgba(27,67,50,0.15);cursor:pointer;gap:8px;font-size:14px;font-weight:600;color:var(--moss)}
.cmp-snap-add svg{width:18px;height:18px;stroke:var(--moss);fill:none;stroke-width:2.5}
.cmp-snap-add:active{opacity:0.7}
.cmp-summary-bar{margin:8px 14px 0;padding:14px 16px;background:var(--pale);border-radius:14px;font-size:15px;color:var(--forest);font-weight:500;line-height:1.55}
.cmp-summary-label{font-size:11px;font-weight:700;color:var(--moss);text-transform:uppercase;letter-spacing:0.8px;margin-bottom:5px}
.cmp-skeleton{background:white;border-radius:18px;padding:16px;box-shadow:0 2px 12px rgba(27,67,50,0.08)}
.sk-line{height:12px;border-radius:6px;background:linear-gradient(90deg,#f0f0f0 25%,#e8e8e8 50%,#f0f0f0 75%);background-size:200% 100%;animation:shimmer 1.5s infinite;margin-bottom:10px}
.sk-line.tall{height:18px;margin-bottom:12px}
.sk-line.short{width:55%}
.sk-line.med{width:75%}
@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
.cmp-reading{font-size:12px;color:var(--text-light);text-align:center;padding:8px 0;font-style:italic}

/* ── HOW WE SCORE ── */
.method-hero{background:linear-gradient(155deg,var(--forest),var(--moss));
  padding:calc(var(--safe-top) + 52px) 20px 28px;position:relative;flex-shrink:0}
.method-back{position:absolute;top:calc(var(--safe-top) + 12px);left:14px;
  width:36px;height:36px;border-radius:50%;background:rgba(255,255,255,0.12);
  display:flex;align-items:center;justify-content:center;cursor:pointer}
.method-back svg{width:18px;height:18px;stroke:white;fill:none;stroke-width:2.5}
.method-title{font-family:system-ui,-apple-system,sans-serif;font-size:26px;font-weight:700;color:white;margin-bottom:6px}
.method-sub{font-size:13px;color:rgba(255,255,255,0.65);line-height:1.6}
.signal-card{background:var(--card);margin:10px 14px;border-radius:22px;padding:16px 18px;box-shadow:var(--shadow)}
.sig-top{display:flex;align-items:center;gap:12px;margin-bottom:10px}
.sig-num{width:34px;height:34px;border-radius:10px;background:var(--pale);
  display:flex;align-items:center;justify-content:center;font-family:system-ui,-apple-system,sans-serif;
  font-size:15px;font-weight:700;color:var(--forest);flex-shrink:0}
.sig-title{font-family:system-ui,-apple-system,sans-serif;font-size:15px;font-weight:600;color:var(--forest)}
.sig-worth{font-size:10px;color:var(--text-light);margin-top:1px}
.sig-desc{font-size:12px;color:var(--text-mid);line-height:1.7}

/* ── LEARN SCREEN ── */
.learn-hero{background:linear-gradient(155deg,var(--forest),var(--moss));
  padding:calc(var(--safe-top) + 52px) 20px 24px;position:relative;flex-shrink:0}
.learn-back{position:absolute;top:calc(var(--safe-top) + 12px);left:14px;
  width:36px;height:36px;border-radius:50%;background:rgba(255,255,255,0.12);
  display:flex;align-items:center;justify-content:center;cursor:pointer}
.learn-back svg{width:18px;height:18px;stroke:white;fill:none;stroke-width:2.5}
.learn-search-wrap{margin:12px 14px 4px;position:relative}
.learn-input{width:100%;padding:14px 56px 14px 16px;border-radius:16px;
  border:1.5px solid var(--warm);font-size:15px;font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;
  background:white;color:var(--text);outline:none;transition:border-color 0.2s;
  box-shadow:var(--shadow)}
.learn-input:focus{border-color:var(--sage)}
.learn-send{position:absolute;right:8px;top:50%;transform:translateY(-50%);
  width:38px;height:38px;border-radius:12px;background:var(--moss);border:none;
  display:flex;align-items:center;justify-content:center;cursor:pointer}
.learn-send svg{width:16px;height:16px;stroke:white;fill:none;stroke-width:2.2}
.learn-suggestions{padding:12px 14px 4px}
.learn-sugg-label{font-size:10px;text-transform:uppercase;letter-spacing:0.6px;
  color:var(--text-light);font-weight:600;margin-bottom:10px}
.learn-sugg-chips{display:flex;flex-wrap:wrap;gap:7px}
.learn-sugg-chip{padding:8px 14px;border-radius:22px;font-size:12px;font-weight:500;
  background:white;color:var(--moss);border:1.5px solid rgba(82,183,136,0.3);cursor:pointer;
  box-shadow:var(--shadow);transition:all 0.15s;line-height:1.3}
.learn-sugg-chip:active{background:var(--pale);transform:scale(0.97)}
.la-summary{background:var(--forest);border-radius:22px;padding:18px;margin-bottom:10px}
.la-question{font-size:11px;color:var(--mint);font-weight:600;text-transform:uppercase;
  letter-spacing:0.5px;margin-bottom:8px}
.la-summary-text{font-size:14px;color:rgba(255,255,255,0.88);line-height:1.75}
.la-bottom-line{background:var(--pale);border-radius:16px;padding:14px;margin-bottom:10px;
  border:1.5px solid rgba(82,183,136,0.25)}
.la-bl-label{font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:var(--moss);
  font-weight:600;margin-bottom:5px}
.la-bl-text{font-size:14px;color:var(--forest);font-weight:600;line-height:1.55}
.la-dim-card{background:white;border-radius:18px;padding:16px;box-shadow:var(--shadow);margin-bottom:10px}
.la-dim-label{font-size:10px;text-transform:uppercase;letter-spacing:0.6px;
  color:var(--text-light);font-weight:600;margin-bottom:12px}
.la-dim-row{display:flex;align-items:flex-start;gap:10px;padding:9px 0;
  border-bottom:1px solid var(--warm);line-height:1.55}
.la-dim-row:last-child{border-bottom:none;padding-bottom:0}
.la-dim-name{font-size:12px;font-weight:600;color:var(--text);flex:0 0 100px}
.la-dim-detail{font-size:12px;color:var(--text-mid);flex:1}
.la-dim-verdict{font-size:10px;font-weight:700;padding:2px 8px;border-radius:20px;
  flex-shrink:0;align-self:flex-start;margin-top:2px}
.vd-better{background:var(--pale);color:var(--moss)}
.vd-worse{background:var(--red-bg);color:var(--red)}
.vd-depends{background:var(--amber-bg);color:#92400e}
.la-nuance{background:var(--amber-bg);border-radius:16px;padding:14px;margin-bottom:10px;
  border:1px solid rgba(245,158,11,0.2)}
.la-nuance-label{font-size:10px;text-transform:uppercase;letter-spacing:0.5px;
  color:#92400e;font-weight:600;margin-bottom:5px}
.la-nuance-text{font-size:13px;color:var(--text-mid);line-height:1.65}
.la-related{margin-bottom:16px}
.la-rel-label{font-size:10px;text-transform:uppercase;letter-spacing:0.5px;
  color:var(--text-light);font-weight:600;margin-bottom:8px}

/* ── YKO CARD (in result screen) ── */
.yko-card{background:linear-gradient(135deg,#0f3820,#1a5c35);border-radius:22px;
  padding:16px 18px;margin:0 14px 10px;display:flex;align-items:center;gap:12px;
  cursor:pointer;text-decoration:none}
.yko-icon{width:40px;height:40px;border-radius:12px;background:rgba(255,255,255,0.12);
  display:flex;align-items:center;justify-content:center;flex-shrink:0}
.yko-text{flex:1}
.yko-label{font-size:10px;color:rgba(255,255,255,0.5);text-transform:uppercase;
  letter-spacing:0.5px;font-weight:600;margin-bottom:3px}
.yko-name{font-size:14px;color:white;font-weight:600}
.yko-score-badge{font-size:20px;font-weight:700;color:white;font-family:monospace;margin-right:4px}
.yko-tier-label{font-size:10px;font-weight:600;padding:2px 7px;border-radius:20px;margin-top:3px;display:inline-block}
.yko-arrow{color:rgba(255,255,255,0.4);display:flex;align-items:center}

/* ── MANUAL MODAL ── */
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:500;
  display:flex;align-items:flex-end;transition:opacity 0.2s}
.modal-overlay.hidden{opacity:0;pointer-events:none}
.modal-sheet{background:var(--cream);border-radius:26px 26px 0 0;
  padding:20px 20px calc(20px + var(--safe-bottom));width:100%;
  transform:translateY(0);transition:transform 0.3s}
.modal-overlay.hidden .modal-sheet{transform:translateY(100%)}
.modal-handle{width:38px;height:4px;border-radius:2px;background:var(--warm);margin:0 auto 18px}
.modal-title{font-family:system-ui,-apple-system,sans-serif;font-size:19px;font-weight:700;color:var(--forest);margin-bottom:16px}
.input-group{margin-bottom:13px}
.input-group label{display:block;font-size:11px;font-weight:600;color:var(--text-light);
  text-transform:uppercase;letter-spacing:1px;margin-bottom:5px}
.input-group input,.input-group textarea{width:100%;padding:12px 14px;border-radius:12px;
  border:1.5px solid var(--warm);font-size:14px;font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;
  color:var(--text);background:white;outline:none;transition:border-color 0.2s;resize:none}
.input-group input:focus,.input-group textarea:focus{border-color:var(--sage)}
.input-row{display:flex;gap:10px}
.input-row .input-group{flex:1}
.modal-btn{width:100%;padding:14px;background:linear-gradient(135deg,var(--moss),var(--sage));
  color:white;border:none;border-radius:14px;font-size:15px;font-weight:600;
  cursor:pointer;font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;margin-top:4px}
.modal-cancel{width:100%;padding:10px;background:none;border:none;
  color:var(--text-light);font-size:14px;cursor:pointer;font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;margin-top:2px}

/* ── AUTH MODAL ── */
.auth-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:500;
  display:flex;align-items:flex-end;opacity:0;pointer-events:none;transition:opacity 0.25s}
.auth-overlay.open{opacity:1;pointer-events:all}
.auth-sheet{background:var(--cream);border-radius:26px 26px 0 0;width:100%;
  padding:22px 22px calc(22px + var(--safe-bottom));
  transform:translateY(100%);transition:transform 0.3s cubic-bezier(0.4,0,0.2,1)}
.auth-overlay.open .auth-sheet{transform:translateY(0)}
.auth-handle{width:38px;height:4px;border-radius:2px;background:var(--warm);margin:0 auto 22px}
.auth-title{font-family:system-ui,-apple-system,sans-serif;font-size:22px;font-weight:700;color:var(--forest);margin-bottom:5px}
.auth-sub{font-size:13px;color:var(--text-mid);margin-bottom:20px;line-height:1.6}
.auth-tabs{display:flex;background:var(--warm);border-radius:12px;padding:3px;margin-bottom:18px}
.auth-tab{flex:1;padding:8px;border-radius:10px;font-size:13px;font-weight:600;
  text-align:center;cursor:pointer;color:var(--text-mid);transition:all 0.2s}
.auth-tab.active{background:var(--card);color:var(--forest);box-shadow:var(--shadow)}
.auth-field{margin-bottom:13px}
.auth-field label{display:block;font-size:11px;font-weight:600;color:var(--text-light);
  text-transform:uppercase;letter-spacing:1px;margin-bottom:5px}
.auth-field input{width:100%;padding:12px 14px;border-radius:12px;border:1.5px solid var(--warm);
  font-size:15px;font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;color:var(--text);background:white;
  outline:none;transition:border-color 0.2s}
.auth-field input:focus{border-color:var(--sage)}
.auth-submit{width:100%;padding:14px;background:var(--forest);color:white;border:none;
  border-radius:14px;font-size:15px;font-weight:600;cursor:pointer;
  font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;margin-top:4px}
.auth-err{font-size:12px;color:var(--red);margin-bottom:10px;display:none}
.auth-err.show{display:block}
.auth-later{text-align:center;margin-top:14px;font-size:13px;color:var(--text-light)}
.auth-later a{color:var(--sage);font-weight:600;cursor:pointer}

/* ── TOAST ── */
.toast{position:fixed;top:calc(var(--safe-top) + 54px);left:50%;transform:translateX(-50%) translateY(-4px);
  background:var(--forest);color:white;padding:10px 18px;border-radius:30px;
  font-size:13px;font-weight:500;z-index:600;opacity:0;transition:opacity 0.25s,transform 0.25s;
  pointer-events:none;white-space:nowrap;box-shadow:var(--shadow-md)}
.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}

/* ── INSTALL ── */
.install-prompt{position:fixed;bottom:calc(80px + var(--safe-bottom) + 10px);
  left:14px;right:14px;background:var(--forest);border-radius:20px;
  padding:14px 16px;display:flex;align-items:center;gap:12px;
  z-index:300;box-shadow:var(--shadow-md)}
.install-prompt.hidden{display:none}
.install-text{flex:1;font-size:12px;color:rgba(255,255,255,0.8);line-height:1.5}
.install-text strong{color:white}
.install-btn-el{background:var(--sage);color:white;border:none;border-radius:10px;
  padding:8px 14px;font-size:12px;font-weight:600;cursor:pointer;
  font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;white-space:nowrap}

/* ── SCORE RING ── */
.score-ring-wrap{position:relative;width:116px;height:116px;margin:0 auto 14px}
.score-ring-svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
.ring-track{fill:none;stroke:rgba(255,255,255,0.1);stroke-width:7}
.ring-fill{fill:none;stroke:rgba(255,255,255,0.88);stroke-width:7;stroke-linecap:round;
  transition:stroke-dashoffset 1.15s cubic-bezier(0.4,0,0.2,1),stroke 0.55s ease;
  transform-origin:58px 58px;transform:rotate(-90deg)}
.score-ring-inner{position:absolute;inset:0;display:flex;flex-direction:column;
  align-items:center;justify-content:center}
.score-num{font-family:system-ui,-apple-system,sans-serif;font-size:40px;font-weight:700;
  color:white;line-height:1;letter-spacing:-2px}
.score-denom{font-size:11px;color:rgba(255,255,255,0.4);margin-top:3px;letter-spacing:0.5px}

/* ── INSTANT CARD (above fold) ── */
.instant-card{background:var(--card);margin:10px 14px 0;border-radius:22px;
  padding:16px 18px 14px;box-shadow:var(--shadow)}
.verdict-tag-text{font-size:18px;font-weight:700;color:var(--forest);line-height:1.3;margin-bottom:14px}
.signal-pills-row{display:flex;gap:7px}
.sig-pill{flex:1;border-radius:13px;padding:9px 7px;
  display:flex;flex-direction:column;align-items:center;gap:3px;
  opacity:0;animation:fadeUp 0.38s ease forwards}
.sig-pill:nth-child(1){animation-delay:0.06s}
.sig-pill:nth-child(2){animation-delay:0.14s}
.sig-pill:nth-child(3){animation-delay:0.22s}
@keyframes fadeUp{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:translateY(0)}}
.sig-pill-val{font-size:15px;font-weight:700;line-height:1}
.sig-pill-label{font-size:9px;font-weight:600;text-align:center;line-height:1.3;
  text-transform:uppercase;letter-spacing:0.3px;opacity:0.75}
.sp-high{background:rgba(45,106,79,0.07);color:var(--moss)}
.sp-mid{background:rgba(245,158,11,0.09);color:#92400e}
.sp-low{background:rgba(239,68,68,0.07);color:#b91c1c}

/* ── PROGRESS STRIP ── */
.progress-strip{margin:8px 14px 0;padding:11px 16px;background:white;border-radius:16px;
  box-shadow:var(--shadow);display:flex;align-items:center;gap:10px}
.ps-dots{display:flex;gap:5px;align-items:center;flex-shrink:0}
.ps-dot{width:7px;height:7px;border-radius:50%;background:var(--warm);
  transition:background 0.3s,width 0.2s,height 0.2s}
.ps-dot.filled{background:var(--sage)}
.ps-dot.current{background:var(--forest);width:9px;height:9px}
.ps-text{font-size:12px;color:var(--text-mid);line-height:1.45;flex:1}
.ps-text strong{color:var(--forest)}

/* ── SWAP CTA ── */
.swap-cta{margin:8px 14px 0;padding:14px 16px;background:var(--forest);border-radius:18px;
  display:flex;align-items:center;gap:14px;cursor:pointer;
  transition:opacity 0.15s;-webkit-tap-highlight-color:transparent}
.swap-cta:active{opacity:0.82}
.swap-cta-left{flex:1}
.swap-cta-title{font-size:14px;font-weight:600;color:white;line-height:1.25}
.swap-cta-sub{font-size:11px;color:rgba(255,255,255,0.48);margin-top:2px}
.swap-cta-chevron{width:28px;height:28px;border-radius:50%;
  background:rgba(255,255,255,0.12);display:flex;align-items:center;
  justify-content:center;flex-shrink:0}
.swap-cta-chevron svg{width:14px;height:14px;stroke:white;fill:none;stroke-width:2.5}

/* ── BREAKDOWN TOGGLE ── */
.breakdown-toggle{margin:8px 14px 0;padding:13px 18px;background:var(--warm);
  border-radius:16px;display:flex;align-items:center;justify-content:space-between;
  cursor:pointer;transition:background 0.15s;user-select:none;
  -webkit-tap-highlight-color:transparent}
.breakdown-toggle:active{background:rgba(82,183,136,0.13)}
.bt-text{font-size:13px;font-weight:600;color:var(--text-mid)}
.bt-chev{width:24px;height:24px;display:flex;align-items:center;justify-content:center;
  transition:transform 0.28s}
.bt-chev.open{transform:rotate(180deg)}
.bt-chev svg{width:16px;height:16px;stroke:var(--text-mid);fill:none;stroke-width:2.5}
.breakdown-body{overflow:hidden;max-height:0;opacity:0;
  transition:max-height 0.46s cubic-bezier(0.4,0,0.2,1),opacity 0.32s ease}

/* ── SWAP SHEET ── */
.swap-sheet-backdrop{position:fixed;inset:0;background:rgba(0,0,0,0);z-index:800;
  pointer-events:none;transition:background 0.3s}
.swap-sheet-backdrop.open{background:rgba(0,0,0,0.48);pointer-events:all}
.swap-sheet{position:fixed;bottom:0;left:0;right:0;max-width:430px;margin:0 auto;
  background:var(--cream);border-radius:26px 26px 0 0;z-index:801;
  transform:translateY(100%);transition:transform 0.38s cubic-bezier(0.4,0,0.2,1);
  padding-bottom:calc(16px + var(--safe-bottom));will-change:transform;
  max-height:80vh;display:flex;flex-direction:column}
.swap-sheet.open{transform:translateY(0)}
.swap-handle-row{padding:10px 0 4px;display:flex;justify-content:center;flex-shrink:0}
.swap-handle-bar{width:38px;height:4px;border-radius:2px;background:var(--warm)}
.swap-sheet-header{padding:2px 18px 14px;display:flex;align-items:center;
  justify-content:space-between;flex-shrink:0;border-bottom:1px solid var(--warm)}
.swap-sheet-title{font-family:system-ui,-apple-system,sans-serif;
  font-size:17px;font-weight:700;color:var(--forest)}
.swap-close{width:30px;height:30px;border-radius:50%;background:var(--warm);
  display:flex;align-items:center;justify-content:center;
  cursor:pointer;border:none;flex-shrink:0}
.swap-close svg{width:14px;height:14px;stroke:var(--text-mid);fill:none;stroke-width:2.5}
.swap-sheet-body{flex:1;overflow-y:auto;padding:14px 14px 0;scrollbar-width:none}
.swap-sheet-body::-webkit-scrollbar{display:none}

/* ── SWAP CARDS ── */
.swap-card{background:white;border-radius:18px;padding:14px 16px;margin-bottom:10px;
  box-shadow:var(--shadow);opacity:0;animation:fadeUp 0.35s ease forwards}
.swap-card:nth-child(1){animation-delay:0.04s}
.swap-card:nth-child(2){animation-delay:0.13s}
.swap-card:nth-child(3){animation-delay:0.22s}
.sc-top{display:flex;align-items:flex-start;gap:12px}
.sc-score{width:44px;height:44px;border-radius:13px;display:flex;flex-direction:column;
  align-items:center;justify-content:center;flex-shrink:0}
.sc-score-num{font-family:system-ui,-apple-system,sans-serif;font-size:18px;font-weight:700;line-height:1}
.sc-score-sub{font-size:8px;letter-spacing:0.3px;opacity:0.65}
.sc-info{flex:1;min-width:0;padding-top:2px}
.sc-name{font-size:14px;font-weight:700;color:var(--forest);line-height:1.3}
.sc-brand{font-size:12px;color:var(--text-light);margin-top:1px}
.sc-why{font-size:13px;color:var(--text-mid);line-height:1.6;
  border-top:1px solid var(--warm);padding-top:10px;margin-top:10px}
.sc-scan-btn{margin-top:10px;width:100%;display:flex;align-items:center;justify-content:center;
  gap:6px;background:var(--pale);border-radius:10px;padding:9px 14px;cursor:pointer;
  border:none;font-size:12px;font-weight:600;color:var(--moss);
  font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;
  transition:background 0.15s;-webkit-tap-highlight-color:transparent}
.sc-scan-btn:active{background:rgba(82,183,136,0.18)}
.sc-scan-btn svg{width:14px;height:14px;stroke:var(--moss);fill:none;stroke-width:2}

/* ── RATE & IMPROVE CARD ── */
.ri-card{background:var(--card);margin:10px 14px 0;border-radius:22px;
  box-shadow:var(--shadow);overflow:hidden}
.ri-summary{padding:15px 18px 12px;display:flex;align-items:flex-start;gap:12px}
.ri-grade{width:44px;height:44px;border-radius:13px;display:flex;align-items:center;
  justify-content:center;font-family:system-ui,-apple-system,sans-serif;
  font-size:18px;font-weight:700;flex-shrink:0;letter-spacing:-0.5px}
.ri-verdict{flex:1;font-size:15px;font-weight:600;color:var(--forest);
  line-height:1.4;padding-top:3px}
.ri-chips{padding:0 18px 12px;display:flex;flex-wrap:wrap;gap:6px}
.ri-chip{font-size:11px;font-weight:600;padding:4px 11px;border-radius:20px;line-height:1.45}
.ri-chip.good{background:rgba(45,106,79,0.07);color:var(--moss)}
.ri-chip.warn{background:rgba(245,158,11,0.09);color:#92400e}
.ri-chip.bad{background:rgba(239,68,68,0.07);color:#b91c1c}
.ri-chip.neutral{background:var(--warm);color:var(--text-mid)}
.ri-actions{border-top:1px solid var(--warm);display:flex}
.ri-action{flex:1;padding:13px 6px;display:flex;align-items:center;justify-content:center;
  gap:4px;cursor:pointer;border:none;background:none;font-size:12px;font-weight:600;
  color:var(--text-mid);font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;
  transition:background 0.15s;-webkit-tap-highlight-color:transparent;white-space:nowrap}
.ri-action:not(:first-child){border-left:1px solid var(--warm)}
.ri-action:active{background:var(--warm)}
.ri-action.selected-good{color:var(--moss);background:rgba(45,106,79,0.05)}
.ri-action.selected-bad{color:#b91c1c;background:rgba(239,68,68,0.04)}
.ri-action.ri-add{color:var(--forest);font-weight:700}
.ri-action svg{width:13px;height:13px;stroke:currentColor;fill:none;
  stroke-width:2.2;flex-shrink:0}
/* ── INSIGHT SHEET ── */
.insight-hint{font-size:13px;color:var(--text-mid);margin-bottom:14px;line-height:1.65}
.insight-textarea{width:100%;padding:12px 14px;border-radius:12px;
  border:1.5px solid var(--warm);font-size:15px;
  font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;
  color:var(--text);background:white;outline:none;resize:none;
  line-height:1.55;transition:border-color 0.2s;-webkit-appearance:none}
.insight-textarea:focus{border-color:var(--sage)}
.insight-submit{width:100%;margin-top:12px;padding:14px;background:var(--forest);
  color:white;border:none;border-radius:14px;font-size:15px;font-weight:600;
  cursor:pointer;font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;
  transition:opacity 0.15s}
.insight-submit:active{opacity:0.85}
/* ── MILESTONE BANNER ── */
.milestone-banner{position:fixed;bottom:calc(90px + var(--safe-bottom) + 12px);
  left:14px;right:14px;max-width:402px;margin:0 auto;
  background:var(--forest);border-radius:18px;padding:13px 18px;
  z-index:700;transform:translateY(16px);opacity:0;pointer-events:none;
  transition:opacity 0.32s ease,transform 0.32s ease;box-shadow:var(--shadow-md)}
.milestone-banner.show{opacity:1;transform:translateY(0)}
.mb-title{font-size:13px;font-weight:700;color:white;margin-bottom:2px}
.mb-sub{font-size:11px;color:rgba(255,255,255,0.56);line-height:1.5}
</style>
</head>
<body>
<div class="app">

<!-- ══ HOME / CAMERA SCREEN ══ -->
<div class="screen" id="s-home">
  <!-- Native camera input — the iOS-safe way to open the camera -->
  <input type="file" id="cam-native" accept="image/*" capture="environment" style="display:none" onchange="handleCameraCapture(this)">

  <!-- Top bar -->
  <div class="home-topbar">
    <button class="home-hamburger" onclick="openDrawer()" aria-label="Menu">
      <span></span><span></span><span></span>
    </button>
    <div class="home-logo">Green<em>Specs</em></div>
    <button class="home-user-btn" id="home-user-btn" onclick="openAuth()" aria-label="Account">
      <svg viewBox="0 0 24 24"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
    </button>
  </div>

  <!-- Scrollable content -->
  <div class="scrollable" id="home-scroll">
    <!-- Hero -->
    <div class="home-hero">
      <div class="home-tagline">Seeing through labels<br>is a <em>superpower.</em></div>
      <div class="home-sub">That "eco-friendly" label? Usually marketing, not fact.</div>
      <div class="home-sub2">Scan anything and get an honest score — what's real, what's not, and why it matters.</div>
      <button class="scan-btn" onclick="openNativeCamera()">
        <div class="scan-btn-icon">
          <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M3 9V6a2 2 0 0 1 2-2h3M15 4h3a2 2 0 0 1 2 2v3M21 15v3a2 2 0 0 1-2 2h-3M9 20H6a2 2 0 0 1-2-2v-3"/></svg>
        </div>
        <div class="scan-btn-text">
          <div class="scan-btn-label">Scan a Product</div>
          <div class="scan-btn-hint">Point camera at the label</div>
        </div>
      </button>
      <div class="type-link" onclick="showManualInput()">or type the product name</div>
    </div>

    <!-- Stats bar -->
    <div class="home-stats-bar" id="home-stats-bar" style="display:none">
      <div class="home-stats-icon">
        <svg viewBox="0 0 24 24"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
      </div>
      <div class="home-stats-text" id="home-stats-text">Loading community stats…</div>
    </div>

    <!-- Recent scans -->
    <div class="home-section" id="home-recent-section" style="display:none">
      <div class="home-section-title">Your recent scans</div>
      <div class="recent-strip" id="recent-strip"></div>
    </div>
  </div>
</div>

<!-- ══ ANALYZING OVERLAY (fixed, global) ══ -->
<div class="analyzing hidden" id="analyzing">
  <div class="spin"></div>
  <div class="an-title" id="an-title">Reading the label…</div>
  <div class="an-sub" id="an-sub">Checking 5 sustainability signals</div>
  <div class="an-phases">
    <div class="an-phase active" id="an-p1"><div class="an-phase-dot"></div>Reading the label</div>
    <div class="an-phase" id="an-p2"><div class="an-phase-dot"></div>Scoring the claims</div>
  </div>
  <div class="dots" style="margin-top:8px"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>
</div>

<!-- ══ RESULT SCREEN ══ -->
<div class="screen hidden" id="s-result">
  <div class="result-hero">
    <div class="r-back" onclick="goHome()">
      <svg viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"/></svg>
    </div>
    <div class="r-compare-btn" onclick="addToCompare()">Compare</div>
    <div class="score-ring-wrap" id="r-grade-circle">
      <svg class="score-ring-svg" viewBox="0 0 116 116">
        <circle class="ring-track" cx="58" cy="58" r="50"/>
        <circle class="ring-fill" id="r-ring-fill" cx="58" cy="58" r="50"
          stroke-dasharray="314.16" stroke-dashoffset="314.16"/>
      </svg>
      <div class="score-ring-inner">
        <div id="r-grade-letter" class="score-num">—</div>
        <div id="r-grade-num" class="score-denom">/100</div>
      </div>
    </div>
    <div class="r-name" id="r-name">Product</div>
    <div class="r-brand-cat" id="r-brand-cat"></div>
    <a class="r-yko-link" id="r-yko-link" href="https://yko.earth" target="_blank" rel="noopener">See brand profile on YKO.earth</a>
    <div class="r-pills">
      <div class="rpill" id="r-loc"></div>
      <div class="rpill" id="r-price" style="display:none"></div>
    </div>
  </div>
  <div class="r-body" id="r-body"></div>
</div>

<!-- ══ MY SCANS ══ -->
<div class="screen hidden" id="s-myscans">
  <div class="topbar">
    <div class="topbar-menu" onclick="openDrawer()"><span></span><span></span><span></span></div>
    <div class="topbar-title">My <em>Scans</em></div>
    <div style="width:40px"></div>
  </div>
  <div class="scrollable">
    <div class="scans-grid" id="scans-grid"></div>
  </div>
</div>

<!-- ══ COMPARE ══ -->
<div class="screen hidden" id="s-compare">
  <div class="topbar">
    <div class="topbar-menu" onclick="openDrawer()"><span></span><span></span><span></span></div>
    <div class="topbar-title"><em>Compare</em></div>
    <div onclick="clearCompareSnap()" style="font-size:12px;color:var(--text-light);cursor:pointer;padding:8px">Clear</div>
  </div>
  <div class="scrollable" id="compare-scroll">
    <div id="cmp-entry-hero" class="cmp-snap-hero">
      <div class="cmp-snap-title">Snap to compare</div>
      <div class="cmp-snap-sub">Photograph up to 3 products.<br>We find the real differences.</div>
      <button class="cmp-snap-btn" onclick="startCompareSnap()">
        <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M3 9V6a2 2 0 0 1 2-2h3M15 4h3a2 2 0 0 1 2 2v3M21 15v3a2 2 0 0 1-2 2h-3M9 20H6a2 2 0 0 1-2-2v-3"/></svg>
        Add first product
      </button>
    </div>
    <div id="cmp-cards-area" class="cmp-cards-wrap"></div>
    <div id="cmp-add-more" style="display:none;margin:12px 14px">
      <div class="cmp-snap-add" onclick="startCompareSnap()">
        <svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Add another product
      </div>
    </div>
    <div id="cmp-summary-area" style="display:none"></div>
    <div style="height:20px"></div>
  </div>
</div>

<!-- ══ HOW WE SCORE ══ -->
<div class="screen hidden" id="s-method">
  <div class="method-hero">
    <div class="method-back" onclick="goHome()">
      <svg viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"/></svg>
    </div>
    <div class="method-title">How we score</div>
    <div class="method-sub">5 signals · each worth 20 points · total out of 100.<br>We score relative to what's actually possible — eco is hard.</div>
  </div>
  <div class="scrollable">
    <div class="signal-card"><div class="sig-top"><div class="sig-num">1</div><div><div class="sig-title">Claims and Disclosure</div><div class="sig-worth">Worth up to 20 pts</div></div></div><div class="sig-desc">Are claims specific and verifiable? "80% recycled content, third-party verified" beats "eco-friendly" every time. Vague language is cheap. Published data is valuable.</div></div>
    <div class="signal-card"><div class="sig-top"><div class="sig-num">2</div><div><div class="sig-title">Certifications</div><div class="sig-worth">Worth up to 20 pts</div></div></div><div class="sig-desc">B Corp. USDA Organic. Fair Trade. EPA Safer Choice. These have real audit requirements. A leaf logo the company designed themselves does not count.</div></div>
    <div class="signal-card"><div class="sig-top"><div class="sig-num">3</div><div><div class="sig-title">Packaging Lifecycle</div><div class="sig-worth">Worth up to 20 pts</div></div></div><div class="sig-desc">Not just "is it recyclable" — the full picture. A lightweight flexible bag beats a glass jar on total impact. Bulk format, concentrate, and refillable score highest. Glass feels premium but ships heavy.</div></div>
    <div class="signal-card"><div class="sig-top"><div class="sig-num">4</div><div><div class="sig-title">Ingredient Impact</div><div class="sig-worth">Worth up to 20 pts</div></div></div><div class="sig-desc">What is actually in it, and how was it made? For food: fewer recognizable ingredients, less processing, organic on high-risk crops. One organic ingredient plus 15 additives does not score well here.</div></div>
    <div class="signal-card"><div class="sig-top"><div class="sig-num">5</div><div><div class="sig-title">Supply Chain</div><div class="sig-worth">Worth up to 20 pts</div></div></div><div class="sig-desc">Where was it made and how did it get here? Clean ingredients shipped globally with no offset cap this signal. Short chains, published Scope 3 data, and verified supplier standards score highest.</div></div>
    <div class="card" style="background:var(--forest);margin-bottom:16px">
      <div class="card-label" style="color:var(--mint)">The scope breakdown</div>
      <div class="scope-row"><div class="scope-bub s1">S1</div><div><div class="scope-name" style="color:white">Scope 1 — Direct ops</div><div class="scope-desc" style="color:rgba(255,255,255,0.7)">Their factories, their trucks, their direct burn.</div></div></div>
      <div class="scope-row"><div class="scope-bub s2">S2</div><div><div class="scope-name" style="color:white">Scope 2 — Purchased energy</div><div class="scope-desc" style="color:rgba(255,255,255,0.7)">The electricity and heat they buy to run operations.</div></div></div>
      <div class="scope-row" style="margin-bottom:0"><div class="scope-bub s3">S3</div><div><div class="scope-name" style="color:white">Scope 3 — Everything upstream</div><div class="scope-desc" style="color:rgba(255,255,255,0.7)">The farms, ingredients, suppliers, shipping. Usually 70-90% of the real footprint — and almost never on the label. This is where the story lives.</div></div></div>
    </div>
  </div>
</div>

<!-- ══ LEARN / ASK SUSTAINABILITY ══ -->
<div class="screen hidden" id="s-learn">
  <div class="learn-hero">
    <div class="learn-back" onclick="goHome()">
      <svg viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"/></svg>
    </div>
    <div class="method-title">Ask Sustainability</div>
    <div class="method-sub">AI searches the web to answer your questions — real facts, no greenwashing.</div>
  </div>
  <div class="scrollable" id="learn-scroll">
    <div class="learn-search-wrap">
      <input type="text" class="learn-input" id="learn-input"
             placeholder="Is glass better than plastic?"
             onkeydown="if(event.key==='Enter')submitLearnQuestion()">
      <button class="learn-send" onclick="submitLearnQuestion()">
        <svg viewBox="0 0 24 24"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
      </button>
    </div>
    <div class="learn-suggestions" id="learn-suggestions">
      <div class="learn-sugg-label">Popular questions</div>
      <div class="learn-sugg-chips">
        <div class="learn-sugg-chip" onclick="askLearn('Is glass better than plastic?')">Glass vs plastic?</div>
        <div class="learn-sugg-chip" onclick="askLearn('Is organic food more sustainable?')">Organic food?</div>
        <div class="learn-sugg-chip" onclick="askLearn('Are paper bags better than plastic bags?')">Paper vs plastic bags?</div>
        <div class="learn-sugg-chip" onclick="askLearn('What does carbon neutral actually mean?')">Carbon neutral?</div>
        <div class="learn-sugg-chip" onclick="askLearn('Is an electric car better for the environment?')">Electric cars?</div>
        <div class="learn-sugg-chip" onclick="askLearn('Is bamboo really sustainable?')">Bamboo?</div>
        <div class="learn-sugg-chip" onclick="askLearn('What is greenwashing?')">Greenwashing?</div>
        <div class="learn-sugg-chip" onclick="askLearn('Which eco certifications actually matter?')">Real certifications?</div>
        <div class="learn-sugg-chip" onclick="askLearn('What is a carbon footprint and how is it measured?')">Carbon footprint?</div>
        <div class="learn-sugg-chip" onclick="askLearn('Is local food always more sustainable?')">Local food?</div>
      </div>
    </div>
    <div id="learn-answer-area" style="padding:0 14px 8px"></div>
  </div>
</div>

<!-- ══ DRAWER ══ -->
<div class="drawer-overlay" id="drawer-overlay" onclick="closeDrawer()"></div>
<div class="drawer" id="drawer">
  <div class="drawer-head">
    <div class="drawer-brand">Green<em>Specs</em></div>
    <div class="drawer-tagline">Seeing through labels is a superpower.</div>
  </div>
  <div class="drawer-nav">
    <button class="d-item active" id="d-home" onclick="goHome();closeDrawer()">
      <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M3 9V6a2 2 0 0 1 2-2h3M15 4h3a2 2 0 0 1 2 2v3M21 15v3a2 2 0 0 1-2 2h-3M9 20H6a2 2 0 0 1-2-2v-3"/></svg>
      <span>Scan</span>
    </button>
    <button class="d-item" id="d-scans" onclick="showMyScans();closeDrawer()">
      <svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
      <span>My Scans</span>
    </button>
    <button class="d-item" id="d-compare" onclick="showCompare();closeDrawer()">
      <svg viewBox="0 0 24 24"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
      <span>Compare</span>
    </button>
    <div class="d-divider"></div>
    <button class="d-item" onclick="showMethod();closeDrawer()">
      <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
      <span>How We Score</span>
    </button>
    <button class="d-item" id="d-learn" onclick="showLearn();closeDrawer()">
      <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      <span>Ask Sustainability</span>
    </button>
    <div class="d-divider"></div>
    <button class="d-item" onclick="openAuth();closeDrawer()">
      <svg viewBox="0 0 24 24"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
      <span id="d-auth-label">Sign in / Sign up</span>
    </button>
  </div>
  <div class="drawer-foot">
    <div class="drawer-foot-text">AI-powered analysis · Web research included<br>Data stored at the edge · greenspecs.app</div>
  </div>
</div>

<!-- ══ BOTTOM NAV ══ -->
<div class="nav" id="main-nav">
  <div class="nav-item active" id="nav-home" onclick="goHome()">
    <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M3 9V6a2 2 0 0 1 2-2h3M15 4h3a2 2 0 0 1 2 2v3M21 15v3a2 2 0 0 1-2 2h-3M9 20H6a2 2 0 0 1-2-2v-3"/></svg>
    Scan
  </div>
  <div class="nav-item" id="nav-scans" onclick="showMyScans()">
    <svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
    My Scans
  </div>
  <div class="nav-scan" onclick="openNativeCamera()">
    <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M3 9V6a2 2 0 0 1 2-2h3M15 4h3a2 2 0 0 1 2 2v3M21 15v3a2 2 0 0 1-2 2h-3M9 20H6a2 2 0 0 1-2-2v-3"/></svg>
  </div>
  <div class="nav-item compare-tab" id="nav-compare" onclick="showCompare()">
    <div class="cmp-nav-pill">
      <svg viewBox="0 0 24 24"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
    </div>
    Compare
  </div>
  <div class="nav-item" id="nav-learn" onclick="showLearn()">
    <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
    Learn
  </div>
</div>

<!-- ══ MANUAL MODAL ══ -->
<div class="modal-overlay hidden" id="manual-modal">
  <div class="modal-sheet">
    <div class="modal-handle"></div>
    <div class="modal-title">What are you looking at?</div>
    <div class="input-group">
      <label>Product name & brand *</label>
      <input type="text" id="input-product" placeholder="e.g. Method All-Purpose Cleaner">
    </div>
    <div class="input-group">
      <label>Green claim on the label</label>
      <textarea id="input-claim" rows="2" placeholder='e.g. "Plant-based, biodegradable"'></textarea>
    </div>
    <div class="input-row">
      <div class="input-group"><label>Price (optional)</label><input type="text" id="input-price" placeholder="$4.99"></div>
      <div class="input-group"><label>Store (optional)</label><input type="text" id="input-store" placeholder="Whole Foods"></div>
    </div>
    <button class="modal-btn" onclick="submitManualScan()">Analyze this product →</button>
    <button class="modal-cancel" onclick="closeManualInput()">Cancel</button>
  </div>
</div>

<!-- ══ AUTH MODAL ══ -->
<div class="auth-overlay" id="auth-overlay">
  <div class="auth-sheet">
    <div class="auth-handle"></div>
    <div class="auth-title">Save your scans</div>
    <div class="auth-sub">Sign in free to keep your history across devices.</div>
    <div class="auth-tabs">
      <div class="auth-tab active" id="tab-in" onclick="switchAuthTab('in')">Sign in</div>
      <div class="auth-tab" id="tab-up" onclick="switchAuthTab('up')">Create account</div>
    </div>
    <div class="auth-err" id="auth-err"></div>
    <div id="form-in">
      <div class="auth-field"><label>Email</label><input type="email" id="si-email" placeholder="you@example.com" autocomplete="email"></div>
      <div class="auth-field"><label>Password</label><input type="password" id="si-pass" placeholder="••••••••" autocomplete="current-password"></div>
      <button class="auth-submit" onclick="doSignIn()">Sign in</button>
    </div>
    <div id="form-up" style="display:none">
      <div class="auth-field"><label>Name</label><input type="text" id="su-name" placeholder="Your name" autocomplete="name"></div>
      <div class="auth-field"><label>Email</label><input type="email" id="su-email" placeholder="you@example.com" autocomplete="email"></div>
      <div class="auth-field"><label>Password</label><input type="password" id="su-pass" placeholder="8+ characters" autocomplete="new-password"></div>
      <button class="auth-submit" onclick="doSignUp()">Create account</button>
    </div>
    <div class="auth-later"><a onclick="closeAuth()">Maybe later</a></div>
  </div>
</div>

<!-- ══ INSTALL PROMPT ══ -->
<div class="install-prompt hidden" id="install-prompt">
  <div class="install-text"><strong>Add to Home Screen</strong><br>Scan anything in-store, one tap.</div>
  <button class="install-btn-el" id="install-btn-el">Install</button>
</div>

<div class="toast" id="toast"></div>

<!-- \u2550\u2550 SWAP SHEET \u2550\u2550 -->
<div class="swap-sheet-backdrop" id="swap-backdrop" onclick="closeSwapSheet()"></div>
<div class="swap-sheet" id="swap-sheet">
  <div class="swap-handle-row"><div class="swap-handle-bar"></div></div>
  <div class="swap-sheet-header">
    <div class="swap-sheet-title" id="swap-sheet-title">Better options</div>
    <button class="swap-close" onclick="closeSwapSheet()">
      <svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
  </div>
  <div class="swap-sheet-body" id="swap-sheet-body"></div>
</div>

<!-- \u2550\u2550 INSIGHT SHEET \u2550\u2550 -->
<div class="swap-sheet-backdrop" id="insight-backdrop" onclick="closeInsightSheet()"></div>
<div class="swap-sheet" id="insight-sheet">
  <div class="swap-handle-row"><div class="swap-handle-bar"></div></div>
  <div class="swap-sheet-header">
    <div class="swap-sheet-title">What did we miss?</div>
    <button class="swap-close" onclick="closeInsightSheet()">
      <svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
  </div>
  <div style="padding:16px 18px calc(16px + var(--safe-bottom))">
    <div class="insight-hint">Tell us what you see on the label that we may have missed. A cert logo, the format, where it was made, a recent change.</div>
    <textarea id="insight-input" rows="3" class="insight-textarea"
      placeholder='e.g. "EPA Safer Choice logo on the back" or "this is the concentrate, not single-use"'></textarea>
    <button class="insight-submit" onclick="submitInsight()">Re-score with this \u2192</button>
    <button onclick="closeInsightSheet()" style="width:100%;padding:11px;background:none;border:none;color:var(--text-light);font-size:14px;cursor:pointer;font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;margin-top:2px">Cancel</button>
  </div>
</div>

<!-- \u2550\u2550 MILESTONE BANNER \u2550\u2550 -->
<div class="milestone-banner" id="milestone-banner">
  <div class="mb-title" id="mb-title"></div>
  <div class="mb-sub" id="mb-sub"></div>
</div>

<script>
// ─── VERSION CHECK — forces PWA to reload if cached version is old ────────────
const APP_VERSION = '20260415-v9';
(function(){ const prev = localStorage.getItem('gs_app_version'); localStorage.setItem('gs_app_version', APP_VERSION); if (prev && prev !== APP_VERSION) location.reload(); })();

// ─── STATE ────────────────────────────────────────────────────────────────────
const API = '';
let session_id = localStorage.getItem('gs_session') || (function(){ const c='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',s=Array.from({length:16},()=>c[Math.random()*62|0]).join(''); localStorage.setItem('gs_session',s); return s; })();
let auth_token = localStorage.getItem('gs_auth') || null;
let currentUser = null;
let currentScan = null;
let lastScreen = 's-home';
let compareList = JSON.parse(localStorage.getItem('gs_compare') || '[]');
let isSpeaking = false;
let userLat = null, userLng = null, userCity = null;
let deferredInstall = null;

// ─── INIT ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  getLocation();
  if (auth_token) verifyAuth();
  checkInstallPrompt();
  loadHomeData();
});

// ─── CAMERA — native file input approach (works on all iOS/Android) ──────────
function openNativeCamera() {
  // Reset file input so same file can be selected again
  const input = document.getElementById('cam-native');
  input.value = '';
  input.click();
}

async function handleCameraCapture(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  showAnalyzing();
  try {
    const base64 = await new Promise((res, rej) => {
      const reader = new FileReader();
      reader.onload = e => res(e.target.result.split(',')[1]);
      reader.onerror = rej;
      reader.readAsDataURL(file);
    });
    const mediaType = file.type || 'image/jpeg';
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 45000);
    const apiRes = await fetch(API + '/api/scan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        product_name: 'Product in image', claim: 'visible sustainability claims',
        image_base64: base64, media_type: mediaType,
        session_id, lat: userLat, lng: userLng, location_name: userCity
      })
    });
    clearTimeout(t);
    const d = await apiRes.json();
    if (d.error) throw new Error(d.error);
    handleScanResult(d);
  } catch (e) {
    hideAnalyzing();
    showToast('Analysis failed — try typing it in');
  }
}

// ─── MANUAL INPUT ─────────────────────────────────────────────────────────────
function showManualInput() {
  document.getElementById('manual-modal').classList.remove('hidden');
  setTimeout(() => document.getElementById('input-product').focus(), 150);
}
function closeManualInput() { document.getElementById('manual-modal').classList.add('hidden'); }

async function submitManualScan() {
  const product = document.getElementById('input-product').value.trim();
  const claim = document.getElementById('input-claim').value.trim();
  const price = document.getElementById('input-price').value.trim();
  const store = document.getElementById('input-store').value.trim();
  if (!product) { showToast('Enter a product name'); return; }
  closeManualInput();
  showAnalyzing();
  try {
    const ctrl2 = new AbortController();
    const t2 = setTimeout(() => ctrl2.abort(), 45000);
    const res = await fetch(API + '/api/scan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      signal: ctrl2.signal,
      body: JSON.stringify({
        product_name: product, claim: claim || 'sustainability claim',
        session_id, lat: userLat, lng: userLng,
        location_name: store || userCity || null, price: price || null
      })
    });
    clearTimeout(t2);
    const d = await res.json();
    if (d.error) throw new Error(d.error);
    handleScanResult(d);
  } catch (e) { hideAnalyzing(); showToast('Analysis failed: ' + e.message); }
}

let _analyzeTimer = null;
function showAnalyzing() {
  document.getElementById('analyzing').classList.remove('hidden');
  // Reset phases
  document.getElementById('an-p1').className = 'an-phase active';
  document.getElementById('an-p2').className = 'an-phase';
  document.getElementById('an-title').textContent = 'Reading the label\u2026';
  document.getElementById('an-sub').textContent = 'Checking 5 sustainability signals';
  if (_analyzeTimer) clearTimeout(_analyzeTimer);
  _analyzeTimer = setTimeout(() => {
    document.getElementById('an-p1').className = 'an-phase done';
    document.getElementById('an-p2').className = 'an-phase active';
    document.getElementById('an-title').textContent = 'Scoring the claims\u2026';
    document.getElementById('an-sub').textContent = 'Almost there';
  }, 3000);
}
function hideAnalyzing() {
  document.getElementById('analyzing').classList.add('hidden');
  if (_analyzeTimer) { clearTimeout(_analyzeTimer); _analyzeTimer = null; }
}

function handleScanResult(d) {
  // API wraps in {session_id, scan} or returns scan directly
  const scan = d.scan || d;
  if (!session_id) { session_id = d.session_id || nanoid(); localStorage.setItem('gs_session', session_id); }
  hideAnalyzing();
  showResult(scan);
}

// ─── RESULT ───────────────────────────────────────────────────────────────────
function showResult(scan) {
  currentScan = scan;
  if (isSpeaking) { speechSynthesis.cancel(); isSpeaking = false; }
  const sc = Number(scan.score) || 0;

  // ── Hero header ──
  document.getElementById('r-grade-letter').textContent = '0';
  document.getElementById('r-grade-num').textContent = '/100';
  document.getElementById('r-name').textContent = noEmoji(scan.product_name || 'Unknown product');
  document.getElementById('r-brand-cat').textContent =
    [scan.brand, scan.category ? scan.category.replace(/_/g,' ') : ''].filter(Boolean).join(' · ');
  const ykoLink = document.getElementById('r-yko-link');
  if (scan.brand) {
    const slug = scan.brand.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    ykoLink.href = 'https://yko.earth/brand/' + slug + '/';
    ykoLink.style.display = '';
  } else { ykoLink.style.display = 'none'; }
  document.getElementById('r-loc').textContent = scan.location_name || userCity || '';
  const priceEl = document.getElementById('r-price');
  if (scan.price) { priceEl.textContent = scan.price; priceEl.style.display = ''; }
  else priceEl.style.display = 'none';

  // ── Rubric data ──
  const rb = scan.rubric || {};
  const rubricRows = [
    ['Claims & Disclosure', 'Specific and verifiable?', rb.claims ?? rb.specificity ?? 0],
    ['Certifications', 'Real third-party audits', rb.certifications ?? rb.transparency ?? 0],
    ['Packaging Lifecycle', 'Weight, format, end-of-life', rb.packaging_lifecycle ?? rb.third_party ?? 0],
    ['Ingredient Impact', 'What is actually in it', rb.ingredient_impact ?? rb.biggest_impact ?? 0],
    ['Supply Chain', 'Origin, distance, footprint', rb.supply_chain ?? rb.marketing_vs_action ?? 0],
  ];
  const tips = scan.tips || [];

  // ── Build 3-tier body ──
  document.getElementById('r-body').innerHTML =

    // ── TIER 1: Instant answer (above fold) ──
    buildInstantCard(scan, rubricRows)

    // Win / Tradeoff — fast context
    + ((scan.win || scan.tradeoff)
      ? '<div class="card" style="margin-top:0">'
        + '<div class="win-trade">'
        + (scan.win ? '<div class="wt-block wt-win"><div class="wt-label">Win</div><div class="wt-text">' + escH(noEmoji(scan.win)) + '</div></div>' : '')
        + (scan.tradeoff ? '<div class="wt-block wt-trade"><div class="wt-label">Trade-off</div><div class="wt-text">' + escH(noEmoji(scan.tradeoff)) + '</div></div>' : '')
        + '</div></div>'
      : '')

    // ── TIER 2: Progress + Swap CTA ──
    + buildProgressStrip(sc)
    + '<div id="swap-cta-slot"></div>'

    // Full breakdown toggle
    + '<div class="breakdown-toggle" onclick="toggleBreakdown(this)">'
    + '<span class="bt-text">Full breakdown</span>'
    + '<span class="bt-chev" id="bt-chev"><svg viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg></span>'
    + '</div>'

    // ── TIER 3: Full breakdown (collapsed until tapped) ──
    + '<div class="breakdown-body" id="breakdown-body">'
    + buildFullBreakdown(scan, rubricRows, tips)
    + '</div>';

  setActiveNav('');
  show('s-result');
  document.getElementById('r-body').scrollTop = 0;

  // Animate score ring with count-up (80ms delay lets the screen transition settle)
  setTimeout(() => animateScoreRing(sc), 80);

  // Async extras into slots inside breakdown body
  if (scan.brand) loadYkoCard(scan.brand, scan.product_name || '', scan);
  loadSustainUrl(scan);

  // Gamification
  recordScan(sc);

  // Lazy-load swap suggestions 450ms post-render (non-blocking)
  setTimeout(() => loadSwaps(scan), 450);
}

function loadSustainUrl(scan) {
  const slot = document.getElementById('sustain-url-slot');
  if (!slot) return;
  const url = scan.sustainability_url;
  if (!url || url === 'null' || !url.startsWith('http')) return;
  setTimeout(() => {
    if (!document.getElementById('sustain-url-slot')) return;
    slot.innerHTML = '<div style="margin:0 0 10px;padding:12px 16px;background:var(--pale);border-radius:16px;display:flex;align-items:center;justify-content:space-between">'
      + '<div><div style="font-size:11px;font-weight:700;letter-spacing:1px;color:var(--moss);text-transform:uppercase;margin-bottom:3px">Sustainability page</div>'
      + '<div style="font-size:13px;color:var(--forest)">' + escH(url.split('//').pop().replace('www.','').split('/')[0]) + '</div></div>'
      + '<a href="' + escH(url) + '" target="_blank" rel="noopener" style="background:var(--forest);color:white;border:none;border-radius:10px;padding:7px 14px;font-size:12px;font-weight:600;font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;text-decoration:none;white-space:nowrap">View \u2192</a>'
      + '</div>';
  }, 600);
}

function shareScore() {
  if (!currentScan) return;
  const sc = Number(currentScan.score) || 0;
  const text = (currentScan.product_name || 'This product') + ' scored ' + sc + '/100 on GreenSpecs.'
    + (currentScan.headline ? ' ' + currentScan.headline : '');
  const url = 'https://greenspecs.app';
  if (navigator.share) {
    navigator.share({ title: 'GreenSpecs Score', text, url }).catch(() => {});
  } else {
    navigator.clipboard.writeText(text + ' ' + url).then(() => showToast('Copied to clipboard')).catch(() => showToast('Score: ' + sc + '/100'));
  }
}

// ─── SCORE RING ANIMATION ─────────────────────────────────────────────────────
function animateScoreRing(score) {
  const fill = document.getElementById('r-ring-fill');
  const numEl = document.getElementById('r-grade-letter');
  if (!fill || !numEl) return;
  const circ = 314.16; // 2 * pi * 50
  const targetOffset = circ * (1 - score / 100);
  const ringColor = score >= 80 ? '#95D5B2' : score >= 60 ? '#FCD34D' : '#FCA5A5';
  fill.style.stroke = ringColor;
  fill.style.strokeDashoffset = targetOffset;
  // Number count-up
  const duration = 950;
  const startTime = performance.now();
  function step(now) {
    const p = Math.min((now - startTime) / duration, 1);
    const eased = 1 - Math.pow(1 - p, 3);
    numEl.textContent = Math.round(eased * score);
    if (p < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

// ─── INSTANT CARD — rate & improve ───────────────────────────────────────────
function buildInstantCard(scan, rubricRows) {
  var sc = Number(scan.score) || 0;
  var grade = letterGrade(sc);
  var gColor = gradeColor(sc);
  var verdictText = scan.verdict_tag || scan.headline || '';

  // Signal chips — prefer Gemini text labels, color from rubric scores
  var rb = scan.rubric || {};
  var chips = [];
  var pkgScore = Number(rb.packaging_lifecycle !== undefined ? rb.packaging_lifecycle : (rb.third_party !== undefined ? rb.third_party : 0));
  var ingScore = Number(rb.ingredient_impact !== undefined ? rb.ingredient_impact : (rb.biggest_impact !== undefined ? rb.biggest_impact : 0));
  var clmScore = Number(rb.claims !== undefined ? rb.claims : (rb.specificity !== undefined ? rb.specificity : 0));
  var crtScore = Number(rb.certifications !== undefined ? rb.certifications : (rb.transparency !== undefined ? rb.transparency : 0));

  function chipClass(score) { return score >= 14 ? 'good' : score >= 9 ? 'warn' : 'bad'; }

  if (scan.ingredients) chips.push({ text: scan.ingredients, cls: chipClass(ingScore) });
  if (scan.packaging)   chips.push({ text: scan.packaging,   cls: chipClass(pkgScore) });
  if (scan.transparency_label) chips.push({ text: scan.transparency_label, cls: chipClass(clmScore) });

  // Fallback: rubric-based text chips
  if (!chips.length) {
    var shortLabels = ['Claims', 'Certs', 'Packaging', 'Ingredients', 'Supply'];
    var rpills = rubricRows.map(function(r, i) {
      return { label: shortLabels[i], val: Number(r[2]) };
    }).sort(function(a, b) { return b.val - a.val; });
    [rpills[0], rpills[rpills.length - 1]].forEach(function(p) {
      chips.push({ text: p.label + ' ' + p.val + '/20', cls: chipClass(p.val) });
    });
  }

  // Already rated?
  var scanId = scan.id || '';
  var prevRating = scanId ? localStorage.getItem('gs_rated_' + scanId) : null;

  var thumbUpSVG = '<svg viewBox="0 0 24 24"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3z"/><path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>';
  var thumbDnSVG = '<svg viewBox="0 0 24 24"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3z"/><path d="M17 2h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/></svg>';
  var plusSVG = '<svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';

  var goodCls = 'ri-action' + (prevRating === 'good' ? ' selected-good' : '');
  var badCls  = 'ri-action' + (prevRating === 'bad'  ? ' selected-bad'  : '');

  return '<div class="ri-card">'
    + '<div class="ri-summary">'
    + '<div class="ri-grade" style="background:' + gColor + '1a;color:' + gColor + ';border:1.5px solid ' + gColor + '33">' + escH(grade) + '</div>'
    + (verdictText ? '<div class="ri-verdict">' + escH(noEmoji(verdictText)) + '</div>' : '')
    + '</div>'
    + (chips.length ? '<div class="ri-chips">'
        + chips.slice(0, 3).map(function(c) {
            return '<div class="ri-chip ' + c.cls + '">' + escH(noEmoji(c.text)) + '</div>';
          }).join('')
        + '</div>' : '')
    + '<div class="ri-actions">'
    + '<button class="' + goodCls + '" id="ri-good" onclick="rateGood()">' + thumbUpSVG + 'Accurate</button>'
    + '<button class="' + badCls  + '" id="ri-bad"  onclick="rateBad()">'  + thumbDnSVG + 'Off</button>'
    + '<button class="ri-action ri-add" onclick="openInsightSheet()">' + plusSVG + 'Add insight</button>'
    + '</div>'
    + '</div>';
}

// ─── PROGRESS STRIP (gamification) ───────────────────────────────────────────
function buildProgressStrip(currentScore) {
  var stats = getTripStats();
  var scanNum = stats.count + 1; // +1 because recordScan runs after body builds
  var betterCount = stats.better + (currentScore >= 60 ? 1 : 0);
  var maxDots = 5;
  var dotCount = Math.min(scanNum, maxDots);
  var dotsHtml = '';
  for (var i = 0; i < Math.max(dotCount, 3); i++) {
    if (i > maxDots - 1) break;
    if (i < scanNum - 1) dotsHtml += '<div class="ps-dot filled"></div>';
    else if (i === scanNum - 1) dotsHtml += '<div class="ps-dot current"></div>';
    else dotsHtml += '<div class="ps-dot"></div>';
  }
  var text = '';
  if (scanNum === 1) text = 'First scan of your trip.';
  else if (scanNum <= 5) text = '<strong>Scan ' + scanNum + '</strong> of your trip';
  else text = '<strong>' + scanNum + ' products</strong> scanned this session';
  if (betterCount > 0) {
    text += ' \u00b7 <strong>' + betterCount + ' better choice' + (betterCount !== 1 ? 's' : '') + '</strong>';
  }
  return '<div class="progress-strip"><div class="ps-dots">' + dotsHtml + '</div>'
    + '<div class="ps-text">' + text + '</div></div>';
}

// ─── FULL BREAKDOWN (collapsed tier-3 content) ────────────────────────────────
function buildFullBreakdown(scan, rubricRows, tips) {
  var verdict = scan.verdict || buildVerdict(scan);
  return ''
    + (scan.headline ? '<div class="gs-headline">' + escH(noEmoji(scan.headline)) + '</div>' : '')
    + ((scan.packaging || scan.ingredients || scan.transport || scan.transparency_label)
      ? '<div class="card quick-view">'
        + (scan.packaging ? '<div class="qv-row"><span class="qv-label">Packaging</span><span class="qv-val">' + escH(noEmoji(scan.packaging)) + '</span></div>' : '')
        + (scan.ingredients ? '<div class="qv-row"><span class="qv-label">Ingredients</span><span class="qv-val">' + escH(noEmoji(scan.ingredients)) + '</span></div>' : '')
        + (scan.transport ? '<div class="qv-row"><span class="qv-label">Transport</span><span class="qv-val">' + escH(noEmoji(scan.transport)) + '</span></div>' : '')
        + (scan.transparency_label ? '<div class="qv-row"><span class="qv-label">Transparency</span><span class="qv-val">' + escH(noEmoji(scan.transparency_label)) + '</span></div>' : '')
        + '</div>' : '')
    + (scan.real_story
      ? '<div class="card"><div class="card-label">The real story</div><div class="verdict-text">' + escH(noEmoji(scan.real_story)) + '</div></div>'
      : (!scan.headline && verdict ? '<div class="card"><div class="card-label">Verdict</div><div class="verdict-text">' + escH(verdict) + '</div></div>' : ''))
    + (scan.why_it_matters
      ? '<div class="card"><div class="card-label">Why it matters</div><div class="why-text">' + escH(noEmoji(scan.why_it_matters)) + '</div></div>' : '')
    + (scan.compare_hook ? '<div class="compare-hook">' + escH(noEmoji(scan.compare_hook)) + '</div>' : '')
    + (scan.better_path
      ? '<div class="card better-path-card"><div class="card-label">What better looks like</div><div class="better-path-text">' + escH(noEmoji(scan.better_path)) + '</div></div>' : '')
    + '<div class="card"><div class="card-label">The 5 Signals</div>'
    + rubricRows.map(function(row) {
        var label = row[0], sub = row[1], val = Number(row[2]);
        var pct = Math.round((val / 20) * 100);
        var color = val >= 15 ? 'var(--sage)' : val >= 10 ? 'var(--amber)' : '#EF4444';
        return '<div class="rbar"><div class="rbar-row">'
          + '<span class="rbar-label">' + escH(label) + '<span class="rbar-sub"> \u2014 ' + escH(sub) + '</span></span>'
          + '<span class="rbar-val" style="color:' + color + '">' + val + '/20</span></div>'
          + '<div class="rbar-track"><div class="rbar-fill" style="width:' + pct + '%;background:' + color + '"></div></div></div>';
      }).join('')
    + '</div>'
    + ((scan.scope && scan.scope.scope3) || scan.scope3_text
      ? '<div class="card"><div class="card-label">Where the footprint actually hides</div>'
        + '<div class="scope-row"><div class="scope-bub s3">S3</div><div>'
        + '<div class="scope-desc">' + escH((scan.scope && scan.scope.scope3) || scan.scope3_text || '') + '</div>'
        + '</div></div></div>' : '')
    + (tips.length
      ? '<div class="card"><div class="card-label">Worth knowing</div>'
        + tips.map(function(t) {
            return '<div style="font-size:17px;color:var(--text-mid);padding:9px 0;border-bottom:1px solid var(--warm);line-height:1.65;display:flex;gap:8px"><span style="color:var(--sage);flex-shrink:0">\u2192</span><span>' + escH(noEmoji(t)) + '</span></div>';
          }).join('') + '</div>' : '')
    + '<div id="sustain-url-slot"></div>'
    + (scan.brand ? '<div id="yko-card-slot" style="min-height:72px"></div>' : '')
    + '<div class="action-row">'
    + '<button class="action-btn primary" onclick="addToCompare()">Compare</button>'
    + '<button class="action-btn secondary" onclick="shareScore()">Share</button>'
    + '</div>';
}

// ─── RATE & IMPROVE ───────────────────────────────────────────────────────────
function rateGood() { rateScore('good'); }
function rateBad()  { rateScore('bad');  }
function rateScore(rating) {
  if (!currentScan) return;
  var scanId = currentScan.id || '';
  var ratedKey = scanId ? 'gs_rated_' + scanId : null;
  // Update button state immediately
  var goodBtn = document.getElementById('ri-good');
  var badBtn  = document.getElementById('ri-bad');
  if (goodBtn) goodBtn.className = 'ri-action' + (rating === 'good' ? ' selected-good' : '');
  if (badBtn)  badBtn.className  = 'ri-action' + (rating === 'bad'  ? ' selected-bad'  : '');
  // Persist
  if (ratedKey) localStorage.setItem(ratedKey, rating);
  // Save to backend (fire and forget)
  if (scanId) {
    fetch('/api/rate/' + scanId, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rating: rating, session_id: session_id })
    }).catch(function() {});
  }
  if (rating === 'bad') {
    setTimeout(function() { openInsightSheet(); }, 180);
  } else {
    showToast('Thanks \u2014 helps us calibrate');
  }
}

function openInsightSheet() {
  document.getElementById('insight-backdrop').classList.add('open');
  document.getElementById('insight-sheet').classList.add('open');
  setTimeout(function() {
    var el = document.getElementById('insight-input');
    if (el) el.focus();
  }, 360);
}
function closeInsightSheet() {
  document.getElementById('insight-backdrop').classList.remove('open');
  document.getElementById('insight-sheet').classList.remove('open');
}

async function submitInsight() {
  var text = (document.getElementById('insight-input').value || '').trim();
  if (!text) { showToast('Add what you see on the label'); return; }
  if (!currentScan) return;
  closeInsightSheet();
  // Save the insight as training data
  var scanId = currentScan.id || '';
  if (scanId) {
    fetch('/api/rate/' + scanId, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rating: 'insight', insight: text, session_id: session_id })
    }).catch(function() {});
  }
  // Re-score — inject user context into the claim so cache key is unique
  showAnalyzing();
  try {
    var ctrl = new AbortController();
    var t = setTimeout(function() { ctrl.abort(); }, 45000);
    var claim = (currentScan.primary_claim || 'sustainability claim')
      + ' [User added: ' + text + ']';
    var res = await fetch('/api/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        product_name: currentScan.product_name,
        claim: claim,
        session_id: session_id,
        lat: userLat, lng: userLng,
        location_name: userCity || currentScan.location_name || null
      })
    });
    clearTimeout(t);
    var d = await res.json();
    if (d.error) throw new Error(d.error);
    hideAnalyzing();
    showResult(d.scan || d);
    showToast('Score updated with your insight');
  } catch (e) {
    hideAnalyzing();
    showToast('Could not re-score \u2014 try again');
  }
}

// ─── BREAKDOWN TOGGLE ─────────────────────────────────────────────────────────
function toggleBreakdown(toggleEl) {
  var body = document.getElementById('breakdown-body');
  var chev = document.getElementById('bt-chev');
  if (!body) return;
  var isOpen = body.style.maxHeight && body.style.maxHeight !== '0px';
  if (!isOpen) {
    body.style.maxHeight = body.scrollHeight + 'px';
    body.style.opacity = '1';
    if (chev) chev.classList.add('open');
  } else {
    body.style.maxHeight = '0px';
    body.style.opacity = '0';
    if (chev) chev.classList.remove('open');
  }
}

// ─── GAMIFICATION ─────────────────────────────────────────────────────────────
function getTodayKey() {
  return 'gs_trip_' + new Date().toISOString().slice(0, 10);
}
function getTripStats() {
  var raw = localStorage.getItem(getTodayKey());
  return raw ? JSON.parse(raw) : { count: 0, better: 0 };
}
function saveTripStats(stats) {
  localStorage.setItem(getTodayKey(), JSON.stringify(stats));
}
function recordScan(score) {
  var stats = getTripStats();
  stats.count = (stats.count || 0) + 1;
  if (score >= 60) stats.better = (stats.better || 0) + 1;
  saveTripStats(stats);
  var lifetime = (parseInt(localStorage.getItem('gs_total_scans') || '0', 10)) + 1;
  localStorage.setItem('gs_total_scans', String(lifetime));
  checkMilestone(lifetime);
}
function checkMilestone(lifetime) {
  var milestones = {
    5: ['5 products scanned.', 'You are starting to see real patterns.'],
    10: ['10 products scanned.', 'You are getting good at spotting greenwashing.'],
    25: ['25 products scanned.', 'You are building real sustainability literacy.'],
    50: ['50 scans.', 'You have a sharper eye than most shoppers.'],
    100: ['100 scans.', 'You see through labels that fool everyone else.'],
  };
  var msg = milestones[lifetime];
  if (msg) showMilestone(msg[0], msg[1]);
}
function showMilestone(title, sub) {
  var banner = document.getElementById('milestone-banner');
  if (!banner) return;
  document.getElementById('mb-title').textContent = title;
  document.getElementById('mb-sub').textContent = sub || '';
  banner.classList.add('show');
  setTimeout(function() { banner.classList.remove('show'); }, 4200);
}

// ─── SWAPS ────────────────────────────────────────────────────────────────────
var _swaps = null;

function openSwapSheet() {
  document.getElementById('swap-backdrop').classList.add('open');
  document.getElementById('swap-sheet').classList.add('open');
}
function closeSwapSheet() {
  document.getElementById('swap-backdrop').classList.remove('open');
  document.getElementById('swap-sheet').classList.remove('open');
}

async function loadSwaps(scan) {
  if (!scan || !scan.id) return;
  var ctaSlot = document.getElementById('swap-cta-slot');
  if (!ctaSlot) return;
  // Show loading state
  ctaSlot.innerHTML = '<div class="swap-cta" style="opacity:0.55;pointer-events:none">'
    + '<div class="swap-cta-left"><div class="swap-cta-title">Finding better options\u2026</div>'
    + '<div class="swap-cta-sub">Based on your category and score</div></div>'
    + '<div class="swap-cta-chevron"><svg viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg></div></div>';
  try {
    var res = await fetch('/api/swaps/' + scan.id);
    if (!res.ok) throw new Error('swaps failed');
    var d = await res.json();
    _swaps = d.swaps || [];
    if (!_swaps.length) { ctaSlot.innerHTML = ''; return; }
    // Render CTA
    var cat = (scan.category || 'this category').replace(/_/g, ' ');
    ctaSlot.innerHTML = '<div class="swap-cta" onclick="openSwapSheet()">'
      + '<div class="swap-cta-left">'
      + '<div class="swap-cta-title">' + _swaps.length + ' better option' + (_swaps.length !== 1 ? 's' : '') + ' in ' + escH(cat) + '</div>'
      + '<div class="swap-cta-sub">Tap to see alternatives</div>'
      + '</div>'
      + '<div class="swap-cta-chevron"><svg viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg></div>'
      + '</div>';
    // Pre-render swap sheet content
    renderSwapSheet(scan.category, _swaps);
  } catch (e) {
    if (ctaSlot) ctaSlot.innerHTML = '';
  }
}

function renderSwapSheet(category, swaps) {
  var titleEl = document.getElementById('swap-sheet-title');
  var bodyEl = document.getElementById('swap-sheet-body');
  if (!titleEl || !bodyEl) return;
  var cat = (category || 'this category').replace(/_/g, ' ');
  titleEl.textContent = 'Better options in ' + cat;
  if (!swaps || !swaps.length) {
    bodyEl.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-light);font-size:13px">No specific alternatives found.</div>';
    return;
  }
  bodyEl.innerHTML = swaps.map(function(sw) {
    var sc = Number(sw.estimated_score) || 0;
    var bg = sc >= 70 ? 'var(--pale)' : sc >= 55 ? 'var(--amber-bg)' : 'var(--warm)';
    var fg = sc >= 70 ? 'var(--moss)' : sc >= 55 ? '#92400e' : 'var(--text-mid)';
    var nameArg = JSON.stringify(String(sw.name || ''));
    var brandArg = JSON.stringify(String(sw.brand || ''));
    return '<div class="swap-card">'
      + '<div class="sc-top">'
      + '<div class="sc-score" style="background:' + bg + '">'
      + '<div class="sc-score-num" style="color:' + fg + '">' + sc + '</div>'
      + '<div class="sc-score-sub" style="color:' + fg + '">/100</div>'
      + '</div>'
      + '<div class="sc-info">'
      + '<div class="sc-name">' + escH(sw.name || '') + '</div>'
      + '<div class="sc-brand">' + escH(sw.brand || '') + '</div>'
      + '</div></div>'
      + '<div class="sc-why">' + escH(sw.why_better || '') + '</div>'
      + '<button class="sc-scan-btn" onclick="scanSwapProduct(' + nameArg + ',' + brandArg + ')">'
      + '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M3 9V6a2 2 0 0 1 2-2h3M15 4h3a2 2 0 0 1 2 2v3M21 15v3a2 2 0 0 1-2 2h-3M9 20H6a2 2 0 0 1-2-2v-3"/></svg>'
      + 'Scan to compare'
      + '</button></div>';
  }).join('');
}

function scanSwapProduct(name, brand) {
  closeSwapSheet();
  document.getElementById('input-product').value = ((brand ? brand + ' ' : '') + name).trim();
  document.getElementById('input-claim').value = '';
  showManualInput();
}

// Carbon SVG arrow — no emoji
const YKO_ARROW_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="14" height="14" fill="currentColor"><path d="M18 6l-1.414 1.414L24.172 15H4v2h20.172l-7.586 7.586L18 26l10-10z"/></svg>';
// Carbon SVG analytics icon for YKO card
const YKO_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="20" height="20" fill="rgba(255,255,255,0.8)"><path d="M11 2H2v9h9V2zm-2 7H4V4h5v5zM20 2h-5v2h5v2h-5v2h5v2h-7V2h-2v10h11V2h-2zM2 20v10h10V20H2zm8 8H4v-6h6v6zM22 20h-2v4h-4v2h4v4h2v-4h4v-2h-4z"/></svg>';

async function loadYkoCard(brandName, productName, scan) {
  const slot = document.getElementById('yko-card-slot');
  if (!slot) return;

  // Show loading state
  slot.innerHTML = '<div style="padding:16px 18px;margin:0 14px 10px;background:rgba(15,56,32,0.4);border-radius:22px;font-size:12px;color:rgba(255,255,255,0.4);font-family:monospace;letter-spacing:0.05em">Checking YKO score…</div>';

  try {
    const res = await fetch('https://yko-api.phill-carter.workers.dev/api/scan-signal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brand_name: brandName, product_name: productName, scan: scan || null }),
    });
    if (!res.ok) throw new Error('signal failed');
    const d = await res.json();

    if (d.scored) {
      // Full YKO score available — show it
      var tierColors = {
        'Benchmark Leader': '#1D9E75', 'Committed': '#5DCAA5',
        'Progressing': '#BA7517', 'Early Stage': '#E24B4A', 'Needs Work': '#A32D2D',
      };
      var tc = tierColors[d.tier] || '#5DCAA5';
      slot.innerHTML = '<a class="yko-card" href="' + d.brand_url + '" target="_blank" rel="noopener">'
        + '<div class="yko-icon">' + YKO_ICON_SVG + '</div>'
        + '<div class="yko-text">'
        + '<div class="yko-label">Independent sustainability score</div>'
        + '<div class="yko-name">' + escH(d.brand_name) + '</div>'
        + '<span class="yko-tier-label" style="background:' + tc + '22;color:' + tc + '">' + d.tier + '</span>'
        + '</div>'
        + '<div style="text-align:right">'
        + '<div class="yko-score-badge" style="color:' + tc + '">' + d.yko_total + '</div>'
        + '<div class="yko-arrow">' + YKO_ARROW_SVG + '</div>'
        + '</div>'
        + '</a>';
    } else {
      // Not yet scored — show request link
      slot.innerHTML = '<a class="yko-card" href="' + d.brand_url + '" target="_blank" rel="noopener">'
        + '<div class="yko-icon">' + YKO_ICON_SVG + '</div>'
        + '<div class="yko-text">'
        + '<div class="yko-label">YKO.earth — not yet scored</div>'
        + '<div class="yko-name">Request a score for ' + escH(d.brand_name) + '</div>'
        + '</div>'
        + '<div class="yko-arrow">' + YKO_ARROW_SVG + '</div>'
        + '</a>';
    }
  } catch {
    // Fail silently — the card just won't show
    slot.innerHTML = '';
  }
}

function buildVerdict(scan) {
  const sc = Number(scan.score) || 0;
  if (sc >= 80) return "This one genuinely delivers. The claims are backed by real data, and the effort shows. It's not perfect — nothing is — but this brand is doing the work.";
  if (sc >= 65) return "Solid in the areas that matter. There are genuine commitments here, and the gaps are mostly the industry-wide kind — hard to solve alone. Worth knowing what's not on the label.";
  if (sc >= 50) return "A mixed picture. Some real effort, some marketing convenience. The claim covers something real, but the bigger part of the footprint isn't mentioned. That's common — and worth knowing.";
  return "The claim is technically true but strategically selected. It points at something small while the bigger footprint stays off the label. You deserve the full picture, and this label isn't giving it to you.";
}

// ─── VOICE TTS ────────────────────────────────────────────────────────────────
function toggleSpeak() {
  if (isSpeaking) { speechSynthesis.cancel(); isSpeaking = false; updatePlayBtn(false); return; }
  if (!('speechSynthesis' in window)) { showToast('Voice not supported here'); return; }
  if (!currentScan) return;
  const sc = Number(currentScan.score) || 0;
  const grade = letterGrade(sc);
  const verdict = currentScan.verdict || buildVerdict(currentScan);
  const notOnLabel = (currentScan.whats_not_on_label || currentScan.what_missing || []).slice(0,2);
  const text = currentScan.product_name + ' scores ' + sc + ' out of 100, a ' + grade + '. '
    + verdict
    + (notOnLabel.length ? " What's not on the label: " + notOnLabel.join('. ') + '.' : '');
  speechSynthesis.cancel();
  const utt = new SpeechSynthesisUtterance(text);
  utt.rate = 0.93; utt.pitch = 1.0;
  const voices = speechSynthesis.getVoices();
  const v = voices.find(v => v.lang === 'en-US' && (v.name.includes('Samantha') || v.name.includes('Karen')))
         || voices.find(v => v.lang.startsWith('en'));
  if (v) utt.voice = v;
  utt.onstart = () => { isSpeaking = true; updatePlayBtn(true); };
  utt.onend = utt.onerror = () => { isSpeaking = false; updatePlayBtn(false); };
  speechSynthesis.speak(utt);
}
function updatePlayBtn(playing) {
  const btn = document.getElementById('voice-play-btn');
  if (!btn) return;
  btn.classList.toggle('playing', playing);
  btn.innerHTML = playing
    ? '<svg viewBox="0 0 16 16" fill="white"><rect x="3" y="2" width="3" height="12"/><rect x="10" y="2" width="3" height="12"/></svg>'
    : '<svg viewBox="0 0 16 16" fill="white"><polygon points="4,2 14,8 4,14"/></svg>';
}

// ─── COMPARE SNAP ─────────────────────────────────────────────────────────────────
let compareSnaps = [];

function showCompare() { show('s-compare'); setActiveNav('s-compare'); renderCompareSnap(); }

function startCompareSnap() {
  if (compareSnaps.length >= 3) { showToast('Max 3 products to compare'); return; }
  var inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*'; inp.capture = 'environment';
  inp.onchange = function(e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    var idx = compareSnaps.length;
    var entry = { status: 'loading', data: null, timer: null };
    compareSnaps.push(entry);
    renderCompareSnap();
    entry.timer = setTimeout(function() {
      var el = document.getElementById('cmp-reading-' + idx);
      if (el) el.style.display = 'block';
    }, 4000);
    var t0 = performance.now();
    fileToBase64(file).then(function(b64) {
      return fetch(API + '/api/compare-snap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_base64: b64, media_type: file.type || 'image/jpeg', session_id: session_id })
      });
    }).then(function(r) { return r.json(); }).then(function(d) {
      clearTimeout(entry.timer);
      console.log('Compare card ' + idx + ' resolved in ' + Math.round(performance.now() - t0) + 'ms');
      compareSnaps[idx].status = 'done';
      compareSnaps[idx].data = d.result || d;
      renderCompareSnap();
    }).catch(function() {
      clearTimeout(entry.timer);
      compareSnaps[idx].status = 'error';
      renderCompareSnap();
    });
  };
  inp.click();
}

function clearCompareSnap() { compareSnaps = []; renderCompareSnap(); }
function addToCompare() { showToast('Use Compare tab to snap products'); }

function ingRank(q) { return {clean:4,'mostly clean':3,mixed:2,avoid:1}[q]||0; }
function susRank(q) { return {high:4,medium:3,low:2,minimal:1}[q]||0; }
function ingClass(q) { return {clean:'clean','mostly clean':'mostly-clean',mixed:'mixed',avoid:'avoid'}[q]||''; }
function susClass(q) { return {high:'high',medium:'medium',low:'low',minimal:'minimal'}[q]||''; }

function renderCompareSnap() {
  var hero = document.getElementById('cmp-entry-hero');
  var area = document.getElementById('cmp-cards-area');
  var more = document.getElementById('cmp-add-more');
  var sumArea = document.getElementById('cmp-summary-area');
  if (!hero || !area) return;
  if (compareSnaps.length === 0) {
    hero.style.display = '';
    area.innerHTML = '';
    if (more) more.style.display = 'none';
    if (sumArea) { sumArea.style.display = 'none'; sumArea.innerHTML = ''; }
    return;
  }
  hero.style.display = 'none';
  // Find winners
  var ingWinner = -1, susWinner = -1, priceWinner = -1;
  var bestIng = 0, bestSus = 0, bestPrice = Infinity;
  var doneCount = 0;
  compareSnaps.forEach(function(s, i) {
    if (s.status !== 'done' || !s.data) return;
    doneCount++;
    var ing = ingRank(s.data.ingredients_quality);
    var sus = susRank(s.data.sustainability_level);
    var pr = s.data.price_per_unit_num || Infinity;
    if (ing > bestIng) { bestIng = ing; ingWinner = i; }
    if (sus > bestSus) { bestSus = sus; susWinner = i; }
    if (pr < bestPrice) { bestPrice = pr; priceWinner = i; }
  });
  if (doneCount < 2) { ingWinner = -1; susWinner = -1; priceWinner = -1; }
  // Build cards HTML
  var html = '';
  compareSnaps.forEach(function(snap, idx) {
    if (snap.status === 'loading') {
      html += '<div class="cmp-skeleton" id="cmp-card-' + idx + '">'
        + '<div class="sk-line tall med"></div><div class="sk-line short"></div>'
        + '<div style="height:6px"></div>'
        + '<div class="sk-line"></div><div class="sk-line"></div><div class="sk-line short"></div>'
        + '<div class="cmp-reading" id="cmp-reading-' + idx + '" style="display:none">still reading label...</div>'
        + '</div>';
    } else if (snap.status === 'error') {
      html += '<div class="cmp-card" id="cmp-card-' + idx + '">'
        + '<div class="cmp-card-name" style="color:var(--text-light)">Could not read label</div>'
        + '<div class="cmp-card-brand">Try a clearer photo</div></div>';
    } else {
      var d = snap.data;
      var iW = ingWinner === idx, sW = susWinner === idx, pW = priceWinner === idx;
      var ingQ = d.ingredients_quality || 'not detected';
      var susL = d.sustainability_level || 'not detected';
      var priceV = d.price_per_unit || d.price_detected || 'not detected';
      html += '<div class="cmp-card" id="cmp-card-' + idx + '">'
        + '<div class="cmp-card-name">' + escH(d.product_name || 'Product ' + (idx+1)) + '</div>'
        + '<div class="cmp-card-brand">' + escH(d.brand || '') + '</div>'
        + '<div class="cmp-card-rows">'
        + '<div class="cmp-card-row' + (iW ? ' winner' : '') + '">'
        + '<span class="cmp-row-label">Ingredients</span>'
        + '<div class="cmp-row-val-wrap"><div class="cmp-row-val ' + ingClass(d.ingredients_quality) + '">' + escH(ingQ) + '</div>'
        + (d.ingredients_notes ? '<div class="cmp-row-note">' + escH(d.ingredients_notes) + '</div>' : '') + '</div></div>'
        + '<div class="cmp-card-row' + (sW ? ' winner' : '') + '">'
        + '<span class="cmp-row-label">Sustainability</span>'
        + '<div class="cmp-row-val-wrap"><div class="cmp-row-val ' + susClass(d.sustainability_level) + '">' + escH(susL) + '</div>'
        + (d.sustainability_notes ? '<div class="cmp-row-note">' + escH(d.sustainability_notes) + '</div>' : '') + '</div></div>'
        + '<div class="cmp-card-row' + (pW ? ' winner' : '') + '">'
        + '<span class="cmp-row-label">Price</span>'
        + '<div class="cmp-row-val-wrap"><div class="cmp-row-val">' + escH(priceV) + '</div></div></div>'
        + '</div></div>';
    }
  });
  area.innerHTML = html;
  if (more) more.style.display = (compareSnaps.length > 0 && compareSnaps.length < 3) ? '' : 'none';
  // Summary
  var dones = compareSnaps.filter(function(s) { return s.status === 'done' && s.data; }).map(function(s) { return s.data; });
  if (dones.length >= 2 && sumArea) {
    sumArea.innerHTML = '<div class="cmp-summary-bar"><div class="cmp-summary-label">Bottom line</div>' + escH(buildSnapSummary(dones)) + '</div>';
    sumArea.style.display = '';
  } else if (sumArea) { sumArea.style.display = 'none'; }
}

function buildSnapSummary(datas) {
  var ranked = datas.map(function(d) {
    return { d: d, s: ingRank(d.ingredients_quality) + susRank(d.sustainability_level) };
  }).sort(function(a,b) { return b.s - a.s; });
  var winner = ranked[0].d;
  var loser = ranked[ranked.length-1].d;
  var wName = (winner.brand || winner.product_name || 'One').split(' ')[0];
  var lName = (loser.brand || loser.product_name || 'Another').split(' ')[0];
  if (ranked[0].s === ranked[ranked.length-1].s) return 'Similar overall — price and availability are the deciding factors.';
  if (winner.ingredients_quality === 'clean' && loser.ingredients_quality !== 'clean') return wName + ' has cleaner ingredients — the stronger pick.';
  if (winner.sustainability_level === 'high' && loser.sustainability_level !== 'high') return wName + ' leads on sustainability vs ' + lName + '.';
  return wName + ' edges ahead on ingredients and sustainability vs ' + lName + '.';
}

function saveScan() { showToast('Saved to this session'); }

// ─── MY SCANS ─────────────────────────────────────────────────────────────────
async function loadMyScans() {
  const grid = document.getElementById('scans-grid');
  if (!session_id) { grid.innerHTML = '<div style="grid-column:1/-1;padding:40px;text-align:center;color:var(--text-light);font-size:13px">Your scans will appear here.</div>'; return; }
  try {
    const res = await fetch(API + '/api/session/' + session_id + '/scans');
    const data = await res.json();
    const scans = data.scans || [];
    if (!scans.length) { grid.innerHTML = '<div style="grid-column:1/-1;padding:40px;text-align:center;color:var(--text-light);font-size:13px">Your scans will appear here.</div>'; return; }
    grid.innerHTML = scans.map(s => {
      const sc = Number(s.score) || 0;
      const grade = letterGrade(sc);
      const gColor = gradeColor(sc);
      return '<div class="sg-item" onclick="loadAndShowScan(&apos;' + s.id + '&apos;)">'
        + '<div class="sg-circ"><div class="sg-bg">' + catIcon(s.category) + '</div>'
        + '<div class="sg-grade" style="background:' + gColor + ';color:white">' + grade.replace('+','').replace('-','') + '</div></div>'
        + '<div class="sg-name">' + escH(s.product_name) + '</div></div>';
    }).join('');
  } catch { grid.innerHTML = '<div style="grid-column:1/-1;padding:40px;text-align:center;color:var(--text-light)">Scans are on their way.</div>'; }
}

async function loadAndShowScan(id) {
  try {
    const res = await fetch(API + '/api/scan/' + id);
    const d = await res.json();
    showResult(d.scan || d);
  } catch { showToast('Could not load scan'); }
}

// ─── NAVIGATION ───────────────────────────────────────────────────────────────
function show(id) {
  lastScreen = document.querySelector('.screen:not(.hidden)')?.id || 's-home';
  document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
  document.getElementById(id).classList.remove('hidden');
}
function setActiveNav(id) {
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.d-item').forEach(el => el.classList.remove('active'));
  const navMap = {'s-home':'nav-home','s-myscans':'nav-scans','s-compare':'nav-compare','s-learn':'nav-learn'};
  const drawMap = {'s-home':'d-home','s-myscans':'d-scans','s-compare':'d-compare','s-learn':'d-learn'};
  if (navMap[id]) document.getElementById(navMap[id])?.classList.add('active');
  if (drawMap[id]) document.getElementById(drawMap[id])?.classList.add('active');
}
function goHome() {
  show('s-home');
  setActiveNav('s-home');
  loadHomeData();
}

// ─── HOME DATA ────────────────────────────────────────────────────────────────
async function loadHomeData() {
  // Load stats
  try {
    const r = await fetch(API + '/api/stats');
    const d = await r.json();
    if (d.total_scans > 0) {
      document.getElementById('home-stats-bar').style.display = 'flex';
      document.getElementById('home-stats-text').innerHTML =
        '<strong>' + d.total_scans + ' products</strong> scanned by the community · avg score <strong>' + Math.round(d.avg_score) + '/100</strong>';
    }
  } catch {}

  // Load recent scans for this session
  if (!session_id) return;
  try {
    const r = await fetch(API + '/api/session/' + session_id + '/scans');
    const d = await r.json();
    const scans = (d.scans || []).slice(0, 6);
    if (scans.length) {
      document.getElementById('home-recent-section').style.display = '';
      window._recentScans = {};
      document.getElementById('recent-strip').innerHTML = scans.map(s => {
        window._recentScans[s.id] = s;
        const grade = letterGrade(Number(s.score));
        return '<div class="recent-chip" onclick="showResult(window._recentScans[' + JSON.stringify(s.id) + '])">'
          + '<div class="recent-chip-name">' + escH(s.product_name) + '</div>'
          + '<span class="recent-chip-grade" style="color:' + gradeColor(s.score) + '">' + s.score + '/100</span>'
          + '</div>';
      }).join('');
    }
  } catch {}
}
function showMyScans() { show('s-myscans'); setActiveNav('s-myscans'); loadMyScans(); }
function showMethod() { show('s-method'); setActiveNav(''); }
function showLearn() {
  show('s-learn');
  setActiveNav('s-learn');
  setTimeout(function() { var el = document.getElementById('learn-input'); if (el) el.focus(); }, 200);
}
function askLearn(q) {
  document.getElementById('learn-input').value = q;
  submitLearnQuestion();
}
async function submitLearnQuestion() {
  var q = document.getElementById('learn-input').value.trim();
  if (!q) { showToast('Type a question first'); return; }
  var area = document.getElementById('learn-answer-area');
  area.innerHTML = '<div style="padding:40px 20px;text-align:center"><div class="spin" style="margin:0 auto 16px"></div><div style="font-size:13px;color:var(--text-light)">Searching the web + thinking...</div></div>';
  document.getElementById('learn-suggestions').style.display = 'none';
  try {
    var res = await fetch(API + '/api/learn', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ question: q })
    });
    var d = await res.json();
    if (d.error) throw new Error(d.error);
    renderLearnAnswer(d.answer);
  } catch (e) {
    area.innerHTML = '<div style="padding:24px;text-align:center;color:var(--red);font-size:13px">Could not get an answer — try again.</div>';
    document.getElementById('learn-suggestions').style.display = '';
  }
}
function renderLearnAnswer(a) {
  if (!a) return;
  window._learnRelated = a.related_questions || [];
  var area = document.getElementById('learn-answer-area');
  var html = '';
  if (a.summary) {
    html += '<div class="la-summary">'
      + '<div class="la-question">' + escH(a.question || '') + '</div>'
      + '<div class="la-summary-text">' + escH(a.summary) + '</div>'
      + '</div>';
  }
  if (a.bottom_line) {
    html += '<div class="la-bottom-line">'
      + '<div class="la-bl-label">Bottom line</div>'
      + '<div class="la-bl-text">' + escH(a.bottom_line) + '</div>'
      + '</div>';
  }
  if (a.dimensions && a.dimensions.length) {
    html += '<div class="la-dim-card"><div class="la-dim-label">The breakdown</div>';
    for (var i = 0; i < a.dimensions.length; i++) {
      var dim = a.dimensions[i];
      var vClass = dim.verdict === 'better' ? 'vd-better' : dim.verdict === 'worse' ? 'vd-worse' : 'vd-depends';
      var vText = dim.verdict === 'better' ? 'Better' : dim.verdict === 'worse' ? 'Watch out' : 'Depends';
      html += '<div class="la-dim-row">'
        + '<div class="la-dim-name">' + escH(dim.label || '') + '</div>'
        + '<div class="la-dim-detail">' + escH(dim.detail || '') + '</div>'
        + '<div class="la-dim-verdict ' + vClass + '">' + vText + '</div>'
        + '</div>';
    }
    html += '</div>';
  }
  if (a.nuance) {
    html += '<div class="la-nuance">'
      + '<div class="la-nuance-label">The nuance</div>'
      + '<div class="la-nuance-text">' + escH(a.nuance) + '</div>'
      + '</div>';
  }
  if (a.best_choice_guide) {
    html += '<div class="card"><div class="card-label">Practical guide</div>'
      + '<div style="font-size:13px;color:var(--text-mid);line-height:1.7">' + escH(a.best_choice_guide) + '</div>'
      + '</div>';
  }
  if (a.sources && a.sources.length) {
    html += '<div class="sources-row" style="margin:0 0 12px">'
      + a.sources.filter(Boolean).map(function(url) {
          var display = String(url).replace('https://','').replace('http://','').replace('www.','').split('/')[0];
          return '<a class="source-link" href="' + escH(url) + '" target="_blank" rel="noopener">' + escH(display) + '</a>';
        }).join('')
      + '</div>';
  }
  if (window._learnRelated && window._learnRelated.length) {
    html += '<div class="la-related"><div class="la-rel-label">More to explore</div><div class="learn-sugg-chips">'
      + window._learnRelated.slice(0, 4).map(function(q, idx) {
          return '<div class="learn-sugg-chip" onclick="askLearn(window._learnRelated[' + idx + '])">' + escH(q) + '</div>';
        }).join('')
      + '</div></div>';
  }
  html += '<button class="action-btn secondary" style="width:100%;font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;margin-bottom:8px" onclick="newLearnQuestion()">Ask another question</button>';
  area.innerHTML = html;
  document.getElementById('learn-scroll').scrollTop = 0;
}
function newLearnQuestion() {
  document.getElementById('learn-input').value = '';
  document.getElementById('learn-answer-area').innerHTML = '';
  document.getElementById('learn-suggestions').style.display = '';
  document.getElementById('learn-input').focus();
}

// ─── DRAWER ───────────────────────────────────────────────────────────────────
function openDrawer() {
  document.getElementById('drawer').classList.add('open');
  document.getElementById('drawer-overlay').classList.add('open');
}
function closeDrawer() {
  document.getElementById('drawer').classList.remove('open');
  document.getElementById('drawer-overlay').classList.remove('open');
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────
function openAuth() { document.getElementById('auth-overlay').classList.add('open'); }
function closeAuth() { document.getElementById('auth-overlay').classList.remove('open'); }
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('auth-overlay').addEventListener('click', e => { if (e.target === document.getElementById('auth-overlay')) closeAuth(); });
});
function switchAuthTab(t) {
  document.getElementById('tab-in').classList.toggle('active', t === 'in');
  document.getElementById('tab-up').classList.toggle('active', t === 'up');
  document.getElementById('form-in').style.display = t === 'in' ? '' : 'none';
  document.getElementById('form-up').style.display = t === 'up' ? '' : 'none';
  document.getElementById('auth-err').classList.remove('show');
}
async function doSignIn() {
  const email = document.getElementById('si-email').value.trim();
  const pass = document.getElementById('si-pass').value;
  if (!email || !pass) { showAuthErr('Please fill in both fields'); return; }
  try {
    const r = await fetch(API + '/api/auth/signin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: pass }) });
    const d = await r.json();
    if (!r.ok) { showAuthErr(d.error || 'Sign in failed'); return; }
    setAuth(d.token, d.user); closeAuth(); showToast('Welcome back, ' + (d.user.name || d.user.email.split('@')[0]) + '!');
  } catch { showAuthErr('Network error — try again'); }
}
async function doSignUp() {
  const name = document.getElementById('su-name').value.trim();
  const email = document.getElementById('su-email').value.trim();
  const pass = document.getElementById('su-pass').value;
  if (!email || !pass) { showAuthErr('Email and password required'); return; }
  if (pass.length < 8) { showAuthErr('Password must be 8+ characters'); return; }
  try {
    const r = await fetch(API + '/api/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: pass, name: name || undefined }) });
    const d = await r.json();
    if (!r.ok) { showAuthErr(d.error || 'Sign up failed'); return; }
    setAuth(d.token, d.user); closeAuth(); showToast('Welcome to GreenSpecs!');
  } catch { showAuthErr('Network error — try again'); }
}
function showAuthErr(msg) { const el = document.getElementById('auth-err'); el.textContent = msg; el.classList.add('show'); }
function setAuth(token, user) {
  auth_token = token; currentUser = user;
  localStorage.setItem('gs_auth', token);
  const label = document.getElementById('d-auth-label');
  if (label) label.textContent = user.name || user.email.split('@')[0];
  const navYou = document.getElementById('nav-you');
  if (navYou) navYou.querySelector('svg').setAttribute('stroke','var(--sage)');
}
async function verifyAuth() {
  try {
    const r = await fetch(API + '/api/auth/me', { headers: { 'Authorization': 'Bearer ' + auth_token } });
    if (r.ok) { const d = await r.json(); setAuth(auth_token, d.user); }
    else { auth_token = null; localStorage.removeItem('gs_auth'); }
  } catch {}
}

// ─── LOCATION ─────────────────────────────────────────────────────────────────
function getLocation() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(pos => {
    userLat = pos.coords.latitude; userLng = pos.coords.longitude;
    reverseGeocode(userLat, userLng);
  }, () => {}, { timeout: 8000 });
}
async function reverseGeocode(lat, lng) {
  try {
    const r = await fetch('https://nominatim.openstreetmap.org/reverse?lat=' + lat + '&lon=' + lng + '&format=json');
    const d = await r.json();
    const city = d.address?.city || d.address?.town || d.address?.village || '';
    const state = d.address?.state_code || '';
    userCity = [city, state].filter(Boolean).join(', ') || null;
  } catch {}
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function noEmoji(str) {
  if (!str) return str;
  return String(str);
}
function letterGrade(s) {
  s = Number(s);
  if (s >= 93) return 'A+'; if (s >= 87) return 'A'; if (s >= 80) return 'A-';
  if (s >= 77) return 'B+'; if (s >= 73) return 'B'; if (s >= 70) return 'B-';
  if (s >= 67) return 'C+'; if (s >= 63) return 'C'; if (s >= 60) return 'C-';
  if (s >= 57) return 'D+'; if (s >= 53) return 'D'; if (s >= 50) return 'D-';
  return 'F';
}
function gradeColor(s) {
  s = Number(s);
  if (s >= 80) return '#2D6A4F'; if (s >= 70) return '#52B788';
  if (s >= 60) return '#F59E0B'; if (s >= 50) return '#F97316';
  return '#DC2626';
}
function renderResearchCard(research) {
  if (!research) return '';
  const metrics = research.metrics || [];
  const levelUp = research.level_up || [];
  const sources = research.sources || [];

  let html = '<div class="card research-card">';
  html += '<div class="research-header"><div class="research-icon"><svg viewBox="0 0 24 24" width="16" height="16" stroke="white" fill="none" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></div>'
    + '<div class="research-title">What we found</div>'
    + '<div class="web-badge">Searched the web</div></div>';

  // Company metrics table
  if (metrics.length) {
    html += '<div class="card-label" style="margin-bottom:6px">Real numbers from published data</div>';
    html += '<div>';
    for (const m of metrics) {
      html += '<div class="metric-row">'
        + '<div class="metric-label">' + escH(m.label || '') + '</div>'
        + '<div><div class="metric-value">' + escH(m.value || '') + '</div>'
        + (m.source ? '<div class="metric-source">' + escH(m.source) + '</div>' : '')
        + '</div></div>';
    }
    html += '</div>';
  }

  // What the claim actually means
  if (research.claim_reality) {
    html += '<div class="card-label" style="margin-top:12px;margin-bottom:4px">What this claim actually means</div>'
      + '<div class="claim-reality">' + escH(research.claim_reality) + '</div>';
  }

  // Industry best-in-class
  if (research.industry_best) {
    html += '<div class="industry-best-block">'
      + '<div class="industry-best-label">Best in class</div>'
      + '<div class="industry-best-text">' + escH(research.industry_best) + '</div>'
      + '</div>';
  }

  // How to level up
  if (levelUp.length) {
    html += '<div class="card-label" style="margin-top:12px;margin-bottom:6px">How they could level up</div>'
      + '<div class="level-up-list">'
      + levelUp.map(item => '<div class="level-up-item"><span class="level-up-arrow">→</span><span>' + escH(item) + '</span></div>').join('')
      + '</div>';
  }

  // Source links
  if (sources.length) {
    html += '<div class="sources-row">'
      + sources.map(url => {
          const display = String(url).replace('https://','').replace('http://','').replace('www.','').split('/')[0];
          return '<a class="source-link" href="' + escH(url) + '" target="_blank" rel="noopener">' + escH(display) + '</a>';
        }).join('')
      + '</div>';
  }

  html += '</div>';
  return html;
}

function renderChips(title, items, cls) {
  if (!items || !items.length) return '';
  return '<div class="chips-wrap"><div class="chips-title">' + title + '</div><div class="chips">'
    + items.map(i => '<div class="chip ' + cls + '">' + escH(i) + '</div>').join('')
    + '</div></div>';
}
function catIcon(cat) {
  const icons = {
    food: '<svg viewBox="0 0 24 24"><path d="M18 8V2M12 8V2M6 8V2M18 8c0 4-6 8-6 8S6 12 6 8h12z"/></svg>',
    dairy: '<svg viewBox="0 0 24 24"><path d="M8 2h8l2 6H6L8 2zM6 8v10a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8"/></svg>',
    beverages: '<svg viewBox="0 0 24 24"><path d="M17 8h1a4 4 0 0 1 0 8h-1M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4z"/><line x1="6" y1="2" x2="6" y2="4"/><line x1="10" y1="2" x2="10" y2="4"/><line x1="14" y1="2" x2="14" y2="4"/></svg>',
    cleaning: '<svg viewBox="0 0 24 24"><path d="M9.5 2A1.5 1.5 0 0 1 11 3.5v1A1.5 1.5 0 0 1 9.5 6h-2A1.5 1.5 0 0 0 6 7.5V19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7.5A1.5 1.5 0 0 0 16.5 6h-2A1.5 1.5 0 0 1 13 4.5v-1A1.5 1.5 0 0 1 14.5 2z"/></svg>',
    clothing: '<svg viewBox="0 0 24 24"><path d="M20.38 3.46 16 2a4 4 0 0 1-8 0L3.62 3.46a2 2 0 0 0-1.34 2.23l.58 3.57a1 1 0 0 0 .99.84H6v10c0 1.1.9 2 2 2h8a2 2 0 0 0 2-2V10h2.15a1 1 0 0 0 .99-.84l.58-3.57a2 2 0 0 0-1.34-2.23z"/></svg>',
    electronics: '<svg viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
  };
  const icon = icons[cat] || '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M3 9V6a2 2 0 0 1 2-2h3M15 4h3a2 2 0 0 1 2 2v3M21 15v3a2 2 0 0 1-2 2h-3M9 20H6a2 2 0 0 1-2-2v-3"/></svg>';
  return icon;
}
function nanoid(n=10){const c='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';let r='';for(let i=0;i<n;i++)r+=c[Math.floor(Math.random()*62)];return r;}
const stripEmoji = s => String(s||'');
const escH = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const showToast = msg => { const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2800); };

// ─── INSTALL ──────────────────────────────────────────────────────────────────
function checkInstallPrompt() {
  if (window.navigator.standalone) return;
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault(); deferredInstall = e;
    setTimeout(() => document.getElementById('install-prompt').classList.remove('hidden'), 20000);
  });
  document.getElementById('install-btn-el').addEventListener('click', async () => {
    if (deferredInstall) { deferredInstall.prompt(); const r = await deferredInstall.userChoice; if (r.outcome === 'accepted') document.getElementById('install-prompt').classList.add('hidden'); deferredInstall = null; }
  });
}
</script>
</body>
</html>
`;


// ─── Auth Routes ──────────────────────────────────────────────────────────────

app.post('/api/auth/signup', async (c) => {
  const { email, password, name } = await c.req.json<{ email: string; password: string; name?: string }>();
  if (!email || !password) return c.json({ error: 'Email and password required' }, 400);
  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email.toLowerCase()).first();
  if (existing) return c.json({ error: 'Email already registered — sign in instead' }, 409);
  const salt = nanoid(16);
  const hash = await hashPassword(password, salt);
  const userId = nanoid();
  await c.env.DB.prepare('INSERT INTO users (id,email,name,password_hash,salt) VALUES (?,?,?,?,?)')
    .bind(userId, email.toLowerCase(), name || null, hash, salt).run();
  const token = nanoid(32);
  const expires = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
  await c.env.DB.prepare('INSERT INTO auth_tokens (token,user_id,expires_at) VALUES (?,?,?)').bind(token, userId, expires).run();
  return c.json({ token, user: { id: userId, email: email.toLowerCase(), name: name || null } });
});

app.post('/api/auth/signin', async (c) => {
  const { email, password } = await c.req.json<{ email: string; password: string }>();
  if (!email || !password) return c.json({ error: 'Email and password required' }, 400);
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email.toLowerCase()).first<UserRow>();
  if (!user || !user.password_hash || !user.salt) return c.json({ error: 'Invalid email or password' }, 401);
  const hash = await hashPassword(password, user.salt);
  if (hash !== user.password_hash) return c.json({ error: 'Invalid email or password' }, 401);
  const token = nanoid(32);
  const expires = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
  await c.env.DB.prepare('INSERT INTO auth_tokens (token,user_id,expires_at) VALUES (?,?,?)').bind(token, user.id, expires).run();
  return c.json({ token, user: { id: user.id, email: user.email, name: user.name } });
});

app.post('/api/auth/google', async (c) => {
  const { id_token } = await c.req.json<{ id_token: string }>();
  if (!id_token) return c.json({ error: 'id_token required' }, 400);
  const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${id_token}`);
  if (!r.ok) return c.json({ error: 'Invalid Google token' }, 401);
  const payload = await r.json() as { sub: string; email: string; name?: string; picture?: string };
  let user = await c.env.DB.prepare('SELECT * FROM users WHERE google_id = ?').bind(payload.sub).first<UserRow>();
  if (!user) {
    const byEmail = await c.env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(payload.email.toLowerCase()).first<UserRow>();
    if (byEmail) {
      await c.env.DB.prepare('UPDATE users SET google_id=?,avatar=? WHERE id=?').bind(payload.sub, payload.picture||null, byEmail.id).run();
      user = byEmail;
    } else {
      const userId = nanoid();
      await c.env.DB.prepare('INSERT INTO users (id,email,name,google_id,avatar) VALUES (?,?,?,?,?)').bind(userId, payload.email.toLowerCase(), payload.name||null, payload.sub, payload.picture||null).run();
      user = await c.env.DB.prepare('SELECT * FROM users WHERE id=?').bind(userId).first<UserRow>();
    }
  }
  const token = nanoid(32);
  const expires = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
  await c.env.DB.prepare('INSERT INTO auth_tokens (token,user_id,expires_at) VALUES (?,?,?)').bind(token, user!.id, expires).run();
  return c.json({ token, user: { id: user!.id, email: user!.email, name: user!.name, avatar: user!.avatar } });
});

app.get('/api/auth/me', async (c) => {
  const token = (c.req.header('Authorization') || '').replace('Bearer ', '');
  if (!token) return c.json({ error: 'No token' }, 401);
  const now = Math.floor(Date.now() / 1000);
  const row = await c.env.DB.prepare(
    'SELECT u.id,u.email,u.name,u.avatar FROM auth_tokens t JOIN users u ON t.user_id=u.id WHERE t.token=? AND t.expires_at>?'
  ).bind(token, now).first<{ id: string; email: string; name: string|null; avatar: string|null }>();
  if (!row) return c.json({ error: 'Invalid or expired token' }, 401);
  return c.json({ user: row });
});

// ─── PWA ──────────────────────────────────────────────────────────────────────

app.get('/', (c) => {
  return c.html(PWA_HTML);
});

// ─── POST /api/scan ───────────────────────────────────────────────────────────

app.post('/api/scan', async (c) => {
  const body = await c.req.json() as {
    product_name: string;
    claim?: string;
    image_base64?: string;
    media_type?: string;
    lat?: number;
    lng?: number;
    location_name?: string;
    price?: string;
    session_id?: string;
  };

  const { product_name, claim = '', lat, lng, location_name, price, session_id } = body;

  if (!product_name) return c.json({ error: 'product_name required' }, 400);

  // Ensure session exists
  const sid = session_id ?? nanoid(16);
  await c.env.DB.prepare(`INSERT OR IGNORE INTO sessions (id) VALUES (?)`).bind(sid).run();

  // Check cache (skip if image provided)
  const ck = await cacheKey(product_name, claim);
  if (!body.image_base64) {
    const cached = await c.env.DB.prepare(
      `SELECT * FROM scans WHERE cache_key = ? ORDER BY created_at DESC LIMIT 1`
    ).bind(ck).first<ScanRow>();

    if (cached) {
      if (lat && lng) {
        await c.env.DB.prepare(
          `INSERT INTO scans (id, session_id, cache_key, product_name, brand, category,
            primary_claim, score, confidence, specificity_score, transparency_score,
            third_party_score, bigimpact_score, marketing_score, what_covers, what_missing,
            red_flags, tips, better_alternatives, sources, scope1_text, scope2_text,
            scope3_text, verdict, letter_grade, research_data, lat, lng, location_name, price, served_from_cache)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`
        ).bind(
          nanoid(), sid, ck, cached.product_name, cached.brand, cached.category,
          cached.primary_claim, cached.score, cached.confidence,
          cached.specificity_score, cached.transparency_score, cached.third_party_score,
          cached.bigimpact_score, cached.marketing_score,
          cached.what_covers, cached.what_missing, cached.red_flags,
          cached.tips, cached.better_alternatives, cached.sources,
          cached.scope1_text, cached.scope2_text, cached.scope3_text,
          cached.verdict ?? null, cached.letter_grade ?? null,
          cached.research_data ?? null,
          lat, lng, location_name ?? null, price ?? null
        ).run();
      }
      return c.json({ session_id: sid, scan: formatScan(cached), cached: true });
    }
  }

  // Analysis — single phase for speed (model has strong brand knowledge from training)
  try {
    const researchText = '';
    const researchCost = 0;

    // Phase 2: Structured analysis with research context
    const { result, cost: analyzeCost } = await analyzeWithGemini(
      c.env.GEMINI_API_KEY,
      product_name,
      claim,
      body.image_base64,
      body.media_type,
      researchText || undefined,
    );

    const totalCost = researchCost + analyzeCost;
    const r = result as Record<string, Record<string, number> | string[] | string | number | Record<string, unknown>>;
    const rubric = (r.rubric ?? {}) as Record<string, number>;
    const researchObj = (r.research ?? null) as Record<string, unknown> | null;
    const id = nanoid();

    // Map new field names to stored columns (whats_good→what_covers, etc.)
    const whatsGood = (r.whats_good ?? r.what_covers ?? []) as string[];
    const whatsNotOnLabel = (r.whats_not_on_label ?? r.what_missing ?? []) as string[];
    const worthKnowing = (r.worth_knowing ?? r.red_flags ?? []) as string[];

    // Store new structured fields in research_data column
    const structuredData = {
      real_story: String(r.real_story ?? ''),
      why_it_matters: String(r.why_it_matters ?? ''),
      compare_hook: String(r.compare_hook ?? ''),
      win: String(r.win ?? ''),
      tradeoff: String(r.tradeoff ?? ''),
      packaging: String(r.packaging ?? ''),
      ingredients: String(r.ingredients ?? ''),
      transport: String(r.transport ?? ''),
      transparency: String(r.transparency ?? ''),
      verdict_tag: String(r.verdict_tag ?? ''),
      sustainability_url: String(r.sustainability_url ?? ''),
      better_path: String(r.better_path ?? ''),
    };

    await c.env.DB.prepare(
      `INSERT INTO scans (id, session_id, cache_key, product_name, brand, category,
        primary_claim, score, confidence, specificity_score, transparency_score,
        third_party_score, bigimpact_score, marketing_score, what_covers, what_missing,
        red_flags, tips, better_alternatives, sources, scope1_text, scope2_text,
        scope3_text, verdict, letter_grade, research_data, lat, lng, location_name, price, api_cost_usd, served_from_cache)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`
    ).bind(
      id, sid, ck,
      String(r.product_name ?? product_name),
      String(r.brand ?? ''),
      String(r.category ?? 'other'),
      String(r.primary_claim ?? claim),
      Number(r.score ?? 50),
      String(r.confidence ?? 'medium'),
      Number(rubric.claims_score ?? rubric.specificity_score ?? 0),
      Number(rubric.certifications_score ?? rubric.transparency_score ?? 0),
      Number(rubric.packaging_score ?? rubric.third_party_score ?? 0),
      Number(rubric.ingredient_score ?? rubric.bigimpact_score ?? 0),
      Number(rubric.marketing_score ?? 0),
      JSON.stringify((r.tips ?? []) as string[]),
      JSON.stringify([]),
      JSON.stringify([]),
      JSON.stringify((r.tips ?? []) as string[]),
      JSON.stringify([]),
      JSON.stringify([]),
      '',
      '',
      String(r.scope3_text ?? ''),
      String(r.headline ?? ''),
      String(r.letter_grade ?? letterGradeFromScore(Number(r.score ?? 50))),
      JSON.stringify(structuredData),
      lat ?? null, lng ?? null,
      location_name ?? null,
      price ?? null,
      totalCost
    ).run();

    await c.env.DB.prepare(`UPDATE sessions SET scan_count = scan_count + 1 WHERE id = ?`).bind(sid).run();

    // Background YKO tier lookup — fire and forget, zero impact on response latency
    const ykoLookupPromise = (async () => {
      try {
        const ykoRes = await fetch('https://yko-api.phill-carter.workers.dev/api/scan-signal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ brand_name: String(r.brand ?? ''), product_name: String(r.product_name ?? product_name) }),
        });
        if (ykoRes.ok) {
          const ykoData = await ykoRes.json() as { scored?: boolean; tier?: string };
          if (ykoData.scored && ykoData.tier) {
            await c.env.DB.prepare('UPDATE scans SET yko_tier = ? WHERE id = ?')
              .bind(ykoData.tier, id).run();
          }
        }
      } catch {}
    })();
    if (c.executionCtx?.waitUntil) {
      c.executionCtx.waitUntil(ykoLookupPromise);
    }

    const saved = await c.env.DB.prepare(`SELECT * FROM scans WHERE id = ?`).bind(id).first<ScanRow>();
    return c.json({ session_id: sid, scan: formatScan(saved!), cached: false });

  } catch (err) {
    console.error('Gemini error:', err);
    return c.json({ error: 'Analysis failed — try again', detail: String(err) }, 500);
  }
});

// ─── GET /api/scan/:id ────────────────────────────────────────────────────────

app.get('/api/scan/:id', async (c) => {
  const row = await c.env.DB.prepare(`SELECT * FROM scans WHERE id = ?`).bind(c.req.param('id')).first<ScanRow>();
  if (!row) return c.json({ error: 'not found' }, 404);
  return c.json(formatScan(row));
});

// ─── GET /api/session/:id/scans ───────────────────────────────────────────────

app.get('/api/session/:id/scans', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT * FROM scans WHERE session_id = ? ORDER BY created_at DESC LIMIT 20`
  ).bind(c.req.param('id')).all<ScanRow>();
  return c.json({ scans: rows.results.map(formatScan) });
});

// ─── GET /api/feed ────────────────────────────────────────────────────────────

app.get('/api/feed', async (c) => {
  const lat = parseFloat(c.req.query('lat') ?? '0');
  const lng = parseFloat(c.req.query('lng') ?? '0');
  const radius = parseFloat(c.req.query('radius') ?? '50');
  const limit = Math.min(parseInt(c.req.query('limit') ?? '20'), 50);
  const latDelta = radius / 111;
  const lngDelta = radius / (111 * Math.cos(lat * Math.PI / 180));

  let rows;
  if (lat && lng) {
    rows = await c.env.DB.prepare(`
      SELECT * FROM scans
      WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?
      ORDER BY created_at DESC LIMIT ?
    `).bind(lat - latDelta, lat + latDelta, lng - lngDelta, lng + lngDelta, limit).all<ScanRow>();
  } else {
    rows = await c.env.DB.prepare(`SELECT * FROM scans ORDER BY created_at DESC LIMIT ?`).bind(limit).all<ScanRow>();
  }

  return c.json({ feed: rows.results.map(formatScan) });
});

// ─── POST /api/compare-snap ──────────────────────────────────────────────────

const COMPARE_SNAP_SYSTEM = `You are analyzing a product photo for a quick side-by-side comparison. Assess what is visible in this image.

INGREDIENTS GUIDE:
clean = short list, all recognizable whole-food or plant-based, no synthetic additives
mostly clean = mostly good, 1-2 questionable additives
mixed = mix of good and synthetic or processed ingredients
avoid = many synthetic additives, preservatives, artificial colors or flavors

SUSTAINABILITY GUIDE:
high = certified organic, B Corp, Fair Trade, or regenerative with strong transparency
medium = some certs, partial sustainability story, decent effort
low = conventional, minimal claims, typical supply chain
minimal = no claims, likely high environmental impact`;

app.post('/api/compare-snap', async (c) => {
  const body = await c.req.json() as { image_base64: string; media_type?: string; session_id?: string };
  if (!body.image_base64) return c.json({ error: 'image_base64 required' }, 400);
  const t0 = Date.now();
  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${c.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: COMPARE_SNAP_SYSTEM }] },
          contents: [{ parts: [
            { text: 'Analyze this product. Return ONLY valid JSON, no markdown:\n{"product_name":"Full brand + product name","brand":"Brand only","price_detected":"Price shown or null","price_per_unit":"Price per oz/unit or null","price_per_unit_num":0.00,"ingredients_quality":"clean|mostly clean|mixed|avoid","ingredients_notes":"5-8 words why","sustainability_level":"high|medium|low|minimal","sustainability_notes":"5-8 words on key factor"}' },
            { inline_data: { mime_type: body.media_type || 'image/jpeg', data: body.image_base64 } }
          ]}],
          generationConfig: { temperature: 0.1, response_mime_type: 'application/json', maxOutputTokens: 350, thinkingConfig: { thinkingBudget: 0 } }
        })
      }
    );
    if (!geminiRes.ok) throw new Error('Gemini: ' + await geminiRes.text());
    const gData = await geminiRes.json() as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> };
    const raw = gData.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
    const cleaned = raw.replace(/^```json\s*/,'').replace(/\s*```$/,'').trim();
    const result = JSON.parse(cleaned);
    // D1 cache enrichment
    if (result.product_name) {
      const words = result.product_name.split(' ').slice(0, 2).join(' ');
      const cached = await c.env.DB.prepare(
        'SELECT research_data, score FROM scans WHERE product_name LIKE ? ORDER BY created_at DESC LIMIT 1'
      ).bind('%' + words + '%').first<{ research_data: string | null; score: number }>();
      if (cached?.research_data) {
        try {
          const rd = JSON.parse(cached.research_data);
          if (rd.ingredients) result.ingredients_cached = rd.ingredients;
          if (rd.packaging) result.packaging_cached = rd.packaging;
          result.cached_score = cached.score;
        } catch {}
      }
    }
    console.log('compare-snap resolved in', Date.now() - t0, 'ms');
    return c.json({ result });
  } catch (err) {
    console.error('compare-snap error:', err);
    return c.json({ error: String(err) }, 500);
  }
});

// ─── POST /api/compare ────────────────────────────────────────────────────────

app.post('/api/compare', async (c) => {
  const { scan_ids } = await c.req.json() as { scan_ids: string[] };
  if (!Array.isArray(scan_ids) || scan_ids.length < 2 || scan_ids.length > 4) {
    return c.json({ error: 'Provide 2–4 scan_ids' }, 400);
  }
  const placeholders = scan_ids.map(() => '?').join(',');
  const rows = await c.env.DB.prepare(
    `SELECT * FROM scans WHERE id IN (${placeholders})`
  ).bind(...scan_ids).all<ScanRow>();
  const scans = rows.results.map(formatScan);
  const ranked = [...scans].sort((a, b) => b.score - a.score);

  // Build product input for Gemini
  const products = ranked.map(s => ({
    id: s.id,
    name: s.product_name,
    brand: s.brand || '',
    score: s.score,
    letter_grade: s.letter_grade,
    claim: s.primary_claim || '',
    headline: s.headline,
    win: s.win,
    tradeoff: s.tradeoff,
    packaging: s.packaging,
    ingredients: s.ingredients,
    transparency: s.transparency_label,
    verdict_tag: s.verdict_tag,
  }));

  try {
    const { result } = await compareWithGemini(c.env.GEMINI_API_KEY, products);
    const ai = result;

    // Background: capture compare event for training data — fire and forget
    const compareEventPromise = (async () => {
      try {
        const eventId = nanoid(12);
        await c.env.DB.prepare(
          `INSERT INTO compare_events (id, session_id, scan_ids, ai_winner_id, ai_verdict, product_count, created_at)
           VALUES (?, ?, ?, ?, ?, ?, unixepoch())`
        ).bind(
          eventId,
          rows.results[0]?.session_id ?? null,
          JSON.stringify(scan_ids),
          (ai?.winner_id as string) ?? null,
          (ai?.overall_verdict as string) ?? null,
          scan_ids.length
        ).run();

        // If AI named a winner, write a compare_win signal on that scan
        if (ai?.winner_id) {
          await c.env.DB.prepare(
            `INSERT INTO scan_signals (id, scan_id, signal_type, weight, session_id, created_at)
             VALUES (?, ?, 'compare_win', 3.0, ?, unixepoch())`
          ).bind(nanoid(12), ai.winner_id as string, rows.results[0]?.session_id ?? null).run();

          // Write compare_loss signals for non-winners
          for (const s of rows.results) {
            if (s.id !== ai.winner_id) {
              await c.env.DB.prepare(
                `INSERT INTO scan_signals (id, scan_id, signal_type, weight, session_id, created_at)
                 VALUES (?, ?, 'compare_loss', 1.0, ?, unixepoch())`
              ).bind(nanoid(12), s.id, rows.results[0]?.session_id ?? null).run();
            }
          }
        }
      } catch {}
    })();
    if (c.executionCtx?.waitUntil) {
      c.executionCtx.waitUntil(compareEventPromise);
    }

    return c.json({ scans, ranked, ai });
  } catch (err) {
    console.error('Compare AI error:', err);
    // Fallback to simple comparison if AI fails
    return c.json({ scans, ranked, ai: null, fallback: true });
  }
});

// ─── GET /api/stats ───────────────────────────────────────────────────────────

app.get('/api/stats', async (c) => {
  const total = await c.env.DB.prepare(`SELECT COUNT(*) as count FROM scans`).first<{ count: number }>();
  const avgScore = await c.env.DB.prepare(`SELECT AVG(score) as avg FROM scans`).first<{ avg: number }>();
  return c.json({
    total_scans: total?.count ?? 0,
    avg_score: Math.round((avgScore?.avg ?? 50) * 10) / 10,
  });
});

// ─── POST /api/learn ──────────────────────────────────────────────────────────

app.post('/api/learn', async (c) => {
  const { question } = await c.req.json<{ question: string }>();
  if (!question?.trim()) return c.json({ error: 'question required' }, 400);
  try {
    const { answer, cost } = await learnWithGemini(c.env.GEMINI_API_KEY, question.trim());
    return c.json({ answer, cost });
  } catch (err) {
    console.error('Learn error:', err);
    return c.json({ error: 'Could not answer — try again', detail: String(err) }, 500);
  }
});

// ─── GET /api/admin/export/training ──────────────────────────────────────────

app.get('/api/admin/export/training', async (c) => {
  const adminKey = c.req.header('x-admin-key');
  if (adminKey !== 'gs-export-2026') return c.json({ error: 'Unauthorized' }, 401);

  const from = Number(c.req.query('from') || 0);
  const to = Number(c.req.query('to') || Date.now() / 1000);
  const minWeight = Number(c.req.query('min_weight') || 0);
  const category = c.req.query('category') || null;
  const limit = Math.min(Number(c.req.query('limit') || 1000), 5000);

  const categoryClause = category ? `AND s.category = '${category.replace(/'/g,"''")}' ` : '';

  const rows = await c.env.DB.prepare(
    `SELECT s.*,
      COALESCE(sig.total_weight, 0) as signal_weight,
      sig.signal_types
     FROM scans s
     LEFT JOIN (
       SELECT scan_id,
         SUM(weight) as total_weight,
         GROUP_CONCAT(signal_type) as signal_types
       FROM scan_signals GROUP BY scan_id
     ) sig ON s.id = sig.scan_id
     WHERE s.export_eligible = 1
       AND s.served_from_cache = 0
       AND s.created_at >= ? AND s.created_at <= ?
       AND (COALESCE(sig.total_weight, 0) >= ? OR ? = 0)
       ${categoryClause}
     ORDER BY s.created_at DESC
     LIMIT ?`
  ).bind(from, to, minWeight, minWeight, limit).all<ScanRow & { signal_weight: number; signal_types: string | null }>();

  const lines = rows.results.map(row => {
    const rd = safeJSON<Record<string,string>>(row.research_data, {});
    return JSON.stringify({
      id: `gs_${row.id}`,
      source: 'greenspecs',
      created_at: row.created_at,
      weight: (row as any).signal_weight || 1.0,
      human_signals: (row as any).signal_types ? (row as any).signal_types.split(',') : [],
      input: {
        product: row.product_name,
        brand: row.brand,
        category: row.category,
        claim: row.primary_claim,
        location_region: row.location_name || null,
        price: row.price || null,
      },
      label: {
        score: row.score,
        letter_grade: row.letter_grade,
        confidence: row.confidence,
        rubric: {
          claims: row.specificity_score,
          certifications: row.transparency_score,
          packaging_lifecycle: row.third_party_score,
          ingredient_impact: row.bigimpact_score,
          supply_chain: row.marketing_score,
        },
        headline: row.verdict,
        real_story: rd.real_story || null,
        why_it_matters: rd.why_it_matters || null,
        win: rd.win || null,
        tradeoff: rd.tradeoff || null,
        packaging: rd.packaging || null,
        ingredients: rd.ingredients || null,
        transport: rd.transport || null,
        transparency: rd.transparency || null,
        verdict_tag: rd.verdict_tag || null,
        better_path: rd.better_path || null,
      },
      yko_context: row.yko_tier ? { brand_tier: row.yko_tier } : null,
    });
  });

  return new Response(lines.join('\n'), {
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Content-Disposition': `attachment; filename="greenspecs-training-${Date.now()}.jsonl"`,
    },
  });
});

// ─── GET /manifest.json ───────────────────────────────────────────────────────

app.get('/manifest.json', (c) => {
  return c.json({
    name: 'GreenSpecs',
    short_name: 'GreenSpecs',
    description: 'See through green marketing. Scan any product label for real sustainability facts.',
    start_url: '/',
    display: 'standalone',
    background_color: '#1B4332',
    theme_color: '#1B4332',
    orientation: 'portrait-primary',
    icons: [
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }
    ],
  });
});

// ─── GET /icon.svg ────────────────────────────────────────────────────────────

app.get('/icon.svg', (c) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 180">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#1B4332"/>
      <stop offset="100%" stop-color="#2D6A4F"/>
    </linearGradient>
  </defs>
  <rect width="180" height="180" rx="40" fill="url(#bg)"/>
  <!-- Scan frame corners -->
  <path d="M30 58 L30 40 L48 40" stroke="#D8F3DC" stroke-width="8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M150 58 L150 40 L132 40" stroke="#D8F3DC" stroke-width="8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M30 122 L30 140 L48 140" stroke="#D8F3DC" stroke-width="8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M150 122 L150 140 L132 140" stroke="#D8F3DC" stroke-width="8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  <!-- Leaf shape -->
  <path d="M90 52 C112 52 132 68 132 90 C132 112 112 132 90 132 C68 132 48 112 48 90 C48 68 68 52 90 52 Z" fill="#52B788"/>
  <!-- Leaf center vein -->
  <line x1="90" y1="56" x2="90" y2="128" stroke="#2D6A4F" stroke-width="4" stroke-linecap="round"/>
  <!-- Leaf side veins -->
  <path d="M90 78 C80 70 68 68 60 70" stroke="#2D6A4F" stroke-width="2.5" fill="none" stroke-linecap="round"/>
  <path d="M90 90 C80 82 66 80 57 83" stroke="#2D6A4F" stroke-width="2" fill="none" stroke-linecap="round"/>
  <path d="M90 103 C100 95 112 94 120 97" stroke="#2D6A4F" stroke-width="2" fill="none" stroke-linecap="round"/>
  <!-- Highlight dot -->
  <circle cx="90" cy="90" r="10" fill="rgba(255,255,255,0.15)"/>
</svg>`;
  return new Response(svg, {
    headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' },
  });
});

// ─── POST /api/rate/:scan_id ──────────────────────────────────────────────────

app.post('/api/rate/:scan_id', async (c) => {
  const scanId = c.req.param('scan_id');
  const body = await c.req.json<{ rating: string; insight?: string; session_id?: string }>();

  // Lazy create table
  await c.env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS score_ratings (
      id TEXT PRIMARY KEY,
      scan_id TEXT NOT NULL,
      rating TEXT NOT NULL,
      insight TEXT,
      session_id TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    )
  `).run();

  c.executionCtx.waitUntil(
    c.env.DB.prepare(
      'INSERT INTO score_ratings (id, scan_id, rating, insight, session_id) VALUES (?,?,?,?,?)'
    ).bind(
      nanoid(), scanId,
      body.rating || 'unknown',
      body.insight || null,
      body.session_id || null
    ).run()
  );

  return c.json({ ok: true });
});

// ─── GET /api/swaps/:scan_id ──────────────────────────────────────────────────

app.get('/api/swaps/:scan_id', async (c) => {
  const scanId = c.req.param('scan_id');

  // Ensure swaps table exists (lazy migration)
  await c.env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS swaps (
      id TEXT PRIMARY KEY,
      scan_id TEXT NOT NULL,
      swaps_json TEXT NOT NULL,
      created_at INTEGER DEFAULT (unixepoch())
    )
  `).run();

  const scan = await c.env.DB.prepare('SELECT * FROM scans WHERE id = ?').bind(scanId).first<ScanRow>();
  if (!scan) return c.json({ error: 'Scan not found' }, 404);

  // Serve from cache if less than 7 days old
  const cutoff = Math.floor(Date.now() / 1000) - 7 * 24 * 3600;
  const cached = await c.env.DB.prepare(
    'SELECT swaps_json FROM swaps WHERE scan_id = ? AND created_at > ? LIMIT 1'
  ).bind(scanId, cutoff).first<{ swaps_json: string }>();

  if (cached) {
    return c.json({ swaps: JSON.parse(cached.swaps_json) });
  }

  try {
    const swaps = await generateSwapsWithGemini(c.env.GEMINI_API_KEY, scan);

    // Cache in background — don't block response
    c.executionCtx.waitUntil(
      c.env.DB.prepare('INSERT OR REPLACE INTO swaps (id, scan_id, swaps_json, created_at) VALUES (?,?,?,?)')
        .bind(nanoid(), scanId, JSON.stringify(swaps), Math.floor(Date.now() / 1000)).run()
    );

    return c.json({ swaps });
  } catch (err) {
    console.error('Swaps generation error:', err);
    return c.json({ swaps: [] });
  }
});

export default app;
