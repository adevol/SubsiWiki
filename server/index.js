import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';

const app = express();
const PORT = process.env.PORT || 8787;
const MODEL = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';
const VAULT_DIR = path.resolve(process.env.VAULT_DIR || 'SubsiWiki');

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
      map.set(key, { id: map.size + 1, title: c.title, url: c.url, relatedUrls: c.relatedUrls || [], path: c.relPath, kind: c.kind, excerpts: [] });
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
    const chunks = retrieve(question, 10);
    const sources = uniqueSources(chunks);
    const answer = process.env.OPENROUTER_API_KEY
      ? await askOpenRouter(question, chunks, sources)
      : fallbackAnswer(question, sources);
    res.json({ answer, sources, usedLLM: Boolean(process.env.OPENROUTER_API_KEY) });
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
