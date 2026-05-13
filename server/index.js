import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import dns from 'node:dns/promises';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

const app = express();
const PORT = process.env.PORT || 8787;
const MODEL = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';
const VAULT_DIR = path.resolve(process.env.VAULT_DIR || 'SubsiWiki');
const MAX_AGENT_STEPS = Number(process.env.AGENT_MAX_STEPS || 8);
const MAX_WEB_FETCHES = Number(process.env.AGENT_MAX_WEB_FETCHES || 15);
const MAX_WEB_SEARCHES = Number(process.env.AGENT_MAX_WEB_SEARCHES || 5);

app.use(cors());
app.use(express.json({ limit: '1mb' }));

let cache = { loadedAt: 0, docs: [], chunks: [] };

const STOPWORDS = new Set('the a an and or but if then else when while is are was were be been being to of in on for from with by as at into about over under you your we our it this that these those can could should would may might do does did what which who whom where why how'.split(' '));

function parseFrontmatter(text) {
  if (!text.startsWith('---')) return { data: {}, body: text };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { data: {}, body: text };
  const raw = text.slice(3, end).trim();
  const body = text.slice(end + 4).trim();
  const data = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    data[m[1]] = value;
  }
  return { data, body };
}

function stripMarkdown(md) {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, p1, p2) => p2 || p1)
    .replace(/`{1,3}[^`]*`{1,3}/g, ' ')
    .replace(/[#>*_~|-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractWikiLinks(text) {
  return [...text.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)].map(m => m[1].trim());
}

function titleFromMarkdown(filePath, body, data) {
  if (data.title) return data.title;
  const h1 = body.match(/^#\s+(.+)$/m);
  if (h1) return h1[1].trim();
  return path.basename(filePath, '.md');
}

async function walk(dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.obsidian') continue;
      out.push(...await walk(p));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(p);
    }
  }
  return out;
}

function chunkDoc(doc) {
  const paras = doc.body.split(/\n\s*\n/g).map(stripMarkdown).filter(p => p.length > 40);
  const chunks = [];
  let i = 0;
  for (const para of paras) {
    const sentences = para.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [para];
    let buf = '';
    for (const s of sentences) {
      if ((buf + ' ' + s).length > 900 && buf.length > 0) {
        chunks.push({ ...doc, chunkId: `${doc.id}#${i++}`, text: buf.trim() });
        buf = s;
      } else {
        buf += ' ' + s;
      }
    }
    if (buf.trim()) chunks.push({ ...doc, chunkId: `${doc.id}#${i++}`, text: buf.trim() });
  }
  return chunks;
}

async function loadKnowledgeBase(force = false) {
  if (!force && Date.now() - cache.loadedAt < 30_000 && cache.chunks.length) return cache;
  const files = await walk(VAULT_DIR);
  const docs = [];
  for (const file of files) {
    const raw = await fs.readFile(file, 'utf8');
    const { data, body } = parseFrontmatter(raw);
    const rel = path.relative(VAULT_DIR, file).replaceAll('\\', '/');
    const title = titleFromMarkdown(file, body, data);
    const url = data.source_url || data.source || '';
    docs.push({
      id: rel,
      relPath: rel,
      title,
      url,
      kind: rel.startsWith('Clippings/') ? 'raw source' : rel.startsWith('Wiki/Sources/') ? 'source summary' : 'wiki page',
      body,
    });
  }
  const urlByTitle = new Map(docs.filter(d => d.url).map(d => [d.title, d.url]));
  for (const doc of docs) {
    const relatedUrls = [...new Set(extractWikiLinks(doc.body).map(title => urlByTitle.get(title)).filter(Boolean))];
    doc.relatedUrls = relatedUrls;
    // Synthesis pages often cite source-summary pages instead of official URLs.
    // Use the first cited official URL as the clickable citation target.
    if (!doc.url && relatedUrls.length) doc.url = relatedUrls[0];
  }
  const chunks = docs.flatMap(chunkDoc);
  cache = { loadedAt: Date.now(), docs, chunks };
  return cache;
}

function terms(q) {
  return (q.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter(t => t.length > 2 && !STOPWORDS.has(t));
}

function retrieve(query, limit = 8) {
  const qTerms = terms(query);
  const scored = cache.chunks.map(c => {
    const hay = `${c.title} ${c.text}`.toLowerCase();
    let score = 0;
    for (const t of qTerms) {
      const count = hay.split(t).length - 1;
      if (count) score += count * (c.title.toLowerCase().includes(t) ? 3 : 1);
    }
    if (c.kind === 'source summary') score *= 1.25;
    if (c.kind === 'raw source') score *= 1.1;
    return { ...c, score };
  }).filter(c => c.score > 0).sort((a, b) => b.score - a.score);

  const selected = [];
  const seenDocs = new Set();
  for (const c of scored) {
    const perDoc = selected.filter(s => s.id === c.id).length;
    if (perDoc >= 2) continue;
    selected.push(c);
    seenDocs.add(c.id);
    if (selected.length >= limit) break;
  }
  return selected;
}

function uniqueSources(chunks) {
  const map = new Map();
  for (const c of chunks) {
    const key = c.url || c.relPath;
    if (!map.has(key)) {
      map.set(key, { id: map.size + 1, title: c.title, url: c.url, relatedUrls: c.relatedUrls || [], path: c.relPath, kind: c.kind, sourceType: c.sourceType || 'vault', excerpts: [] });
    }
    map.get(key).excerpts.push(c.text.slice(0, 320));
  }
  return [...map.values()];
}

async function askOpenRouter(question, chunks, sources) {
  const context = chunks.map((c, i) => {
    const sourceId = sources.find(s => (s.url || s.path) === (c.url || c.relPath))?.id;
    return `SOURCE [${sourceId}] ${c.title}\nKind: ${c.kind}\nURL/path: ${c.url || c.relPath}\nExcerpt: ${c.text}`;
  }).join('\n\n---\n\n');

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'http://localhost:5173',
      'X-Title': process.env.OPENROUTER_APP_NAME || 'SubsiWiki AI'
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.2,
      messages: [
        { role: 'system', content: 'You answer questions using only the supplied Obsidian knowledge base excerpts. Be practical and concise. Cite every factual claim with bracket citations like [1]. If the answer is uncertain or not in the sources, say so and suggest what to check next. Do not invent URLs or sources.' },
        { role: 'user', content: `Question: ${question}\n\nKnowledge base excerpts:\n${context}` }
      ]
    })
  });
  if (!res.ok) throw new Error(`OpenRouter error ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json.choices?.[0]?.message?.content?.trim() || 'No answer returned.';
}

function normalizeToolCall(tc) {
  const fn = tc.function || {};
  return {
    id: tc.id,
    name: fn.name,
    args: JSON.parse(fn.arguments || '{}')
  };
}

function toolSchema(name, description, properties, required = Object.keys(properties)) {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: { type: 'object', properties, required }
    }
  };
}

const AGENT_TOOLS = [
  toolSchema('search_vault', 'Search the Obsidian vault for relevant stored knowledge. Use this first.', {
    query: { type: 'string', description: 'The search query.' }
  }),
  toolSchema('fetch_url', 'Fetch a specific public URL and extract readable text as live web evidence.', {
    url: { type: 'string', description: 'The public http(s) URL to fetch.' },
    reason: { type: 'string', description: 'Why this URL is needed for the answer.' }
  }),
  toolSchema('search_web', 'Search the live web for candidate URLs. Prefer official sources and fetch useful results before citing facts.', {
    query: { type: 'string', description: 'The web search query.' }
  })
];

function isPrivateIp(ip) {
  if (net.isIP(ip) === 4) {
    const parts = ip.split('.').map(Number);
    return parts[0] === 10 ||
      parts[0] === 127 ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      parts[0] === 0;
  }
  if (net.isIP(ip) === 6) {
    const lower = ip.toLowerCase();
    return lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80');
  }
  return true;
}

async function assertPublicHttpUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only http(s) URLs are allowed.');
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.local')) throw new Error('Local hostnames are not allowed.');
  const addresses = net.isIP(hostname) ? [{ address: hostname }] : await dns.lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(a => isPrivateIp(a.address))) throw new Error('Private or local network addresses are not allowed.');
  return parsed.toString();
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function titleFromHtml(html, url) {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  return stripHtml(title || '') || new URL(url).hostname;
}

function chunkWebDoc(doc) {
  const chunks = [];
  const sentences = doc.text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [doc.text];
  let buf = '';
  let i = 0;
  for (const s of sentences) {
    if ((buf + ' ' + s).length > 1100 && buf.length > 0) {
      chunks.push({ ...doc, chunkId: `${doc.id}#${i++}`, text: buf.trim() });
      buf = s;
    } else {
      buf += ' ' + s;
    }
    if (chunks.length >= 8) break;
  }
  if (buf.trim() && chunks.length < 8) chunks.push({ ...doc, chunkId: `${doc.id}#${i++}`, text: buf.trim() });
  return chunks;
}

async function browserbaseFetch(url) {
  const res = await fetch('https://api.browserbase.com/v1/fetch', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-BB-API-Key': process.env.BROWSERBASE_API_KEY
    },
    body: JSON.stringify({ url, allowRedirects: true, proxies: process.env.BROWSERBASE_FETCH_PROXIES === 'true' })
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Browserbase fetch ${res.status}: ${json.message || json.error || JSON.stringify(json)}`);
  return json;
}

async function directFetch(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'SubsiWikiBot/0.1 (+https://local.subsiwiki)' }
    });
    const content = await res.text();
    return {
      id: `direct-${Date.now()}`,
      statusCode: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      content,
      contentType: res.headers.get('content-type') || 'text/plain',
      encoding: 'utf-8'
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchLivePage(rawUrl) {
  const url = await assertPublicHttpUrl(rawUrl);
  const fetched = process.env.BROWSERBASE_API_KEY ? await browserbaseFetch(url) : await directFetch(url);
  const html = fetched.content || '';
  const text = stripHtml(html).slice(0, 16_000);
  if (text.length < 80) throw new Error('Fetched page did not contain enough readable text.');
  const doc = {
    id: `web:${url}`,
    relPath: url,
    title: titleFromHtml(html, url),
    url,
    kind: 'live web page',
    sourceType: 'web',
    body: text,
    text,
    statusCode: fetched.statusCode,
    fetchedAt: new Date().toISOString()
  };
  return { doc, chunks: chunkWebDoc(doc) };
}

async function browserbaseSearch(query) {
  if (!process.env.BROWSERBASE_API_KEY) throw new Error('BROWSERBASE_API_KEY is required for live web search.');
  const res = await fetch('https://api.browserbase.com/v1/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-BB-API-Key': process.env.BROWSERBASE_API_KEY
    },
    body: JSON.stringify({ query, numResults: 8 })
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Browserbase search ${res.status}: ${json.message || json.error || JSON.stringify(json)}`);
  return json.results || [];
}

function toolResultText(label, sources) {
  if (!sources.length) return `${label}: no evidence found.`;
  return `${label}:\n` + sources.map(s => {
    const loc = s.url || s.path;
    return `[${s.id}] ${s.title}\nType: ${s.sourceType || s.kind}\nLocation: ${loc}\nExcerpt: ${s.excerpts[0]}`;
  }).join('\n\n');
}

async function askOpenRouterWithTools(messages) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'http://localhost:5173',
      'X-Title': process.env.OPENROUTER_APP_NAME || 'SubsiWiki AI'
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.2,
      tools: AGENT_TOOLS,
      messages
    })
  });
  if (!res.ok) throw new Error(`OpenRouter error ${res.status}: ${await res.text()}`);
  return (await res.json()).choices?.[0]?.message;
}

async function runAgent(question, { allowWeb = false } = {}) {
  await loadKnowledgeBase();
  const sourceMap = new Map();
  const trace = [];
  const limits = { webFetches: 0, webSearches: 0 };

  function addSources(chunks) {
    const raw = uniqueSources(chunks);
    const added = [];
    for (const s of raw) {
      const key = s.url || s.path;
      if (sourceMap.has(key)) {
        const existing = sourceMap.get(key);
        existing.excerpts.push(...(s.excerpts || []).filter(e => !existing.excerpts.includes(e)));
        added.push(existing);
      } else {
        const next = { ...s, id: sourceMap.size + 1 };
        sourceMap.set(key, next);
        added.push(next);
      }
    }
    return added;
  }

  async function runTool(name, args) {
    if (name === 'search_vault') {
      const chunks = retrieve(String(args.query || ''), 8);
      const sources = addSources(chunks);
      trace.push({ tool: name, input: args.query, sources: sources.map(s => s.id) });
      return toolResultText('Vault search results', sources);
    }
    if (name === 'fetch_url') {
      if (!allowWeb) return 'Live web access is disabled for this run.';
      if (limits.webFetches >= MAX_WEB_FETCHES) return 'Live web fetch limit reached.';
      limits.webFetches += 1;
      const { chunks } = await fetchLivePage(String(args.url || ''));
      const sources = addSources(chunks);
      trace.push({ tool: name, input: args.url, reason: args.reason, sources: sources.map(s => s.id) });
      return toolResultText('Fetched live web page', sources);
    }
    if (name === 'search_web') {
      if (!allowWeb) return 'Live web access is disabled for this run.';
      if (limits.webSearches >= MAX_WEB_SEARCHES) return 'Live web search limit reached.';
      limits.webSearches += 1;
      const results = await browserbaseSearch(String(args.query || ''));
      trace.push({ tool: name, input: args.query, resultCount: results.length });
      return 'Web search results:\n' + results.map((r, i) => `${i + 1}. ${r.title || r.name}\nURL: ${r.url || r.link}\nSnippet: ${r.snippet || r.description || ''}`).join('\n\n');
    }
    return `Unknown tool: ${name}`;
  }

  const messages = [
    {
      role: 'system',
      content: [
        'You are SubsiWiki AI, a minimal evidence-gathering agent.',
        'Use search_vault first. Use live web only when the vault is missing, stale, or the user asks for current information.',
        'Prefer official sources. Fetch specific URLs before relying on web search snippets.',
        'Every factual claim in the final answer must cite gathered evidence with bracket citations like [1].',
        'If evidence is insufficient, say what is missing. Do not invent URLs or sources.'
      ].join(' ')
    },
    { role: 'user', content: question }
  ];

  for (let step = 0; step < MAX_AGENT_STEPS; step++) {
    const reply = await askOpenRouterWithTools(messages);
    messages.push(reply);
    const calls = reply?.tool_calls || [];
    if (!calls.length) {
      return { answer: reply?.content?.trim() || 'No answer returned.', sources: [...sourceMap.values()], trace, usedLLM: true, usedAgent: true };
    }
    for (const tc of calls) {
      const call = normalizeToolCall(tc);
      let content;
      try {
        content = await runTool(call.name, call.args);
      } catch (err) {
        content = `Tool error: ${err.message}`;
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content });
    }
  }

  const sources = [...sourceMap.values()];
  return {
    answer: sources.length
      ? `I stopped because the agent step limit was reached. Here are the gathered sources: ${sources.map(s => `[${s.id}]`).join(' ')}`
      : 'I stopped because the agent step limit was reached before gathering evidence.',
    sources,
    trace,
    usedLLM: true,
    usedAgent: true
  };
}

function fallbackAnswer(question, sources) {
  if (!sources.length) return 'I could not find relevant information in the SubsiWiki knowledge base. Try rephrasing or ingest more sources.';
  return `I found relevant SubsiWiki sources, but no LLM API key is configured, so this is a retrieval-only result. Review these excerpts for your question: "${question}"\n\n` +
    sources.map(s => `[${s.id}] ${s.title}: ${s.excerpts[0]}`).join('\n\n');
}

app.post('/api/query', async (req, res) => {
  try {
    const question = String(req.body?.question || '').trim();
    if (!question) return res.status(400).json({ error: 'Question is required.' });
    await loadKnowledgeBase();
    if (process.env.OPENROUTER_API_KEY && req.body?.agent !== false) {
      const result = await runAgent(question, { allowWeb: Boolean(req.body?.allowWeb) });
      return res.json(result);
    }
    const chunks = retrieve(question, 10);
    const sources = uniqueSources(chunks);
    const answer = process.env.OPENROUTER_API_KEY
      ? await askOpenRouter(question, chunks, sources)
      : fallbackAnswer(question, sources);
    res.json({ answer, sources, usedLLM: Boolean(process.env.OPENROUTER_API_KEY), usedAgent: false, trace: [] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Server error' });
  }
});

app.get('/api/sources', async (_req, res) => {
  await loadKnowledgeBase();
  res.json(cache.docs.map(d => ({ title: d.title, url: d.url, relatedUrls: d.relatedUrls || [], path: d.relPath, kind: d.kind })));
});

app.post('/api/reload', async (_req, res) => {
  await loadKnowledgeBase(true);
  res.json({ ok: true, docs: cache.docs.length, chunks: cache.chunks.length });
});

app.listen(PORT, async () => {
  await loadKnowledgeBase().catch(err => console.warn('Initial KB load failed:', err.message));
  console.log(`SubsiWiki API running on http://localhost:${PORT}`);
  console.log(`Vault: ${VAULT_DIR}`);
});
