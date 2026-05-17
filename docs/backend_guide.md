# SubsiWiki Backend Guide

This guide describes the FastAPI backend (`main.py`) that powers the SubsiWiki RAG (Retrieval-Augmented Generation) application.

## Overview

The backend answers user questions by retrieving relevant content from a local markdown vault and optionally the web, then synthesizing an answer via an LLM through OpenRouter.

## File Structure

```
main.py              # FastAPI app and all core logic
config.yaml          # Model selection, system prompts
.env                 # API keys and environment variables
SubsiWiki/           # Default markdown vault directory
```

## Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `OPENROUTER_API_KEY` | API key for LLM calls via OpenRouter | — |
| `OPENROUTER_MODEL` | Model identifier for answering | Value from `config.yaml` |
| `OPENROUTER_SOURCE_CHECK_MODEL` | Smaller model for verifying citations | `openai/gpt-5-mini` |
| `BROWSERBASE_API_KEY` | Enables web search retrieval | — |
| `VAULT_DIR` | Path to the markdown vault | `SubsiWiki` |
| `SUBSIWIKI_CONFIG` | Path to YAML config file | `config.yaml` |
| `MAX_TOKENS` | Token limit for main answer generation | `1200` |
| `SOURCE_CHECK_MAX_TOKENS` | Token limit for source verification | `500` |
| `WEB_CACHE_TTL_SECONDS` | Cache duration for web results (`0` to disable) | `3600` |

## Core Functions

### Configuration & Setup

- **`config()`** — Loads and caches `config.yaml`.
- **`model_name()`** — Resolves the main LLM model name, ensuring the `openrouter/` prefix.
- **`source_check_model()`** — Resolves the verification model name.

### Source Building

- **`build_source(title, text, ...)`** — Creates a standardized source dictionary containing title, path/URL, source type (`vault` or `web`), excerpts, text snippet, and relevance score.

### Vault Indexing

- **`vault_path()`** — Returns the resolved `Path` to the vault directory.
- **`build_vault_index(vault)`** — Scans all `*.md` files under the vault, loads them with `SimpleDirectoryReader`, splits into nodes with `SentenceSplitter` (chunk size 900, overlap 80), and builds a `BM25Retriever` (top-k = 8).  
  **Cached per vault path.** Returns `None` if the vault is missing or empty.

### Retrieval

- **`results(kind, query)`** — Unified retrieval interface.
  - `"vault"` → BM25 search over the local markdown index.
  - `"web"` → Browserbase web search API (up to 5 results).
- **`_vault_results(query)`** — Caches vault results per query for the process lifetime.
- **`_web_results(query)`** — Caches web results in a `TTLCache` (default 1 hour).

### Answer Generation

- **`number_sources(sources)`** — Deduplicates sources by URL/path/title and assigns contiguous IDs starting at 1.
- **`context(sources)`** — Formats numbered sources into a single string for the LLM prompt.
- **`fallback(question, sources, error)`** — Returns a deterministic excerpt-based answer when the LLM is unavailable.
- **`source_check(answer_text, sources)`** — Uses a second smaller LLM to verify that citations in the answer are actually supported by the sources. Returns a JSON dict with `status` (`pass`/`warn`/`fail`), `summary`, and `issues`.
- **`answer(question, allow_web, check_sources)`** — Main orchestration function:
  1. Retrieves vault sources (always).
  2. Optionally retrieves web sources.
  3. Deduplicates and numbers all sources.
  4. Calls the LLM via `litellm` if `OPENROUTER_API_KEY` is set.
  5. Runs source verification if `check_sources=True`.
  6. Falls back to excerpts on any LLM failure.

  Returns a dict with:
  - `answer` (str)
  - `sources` (list)
  - `trace` (list of tool calls)
  - `usedLLM` (bool)
  - `sourceCheck` (dict, optional)

## API Endpoints

### `POST /api/query`

Ask a question.

**Request body:**
```json
{
  "question": "What is the SubsiWiki vault?",
  "allowWeb": false,
  "checkSources": true
}
```

**Response:**
```json
{
  "answer": "The SubsiWiki vault is a local directory of markdown files...",
  "sources": [...],
  "trace": [...],
  "usedLLM": true,
  "sourceCheck": {
    "status": "pass",
    "summary": "The answer is well-supported by the sources.",
    "issues": [],
    "citedIds": [1, 2],
    "missingCitationIds": [],
    "model": "openrouter/openai/gpt-5-mini"
  }
}
```

### `GET /api/sources`

List all markdown files in the vault.

**Response:**
```json
[
  {"title": "README", "path": "README.md", "kind": "vault"},
  {"title": "guide", "path": "docs/guide.md", "kind": "vault"}
]
```

### `POST /api/reload`

Clear all caches and rebuild the vault index. Use this after adding or editing vault files.

**Response:**
```json
{"ok": true}
```

## Caching Behavior

| Cache | Scope | Trigger to Clear |
|-------|-------|-----------------|
| `config()` | Process lifetime | `api_reload()` |
| `build_vault_index()` | Per vault path | `api_reload()` |
| `_vault_results()` | Per query | `api_reload()` |
| `WEB_CACHE` (TTLCache) | Per query, TTL-based | `api_reload()` or time expiration |

## Error Handling

- **Missing vault** — Returns empty vault results; LLM may still answer from web sources if enabled.
- **Missing `BROWSERBASE_API_KEY`** — Web retrieval silently returns empty results.
- **Missing `OPENROUTER_API_KEY`** — Automatically falls back to excerpt-based answer (`usedLLM: false`).
- **LLM call failure** — Falls back to excerpt-based answer with the error message included.
- **Source check failure** — Returns `status: "warn"` with the exception message; does not crash the request.
