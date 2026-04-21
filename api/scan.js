export const config = { runtime: 'edge' };

const CLAUDE_MODEL = 'claude-sonnet-4-5';

async function safeFetch(url, timeoutMs = 8000) {
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; AEOScanner/1.0)',
        'Accept': 'text/plain, text/html, application/xml, */*',
      },
    });
    clearTimeout(tid);
    const text = await res.text();
    return { ok: res.ok, status: res.status, content: text.slice(0, 5000) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function fmtFetch(r, label) {
  if (r.ok) return `${label}: FOUND (HTTP ${r.status})\n${r.content}\n`;
  if (r.status) return `${label}: NOT FOUND (HTTP ${r.status})\n`;
  return `${label}: INACCESSIBLE (${r.error || 'network error'})\n`;
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400 });
  }

  const { url } = body;
  if (!url) {
    return new Response(JSON.stringify({ error: 'Missing url parameter' }), { status: 400 });
  }

  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid URL' }), { status: 400 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' }), { status: 500 });
  }

  const [robots, sitemap, llms, homepage] = await Promise.all([
    safeFetch(`${origin}/robots.txt`),
    safeFetch(`${origin}/sitemap.xml`),
    safeFetch(`${origin}/llms.txt`),
    safeFetch(url),
  ]);

  const realData = [
    fmtFetch(robots, 'robots.txt'),
    fmtFetch(sitemap, 'sitemap.xml'),
    fmtFetch(llms, 'llms.txt'),
    fmtFetch(homepage, 'Homepage HTML'),
  ].join('\n');

  const systemPrompt = `You are a technical AEO (Answer Engine Optimization) auditor.
You have been given REAL fetched content from a website's key endpoints.
Analyze this data carefully. Return ONLY a valid JSON object — no prose, no backticks, no markdown.
Start immediately with { and end with }.

Required JSON structure:
{
  "domain": "string",
  "crawl_friendliness": {
    "score": integer 0-100,
    "robots_txt": {
      "found": boolean,
      "gptbot_status": "allowed"|"blocked"|"unknown",
      "claudebot_status": "allowed"|"blocked"|"unknown",
      "anthropicai_status": "allowed"|"blocked"|"unknown",
      "perplexitybot_status": "allowed"|"blocked"|"unknown",
      "details": "1-2 Chinese sentences about robots.txt findings"
    },
    "sitemap": { "found": boolean, "details": "1 Chinese sentence" },
    "llms_txt": { "found": boolean, "details": "1 Chinese sentence" }
  },
  "content_quality": {
    "score": integer 0-100,
    "json_ld": {
      "found": boolean,
      "types": ["Schema.org types found in HTML"],
      "details": "1 Chinese sentence"
    },
    "faq_schema": boolean,
    "content_assessment": "2 Chinese sentences about content quality for AI"
  },
  "ai_visibility": {
    "score": integer 0-100,
    "assessment": "2 Chinese sentences"
  },
  "overall_score": integer 0-100,
  "grade": "A"|"B"|"C"|"D"|"F",
  "summary_zh": "3 Chinese sentences summarizing AEO health",
  "recommendations_zh": ["建議1","建議2","建議3","建議4"]
}

Scoring rules:
- robots.txt FOUND + AI bots not blocked → crawl +40
- robots.txt FOUND but key bots blocked → crawl +15
- sitemap.xml FOUND → crawl +30
- llms.txt FOUND → crawl +30 (bonus)
- JSON-LD found in homepage HTML → content +45
- FAQ/HowTo/Article schema present → content +25
- overall_score = round(crawl*0.35 + content*0.35 + ai_visibility*0.30)
- Grade: A=85+, B=70+, C=55+, D=40+, F=below 40`;

  const userMessage = `Analyze AEO readiness for: ${url}\n\n${realData}`;

  const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  const claudeData = await claudeRes.json();

  if (!claudeRes.ok) {
    return new Response(
      JSON.stringify({ error: claudeData?.error?.message || 'Claude API error' }),
      { status: 502, headers: { 'Access-Control-Allow-Origin': '*' } }
    );
  }

  const text = claudeData.content?.filter(b => b.type === 'text').map(b => b.text).join('') || '';

  let parsed;
  try {
    let s = text.trim();
    const m = s.match(/```(?:json)?\s*([\s\S]+?)```/);
    if (m) s = m[1].trim();
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a !== -1 && b > a) s = s.slice(a, b + 1);
    parsed = JSON.parse(s);
  } catch (e) {
    return new Response(
      JSON.stringify({ error: `JSON parse failed: ${e.message}`, raw: text }),
      { status: 500, headers: { 'Access-Control-Allow-Origin': '*' } }
    );
  }

  return new Response(JSON.stringify(parsed), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
