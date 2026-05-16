# Web Retrieval

SubsiWiki's active Python backend uses Browserbase Search as an optional source
of web snippets. It does not fetch or extract full web pages.

For the full request flow and source model, see [architecture.md](architecture.md).

## Enabling Live Web

The `/api/query` endpoint accepts `allowWeb` in the JSON body. Web search runs
only when `allowWeb` is exactly `true`.

```json
{
  "question": "What EU funding is open for small businesses?",
  "allowWeb": true
}
```

The React UI defaults this toggle to off. If `allowWeb` is omitted, `false`, or a
string such as `"true"`, the backend does not search the web.

## Configuration

| Env var | Effect | Default |
|---------|--------|---------|
| `BROWSERBASE_API_KEY` | Enables Browserbase Search | unset |
| `OPENROUTER_API_KEY` | Enables generated LLM answers | unset |
| `OPENROUTER_MODEL` | Overrides the model in `config.yaml` | unset |
| `MAX_TOKENS` | Caps the LLM response | `1200` |

Without `BROWSERBASE_API_KEY`, web search is skipped and vault retrieval still
runs normally.

## Search Pipeline

When live web is enabled and a Browserbase key is configured, `main.py` sends:

```http
POST https://api.browserbase.com/v1/search
```

with `numResults: 5`. Each result is normalized into a source with:

- `title`: Browserbase `title`, `name`, or `(untitled)`.
- `url`: Browserbase `url` or `link`.
- `text`: Browserbase `snippet` or `description`, capped in the shared source
  format.
- `sourceType`: `web`.

These web sources are search result snippets. They are useful for lightweight
context and candidate links, but they are not equivalent to reading the target
page.

## Caching

Search results are cached in process by `(kind, query)`. `POST /api/reload`
clears both vault and web result caches.

Because web results can go stale, restart the API or call `/api/reload` when
testing current or time-sensitive funding questions.

## Error Handling

Browserbase failures do not fail the whole answer. Instead:

- The exception is logged with the query.
- The API falls back to vault-only retrieval.
- The `trace` entry for `search_web` includes an `error` field.

Example:

```json
{
  "tool": "search_web",
  "input": "latest EU SME funding calls",
  "sources": [],
  "error": "401 Unauthorized"
}
```

This keeps user-facing answers available while making broken web search visible
in logs and the API response.

## Current Limitations

- No `fetch_url` tool.
- No Browserbase Fetch call.
- No JavaScript rendering.
- No page extraction beyond search result snippets.
- No robots.txt handling, URL allow lists, or SSRF validation because the active
  backend does not fetch arbitrary user-supplied URLs.
