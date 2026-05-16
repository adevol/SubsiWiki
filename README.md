# SubsiWiki AI Website

React + FastAPI app that lets users ask an Obsidian knowledge base questions and receive grounded answers with clickable citations. The Python backend searches the vault first, optionally adds Browserbase web search results, then makes one model call.

## Traits

- Minimal Python request flow: retrieve sources, answer from context, return citations.
- Vault-first BM25 retrieval from Markdown files in `SubsiWiki/`.
- Optional live web search through Browserbase.
- Citation-first answer style: every factual claim should cite gathered evidence.
- Fallback retrieval when the LLM call fails.
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

- Reads Markdown from `SubsiWiki/`.
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
