export const config = { runtime: 'edge' };

const CLAUDE_MODEL = 'claude-sonnet-4-5';

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*'
};

const fallbackResponse = (domain, msg) => new Response(JSON.stringify({
  domain: domain || '',
  overall_score: 0, grade: 'F',
  crawl_friendliness: {
    score: 0,
    robots_txt: { found: false, gptbot_status: 'unknown', claudebot_status: 'unknown', anthropicai_status: 'unknown', perplexitybot_status: 'unknown', details: msg || '分析未完成，請重新掃描' },
    sitemap: { found: false, details: '' },
    llms_txt: { found: false, details: '' }
  },
  content_quality: { score: 0, json_ld: { found: false, types: [], details: '' }, faq_schema: false, content_assessment: '' },
  ai_visibility: { score: 0, assessment: '' },
  summary_zh: '此次掃描未完成，請重新掃描一次。通常第二次即可成功。',
  recommendations_zh: ['請重新點擊掃描按鈕', '若持續失敗請聯絡專注玩星']
}), { headers: CORS });

const doFetch = async (url) => {
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AEOScanner/1.0)' }
    });
    clearTimeout(tid);
    const txt = await r.text();
    const clean = txt
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 3000);
    return { ok: r.ok, status: r.status, content: clean };
  } catch (e) {
    return { ok: false, error: e.message };
  }
};

const fmtResult = (r, label) => {
  if (r.ok) return label + ': FOUND (HTTP ' + r.status + ')\n' + r.content + '\n';
  if (r.status) return label + ': NOT FOUND (HTTP ' + r.status + ')\n';
  return label + ': INACCESSIBLE (' + (r.error || 'error') + ')\n';
};

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      }
    });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: CORS });
  }

  let body;
  try {
    body = await req.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers: CORS });
  }

  const url = (body || {}).url;
  if (!url) {
    return new Response(JSON.stringify({ error: 'Missing url parameter' }), { status: 400, headers: CORS });
  }

  let origin, domain;
  try {
    const u = new URL(url);
    origin = u.origin;
    domain = u.hostname;
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid URL' }), { status: 400, headers: CORS });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' }), { status: 500, headers: CORS });
  }

  const results = await Promise.all([
    doFetch(origin + '/robots.txt'),
    doFetch(origin + '/sitemap.xml'),
    doFetch(origin + '/llms.txt'),
    doFetch(url)
  ]);

  const realData = [
    fmtResult(results[0], 'robots.txt'),
    fmtResult(results[1], 'sitemap.xml'),
    fmtResult(results[2], 'llms.txt'),
    fmtResult(results[3], 'Homepage')
  ].join('\n');

  const systemPrompt = 'You MUST respond with ONLY a JSON object. Begin your response immediately with { and end with }. Never write any explanation or text outside the JSON.\n\nYou are a technical AEO auditor. Analyze the real fetched website data and return this exact JSON:\n{"domain":"string","crawl_friendliness":{"score":0,"robots_txt":{"found":false,"gptbot_status":"unknown","claudebot_status":"unknown","anthropicai_status":"unknown","perplexitybot_status":"unknown","details":"Chinese"},"sitemap":{"found":false,"details":"Chinese"},"llms_txt":{"found":false,"details":"Chinese"}},"content_quality":{"score":0,"json_ld":{"found":false,"types":[],"details":"Chinese"},"faq_schema":false,"content_assessment":"Chinese"},"ai_visibility":{"score":0,"assessment":"Chinese"},"overall_score":0,"grade":"F","summary_zh":"3 Chinese sentences","recommendations_zh":["建議1","建議2","建議3","建議4"]}\n\nScoring rules: robots+bots_allowed=+40crawl, sitemap=+30crawl, llms.txt=+30crawl_bonus, json-ld=+45content, faq_schema=+25content. overall=round(crawl*0.35+content*0.35+ai*0.30). Grades: A=85+,B=70+,C=55+,D=40+,F<40';

  const userMessage = 'Analyze AEO for: ' + url + '\n\n' + realData;

  let claudeRes, claudeData;
  try {
    claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 2048,
        temperature: 0,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }]
      })
    });
    claudeData = await claudeRes.json();
  } catch (e) {
    return fallbackResponse(domain, 'Claude 連線失敗：' + e.message);
  }

  if (!claudeRes.ok) {
    const errMsg = (claudeData && claudeData.error && claudeData.error.message) || ('Claude API error ' + claudeRes.status);
    return new Response(JSON.stringify({ error: errMsg }), { status: 502, headers: CORS });
  }

  const content = claudeData.content || [];
  const text = content.filter(function(b) { return b.type === 'text'; }).map(function(b) { return b.text; }).join('');

  if (!text || !text.includes('{')) {
    return fallbackResponse(domain, 'AI 回應格式異常，請重試');
  }

  let s = text.trim();
  const fenceMatch = s.match(/```(?:json)?\s*([\s\S]+?)```/);
  if (fenceMatch) {
    s = fenceMatch[1].trim();
  }
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a === -1 || b <= a) {
    return fallbackResponse(domain, 'JSON 結構不完整，請重試');
  }
  s = s.slice(a, b + 1);

  let parsed;
  try {
    parsed = JSON.parse(s);
  } catch (e) {
    return fallbackResponse(domain, 'JSON 解析失敗，請重試');
  }

  return new Response(JSON.stringify(parsed), { headers: CORS });
}
