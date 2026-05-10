# SubsiWiki Agent Instructions

SubsiWiki is an LLM-maintained Obsidian vault about EU funding, grants, tenders, subsidies, and application processes.

## Layers

- `Clippings/`: raw source documents imported from the web. Treat as immutable source of truth. Do not edit except to fix import corruption at the user's request.
- `Wiki/`: synthesized, interlinked markdown maintained by the LLM.
- `Wiki/index.md`: content-oriented catalog. Read this first when answering questions.
- `Wiki/log.md`: append-only chronological activity log.

## Wiki structure

- `Wiki/Sources/`: one summary page per raw source.
- `Wiki/Programs/`: EU funding programme pages.
- `Wiki/Concepts/`: reusable concepts such as funding types and management modes.
- `Wiki/Guides/`: practical workflows/checklists.
- `Wiki/Entities/`: institutions, agencies, portals, and authorities.

## Page conventions

Use YAML frontmatter when useful:

```yaml
---
type: source|program|concept|guide|entity|index|log
created: YYYY-MM-DD
updated: YYYY-MM-DD
sources:
  - "[[Source Page]]"
tags:
  - eu-funding
---
```

Prefer Obsidian wikilinks (`[[Page Name]]`) for internal links. Cite source pages in a `## Sources` section. Keep claims traceable to raw clippings through the source summary pages.

## Ingest workflow

When processing a new file in `Clippings/`:

1. Read the clipping fully.
2. Create or update a matching `Wiki/Sources/...` summary page with source URL, key points, useful links, and extracted facts.
3. Update relevant program, concept, guide, and entity pages.
4. Update `Wiki/index.md`.
5. Append an entry to `Wiki/log.md` with prefix format: `## [YYYY-MM-DD] ingest | Title`.

## Query workflow

1. Read `Wiki/index.md` first.
2. Open the most relevant wiki pages.
3. Answer with citations using wikilinks to relevant wiki/source pages.
4. If the answer is reusable, ask whether to save it as a new wiki page or create it directly if requested.

## Lint workflow

Periodically check for stale claims, orphan pages, missing cross-links, duplicated concepts, and important source claims not reflected in synthesis pages. Append lint results to `Wiki/log.md`.
