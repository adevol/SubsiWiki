# SubsiWiki AI — EU Funding Search for SMEs

SubsiWiki AI is a React + FastAPI application built to help **small and medium enterprises (SMEs) find and understand EU funding opportunities**. It lets users ask natural-language questions about grants, tenders, subsidies and programmes, and receive grounded answers with clickable citations drawn from a curated Obsidian knowledge base.

The knowledge base is seeded with research clipped from official EU sources, stored in `SubsiWiki/Clippings`:

- `EU Funding & Tenders Portal.md`
- `Funding opportunities for small businesses.md`
- `Funding opportunities.md`
- `Funding programmes and open calls.md`
- `Funding, grants, subsidies  European Union.md`
- `Funding.md`
- `The application process.md`

## Traits

- **Vault-first retrieval** — BM25 search over Markdown files in `SubsiWiki/` (clippings and wiki notes).
- **Optional live web search** — Browserbase can augment answers with current open calls and portal updates.
- **Citation-first answers** — every factual claim cites gathered evidence so SMEs can verify and follow up.
- **Fallback retrieval** when the LLM call fails.
- **Optional small-model source checking**.
- **Research trace** shown in the UI so users see which tools ran and what sources were used.

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

To enable live web search, set:

```bash
BROWSERBASE_API_KEY=...
```

Without `BROWSERBASE_API_KEY`, live web search is skipped and the API still searches the vault.

## Python API

The Python backend lives in `main.py`: a minimal FastAPI/LiteLLM app with BM25 vault retrieval and optional Browserbase web search.

```bash
uv run uvicorn main:app --host 0.0.0.0 --port 8787
```

Set `BROWSERBASE_API_KEY` in `.env` to enable web search.
Set `VAULT_DIR` to change the vault path; it defaults to `SubsiWiki`.
`npm run dev` uses the Python API.

## How It Works

- Reads Markdown from `SubsiWiki/` (including the `Clippings` folder with EU funding research).
- Uses LlamaIndex to read and chunk vault Markdown.
- Runs deterministic retrieval for `/api/query`.
- Sends the gathered source context to the model in one call.
- Normalizes vault and web search results into the same source format.
- Logs failed vault file reads and Browserbase search errors.
- Forces bracket citations like `[1]`.
- Shows cited sources and the research trace in the frontend.

## Useful Endpoints

- `POST /api/query` - ask a question.
- `GET /api/sources` - list loaded sources.
- `POST /api/reload` - reload Markdown from disk.

## Docs

- [Architecture](docs/architecture.md)
- [Web retrieval considerations](docs/web-retrieval.md)
