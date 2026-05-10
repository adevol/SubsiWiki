# SubsiWiki AI Website

React + Express app that lets users query the Obsidian knowledge base and receive answers with clickable citations.

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

## How it works

- Reads markdown from `SubsiWiki/`
- Extracts frontmatter `source` / `source_url` fields from clippings and source summaries
- Retrieves relevant chunks for the user's question
- Sends only those excerpts to the LLM
- Forces bracket citations like `[1]`
- Shows a cited source list with official URLs when available

## Useful endpoints

- `POST /api/query` — ask a question
- `GET /api/sources` — list loaded sources
- `POST /api/reload` — reload markdown from disk
