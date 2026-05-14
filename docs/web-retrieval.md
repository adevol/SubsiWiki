# Web Retrieval

How `search_web` and `fetch_url` behave at runtime. For the agent loop, evidence model, and SSRF rules, see [architecture.md](architecture.md).

## Tools

| Tool | Arguments | When the agent calls it | Returns |
|------|-----------|-------------------------|---------|
| `search_web` | `query` | Vault has no useful evidence and the agent needs candidate URLs | Up to 8 Browserbase Search results (title, URL, snippet) |
| `fetch_url` | `url`, `reason` | The agent has a specific URL worth reading | One web evidence source: title, URL, extracted text chunks |

The agent is instructed to call `search_vault` first; web tools are a fallback. See the system prompt in [server/index.js](../server/index.js).

## Enabling live web

The `/api/query` endpoint accepts `allowWeb` in the request body. **It defaults to `true`.** To disable live web for a request, send `allowWeb: false`; both web tools will return `"Live web access is disabled for this run."` to the model without making any network call.

## Configuration

| Env var | Effect | Default |
|---------|--------|---------|
| `BROWSERBASE_API_KEY` | Required for `search_web`. Switches `fetch_url` from direct fetch to Browserbase Fetch | unset |
| `BROWSERBASE_FETCH_PROXIES` | When `"true"`, Browserbase Fetch routes through proxies | `"false"` |
| `AGENT_MAX_WEB_FETCHES` | Hard cap on `fetch_url` calls per run | `15` |
| `AGENT_MAX_WEB_SEARCHES` | Hard cap on `search_web` calls per run | `5` |
| `AGENT_MAX_STEPS` | Total tool/answer steps before the loop bails | `8` |
| `OPENROUTER_SOURCE_CHECK_MODEL` | Optional verifier model used when `checkSources` is enabled | `OPENROUTER_MODEL` |

## `fetch_url` pipeline

1. `assertPublicHttpUrl` validates the URL — see [SSRF Rules](architecture.md#ssrf-rules) in architecture.md.
2. If `BROWSERBASE_API_KEY` is set, `POST /v1/fetch` to Browserbase; otherwise a direct `fetch()` with a 10 s timeout and `User-Agent: SubsiWikiBot/0.1`.
3. HTML is stripped to text and capped at 16 KB.
4. If under 80 characters of readable text remain, the tool errors with `"Fetched page did not contain enough readable text."`
5. Remaining text is chunked into up to 8 chunks of ~1100 characters each.

Browserbase Fetch does not execute JavaScript. Single-page apps and pages that hydrate content client-side will look empty.

## `search_web` pipeline

`POST /v1/search` to Browserbase with `numResults: 8`. Each result is formatted for the agent as a numbered block with title, URL, and snippet. Without `BROWSERBASE_API_KEY`, the tool errors immediately.

## Error contract

What the agent literally receives:

- Live web disabled: `"Live web access is disabled for this run."`
- Fetch limit reached: `"Live web fetch limit reached."`
- Search limit reached: `"Live web search limit reached."`
- SSRF rejection, fetch timeout, Browserbase non-200, or empty page: `"Tool error: <message>"`

Errors are surfaced to the model so it can decide whether to try a different URL, retry, or give up cleanly.

## Verifying locally

Minimum `.env`:

```
OPENROUTER_API_KEY=...
BROWSERBASE_API_KEY=...
```

```
curl -s http://localhost:8787/api/query \
  -H 'content-type: application/json' \
  -d '{"question":"What EU funding is open for small businesses?","checkSources":true}'
```

The response `trace` array shows every tool call in order with inputs and resulting source IDs. An empty `trace` means the agent answered from the vault alone.
When `checkSources` is true, the response also includes a `sourceCheck` object with `pass`, `warn`, or `fail` status and any verifier issues.

## Current scope

The implementation deliberately stops at a small operational footprint:

- One-shot, on-demand page fetches of public HTTP(S) URLs.
- Lexical web search via Browserbase.
- In-memory results: fetched pages are not persisted or cached between runs, or saved to the knowledge base.
- No JavaScript rendering, scheduled crawls, structured extraction, vector retrieval, per-user/tenant budgets, robots.txt enforcement, URL allow/deny lists, or response caching.

For a fuller implementation that needs scheduled crawls, dynamic page rendering, adaptive CSS/XPath selectors, or proxy rotation, [Scrapling](https://github.com/D4Vinci/Scrapling) is the natural upgrade path, a Python scraping framework with spiders, stealth fetchers, and an MCP server. Browserbase remains the simpler choice while those capabilities aren't needed.
