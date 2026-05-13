# SubsiWiki AI Website

React + Express app that lets users ask an Obsidian knowledge base questions and receive grounded answers with clickable citations. The server now includes a small custom agent harness that searches the vault first and can inspect live web pages when the user allows it.

## Traits

- Minimal agent loop: model, tool calls, tool results, final answer.
- Vault-first retrieval from Markdown files in `SubsiWiki/`.
- Optional live web access through explicit tools.
- Browserbase support for live web search and hosted page fetches.
- Direct server-side URL fetch fallback when Browserbase is not configured.
- Citation-first answer style: every factual claim should cite gathered evidence.
- Guardrails for live web usage: step limits, fetch/search limits, and private-network URL blocking.
- Research trace shown in the UI so users can see which tools ran.

## Setup

```bash
npm install
cp .env.example .env
# edit .env and add OPENROUTER_API_KEY for generated answers
npm run dev
```

- Frontend: http://localhost:5173
- API: http://localhost:8787

If `OPENROUTER_API_KEY` is not set, the app still works in retrieval-only mode and returns cited excerpts from the vault.

To enable live web search and Browserbase-backed fetching, set:

```bash
BROWSERBASE_API_KEY=...
```

Without `BROWSERBASE_API_KEY`, the agent can still fetch explicit public URLs with the local fallback, but `search_web` is unavailable.

## How It Works

- Reads Markdown from `SubsiWiki/`.
- Extracts frontmatter `source` / `source_url` fields from clippings and source summaries.
- Chunks vault documents into searchable excerpts.
- Runs a small agent harness for `/api/query`.
- Gives the model narrow tools: `search_vault`, `fetch_url`, and `search_web`.
- Normalizes vault and web pages into the same source format.
- Forces bracket citations like `[1]`.
- Shows cited sources and the research trace in the frontend.

## Useful Endpoints

- `POST /api/query` - ask a question.
- `GET /api/sources` - list loaded sources.
- `POST /api/reload` - reload Markdown from disk.

## Docs

- [Architecture](docs/architecture.md)
- [Web retrieval considerations](docs/web-retrieval.md)
