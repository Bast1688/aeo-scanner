// Node.js Runtime（非 Edge）— 支援 vercel.json 的 maxDuration: 30 設定

const CLAUDE_MODEL = 'claude-sonnet-4-5';

const setCors = (res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
};

const sendFallback = (res, domain, msg) => {
  res.status(200).json({
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
  });
};

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

export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { url } = req.body || {};
  if (!url) {
    return res.status(400).json({ error: 'Missing url parameter' });
  }

  let origin, domain;
  try {
    const u = new URL(url);
    origin = u.origin;
    domain = u.hostname;
  } catch (e) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });
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

  const systemPrompt = 'You MUST respond with ONLY a JSON object. Begin immediately with { and end with }. No explanation or text outside JSON.\n\nYou are a technical AEO auditor. Return this exact JSON structure:\n{"domain":"string","crawl_friendliness":{"score":0,"robots_txt":{"found":false,"gptbot_status":"unknown","claudebot_status":"unknown","anthropicai_status":"unknown","perplexitybot_status":"unknown","details":"Chinese"},"sitemap":{"found":false,"details":"Chinese"},"llms_txt":{"found":false,"details":"Chinese"}},"content_quality":{"score":0,"json_ld":{"found":false,"types":[],"details":"Chinese"},"faq_schema":false,"content_assessment":"Chinese"},"ai_visibility":{"score":0,"assessment":"Chinese"},"overall_score":0,"grade":"F","summary_zh":"3 Chinese sentences","recommendations_zh":["建議1","建議2","建議3","建議4"]}\n\nScoring: robots+bots_allowed=+40crawl, sitemap=+30crawl, llms.txt=+30crawl_bonus, json-ld=+45content, faq_schema=+25content. overall=round(crawl*0.35+content*0.35+ai*0.30). A=85+,B=70+,C=55+,D=40+,F<40';

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
    return sendFallback(res, domain, 'Claude 連線失敗：' + e.message);
  }

  if (!claudeRes.ok) {
    const errMsg = (claudeData && claudeData.error && claudeData.error.message) || ('Claude API ' + claudeRes.status);
    return res.status(502).json({ error: errMsg });
  }

  const content = claudeData.content || [];
  const text = content.filter(function(b) { return b.type === 'text'; }).map(function(b) { return b.text; }).join('');

  if (!text || !text.includes('{')) {
    return sendFallback(res, domain, 'AI 回應格式異常，請重試');
  }

  let s = text.trim();
  const fenceMatch = s.match(/```(?:json)?\s*([\s\S]+?)```/);
  if (fenceMatch) {
    s = fenceMatch[1].trim();
  }
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a === -1 || b <= a) {
    return sendFallback(res, domain, 'JSON 結構不完整，請重試');
  }
  s = s.slice(a, b + 1);

  let parsed;
  try {
    parsed = JSON.parse(s);
  } catch (e) {
    return sendFallback(res, domain, 'JSON 解析失敗，請重試');
  }

  return res.status(200).json(parsed);
}
