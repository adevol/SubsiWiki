import json
import logging
import os
import re
from functools import cache
from pathlib import Path
from typing import Literal

import httpx
import litellm
import yaml  # type: ignore[import-untyped]
from cachetools import TTLCache
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from llama_index.core import SimpleDirectoryReader
from llama_index.core.node_parser import SentenceSplitter
from llama_index.retrievers.bm25 import BM25Retriever  # type: ignore[import-untyped]

load_dotenv()
logger = logging.getLogger("subsiwiki")
logging.getLogger("bm25s").setLevel(logging.WARNING)
logging.getLogger("LiteLLM").setLevel(logging.WARNING)
logging.getLogger("litellm").setLevel(logging.WARNING)
litellm.suppress_debug_info = True
WEB_CACHE_TTL = int(os.getenv("WEB_CACHE_TTL_SECONDS", "3600"))
WEB_CACHE: TTLCache | None = TTLCache(maxsize=1024, ttl=WEB_CACHE_TTL) if WEB_CACHE_TTL > 0 else None

@cache
def config() -> dict:
    return yaml.safe_load(Path(os.getenv("SUBSIWIKI_CONFIG", "config.yaml")).read_text(encoding="utf-8"))

def _openrouter(model: str) -> str:
    return model if model.startswith("openrouter/") else f"openrouter/{model}"

def model_name() -> str:
    return _openrouter(os.getenv("OPENROUTER_MODEL") or config()["model"])

def source_check_model() -> str:
    return _openrouter(os.getenv("OPENROUTER_SOURCE_CHECK_MODEL", "openai/gpt-5-mini"))

def build_source(title: str, text: str, *, path: str = "", url: str = "", score: float = 0) -> dict:
    """Return a structured source dictionary."""
    return {
        "title": title,
        "path": path,
        "url": url,
        "sourceType": "web" if url else "vault",
        "excerpts": [text[:320]],
        "text": text[:1200],
        "score": score,
    }

def vault_path() -> Path:
    return Path(os.getenv("VAULT_DIR", "SubsiWiki")).resolve()

@cache
def build_vault_index(vault: Path) -> BM25Retriever | None:
    """Build a BM25 retriever over the vault's markdown files.

    Args:
        vault: Absolute path to the vault root. Used as the cache key, so
            different paths get independent indexes.

    Returns:
        Configured ``BM25Retriever`` with ``similarity_top_k=8``, or ``None``
        if the vault is missing, empty, or contains no readable markdown.
    """
    if not vault.exists():
        logger.warning("Vault directory does not exist: %s", vault)
        return None
    if not vault.is_dir():
        logger.warning("Vault path is not a directory: %s", vault)
        return None

    markdown_files = sorted(vault.rglob("*.md"))
    if not markdown_files:
        logger.warning("Vault contains no markdown files: %s", vault)
        return None

    docs = []
    for markdown_file in markdown_files:
        try:
            docs.extend(SimpleDirectoryReader(
                input_files=[str(markdown_file)],
                filename_as_id=True,
                file_metadata=lambda p: {"path": Path(p).relative_to(vault).as_posix()},
            ).load_data())
        except Exception:
            logger.exception("Failed to read vault markdown file: %s", markdown_file)

    if not docs:
        logger.warning("No markdown documents could be loaded from vault: %s", vault)
        return None

    nodes = SentenceSplitter(chunk_size=900, chunk_overlap=80).get_nodes_from_documents(docs)
    return BM25Retriever.from_defaults(nodes=nodes, similarity_top_k=8) if nodes else None

@cache
def _vault_results(query: str) -> tuple[dict, ...]:
    r = build_vault_index(vault_path())
    if not r:
        return ()
    return tuple(build_source(
        path := x.node.metadata["path"],
        x.node.get_content(metadata_mode="none").strip(),
        path=path,
        score=x.score or 0,
    ) for x in r.retrieve(query))

def _web_results(query: str) -> tuple[dict, ...]:
    key = os.getenv("BROWSERBASE_API_KEY")
    if not key:
        return ()
    if WEB_CACHE is not None and query in WEB_CACHE:
        return WEB_CACHE[query]
    try:
        r = httpx.post(
            "https://api.browserbase.com/v1/search",
            headers={"Content-Type": "application/json", "X-BB-API-Key": key},
            json={"query": query, "numResults": 5},
            timeout=20,
        )
        r.raise_for_status()
        payload = r.json()
    except Exception:
        logger.exception("Browserbase web search failed for query: %s", query)
        raise
    web_sources = tuple(build_source(
        x.get("title") or x.get("name") or "(untitled)",
        x.get("snippet") or x.get("description") or "",
        url=x.get("url") or x.get("link") or "",
    ) for x in payload.get("results", []))
    if WEB_CACHE is not None:
        WEB_CACHE[query] = web_sources
    return web_sources

def results(kind: Literal["vault", "web"], query: str) -> tuple[dict, ...]:
    """Retrieve sources for ``query`` from the vault or the web.

    Vault results are cached per query for the process lifetime; web results
    use a short TTL cache controlled by ``WEB_CACHE_TTL_SECONDS``.

    Args:
        kind: ``"vault"`` for BM25 over the local markdown vault, ``"web"`` for
            Browserbase search.
        query: The search string passed verbatim to the retriever / search API.

    Returns:
        Tuple of source dicts. Empty if the vault is empty, ``BROWSERBASE_API_KEY``
        is unset, or ``kind`` is unrecognised.

    Raises:
        httpx.HTTPStatusError: If Browserbase returns a non-2xx response.
    """
    if kind == "vault":
        return _vault_results(query)
    if kind == "web":
        return _web_results(query)
    return ()

def number_sources(sources: list[dict]) -> list[dict]:
    """Assign sequential ``id`` fields to sources, dropping duplicate mentions of the same source.

    Dedup key is the first non-empty of ``url``, ``path``, ``title``. The first
    occurrence wins; later duplicates are dropped before numbering, so ids are
    always contiguous starting from 1.
    """
    numbered: list[dict] = []
    seen: set[str] = set()
    for s in sources:
        key = s["url"] or s["path"] or s["title"]
        if key in seen:
            continue
        seen.add(key)
        numbered.append({**s, "id": len(numbered) + 1})
    return numbered

def context(sources: list[dict]) -> str:
    return "\n\n".join(
        f"SOURCE [{s['id']}] {s['title']}\nLocation: {s['url'] or s['path']}\nExcerpt: {s['text']}"
        for s in sources
    )

def fallback(question: str, sources: list[dict], error: str = "") -> str:
    """A simple fallback answer when the LLM cannot be used.

    Lists the top sources found, without any synthesis.

    Args:
        question: The user's question.
        sources: The numbered sources found.
        error: The error message from the LLM call, if any.

    Returns:
        A string with the fallback answer (and error message, if applicable).
    """
    if not sources:
        return "I could not find relevant information in the SubsiWiki vault."
    answer = f"I found relevant SubsiWiki sources for: {question}\n\n"
    answer += "\n\n".join(f"[{s['id']}] {s['title']}: {s['excerpts'][0]}" for s in sources[:5])
    return answer + (f"\n\nLLM call failed: {error}" if error else "")

def source_check(answer_text: str, sources: list[dict]) -> dict:
    cited_ids = sorted({int(x) for x in re.findall(r"\[(\d+)\]", answer_text)})
    source_ids = {s["id"] for s in sources}
    missing_ids = [i for i in cited_ids if i not in source_ids]
    checked_sources = [s for s in sources if s["id"] in cited_ids] or sources[:5]
    try:
        msg = litellm.completion(
            model=source_check_model(),
            max_tokens=int(os.getenv("SOURCE_CHECK_MAX_TOKENS", "500")),
            messages=[
                {"role": "system", "content": "Check whether the answer is supported by the sources. Return only JSON with status pass|warn|fail, summary, and issues array."},
                {"role": "user", "content": f"Answer:\n{answer_text}\n\nSources:\n{context(checked_sources)}"},
            ],
        ).choices[0].message.content.strip()
        data = json.loads(msg[msg.find("{"):msg.rfind("}") + 1])
        if missing_ids and data.get("status") == "pass":
            data["status"] = "warn"
            data.setdefault("issues", []).append(f"Missing source IDs: {missing_ids}")
        return {**data, "citedIds": cited_ids, "missingCitationIds": missing_ids, "model": source_check_model()}
    except Exception as e:
        logger.exception("Source check failed")
        return {"status": "warn", "summary": "Source check failed.", "issues": [str(e)], "citedIds": cited_ids, "missingCitationIds": missing_ids, "model": source_check_model()}

def answer(question: str, allow_web: bool = False, check_sources: bool = False) -> dict:
    """Retrieve sources and synthesise an answer, falling back to excerpts on failure.

    Vault retrieval always runs; web retrieval runs only when ``allow_web`` is
    true and yields no results if ``BROWSERBASE_API_KEY`` is unset. If web
    retrieval raises, vault-only results are still returned. If
    ``OPENROUTER_API_KEY`` is unset or the LLM call fails, a deterministic
    excerpt-based fallback is returned instead.

    Args:
        question: The user's question.
        allow_web: If true, also query Browserbase and include those results in
            the LLM context.
        check_sources: If true, run a second smaller model to verify the answer
            against its cited sources.

    Returns:
        Dict with keys ``answer`` (str), ``sources`` (list[dict]), ``trace``
        (list[dict]), and ``usedLLM`` (bool). Includes ``sourceCheck`` (dict)
        when ``check_sources`` is true and the LLM call succeeded.
    """
    found: list[dict] = []
    web_error = ""
    try:
        found.extend(results("vault", question))
    except Exception:
        logger.exception("Vault search failed for query: %s", question)
    if allow_web:
        try:
            found.extend(results("web", question))
        except Exception as e:
            web_error = str(e) or e.__class__.__name__
    sources = number_sources(found)
    trace = [{"tool": "search_vault", "input": question, "sources": [s["id"] for s in sources if s["sourceType"] == "vault"]}]
    if allow_web:
        web_trace = {"tool": "search_web", "input": question, "sources": [s["id"] for s in sources if s["sourceType"] == "web"]}
        if web_error:
            web_trace["error"] = web_error
        trace.append(web_trace)
    if not os.getenv("OPENROUTER_API_KEY"):
        return {"answer": fallback(question, sources), "sources": sources, "trace": trace, "usedLLM": False}
    try:
        msg = litellm.completion(
            model=model_name(),
            max_tokens=int(os.getenv("MAX_TOKENS", "1200")),
            messages=[
                {"role": "system", "content": config()["system_prompt"].strip()},
                {"role": "user", "content": f"Question: {question}\n\nSources:\n{context(sources)}"},
            ],
        ).choices[0].message.content
        response = {"answer": msg, "sources": sources, "trace": trace, "usedLLM": True}
        if check_sources:
            response["sourceCheck"] = source_check(msg, sources)
        return response
    except Exception as e:
        return {"answer": fallback(question, sources, str(e)), "sources": sources, "trace": trace, "usedLLM": False}

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

@app.post("/api/query")
def api_query(body: dict) -> dict:
    question = str(body.get("question", "")).strip()
    if not question:
        raise HTTPException(status_code=400, detail="Question is required.")
    return answer(question, allow_web=body.get("allowWeb") is True, check_sources=body.get("checkSources") is True)

@app.get("/api/sources")
def api_sources() -> list[dict]:
    vault = vault_path()
    return [{"title": p.stem, "path": p.relative_to(vault).as_posix(), "kind": "vault"} for p in vault.rglob("*.md")]

@app.post("/api/reload")
def api_reload() -> dict:
    config.cache_clear()
    build_vault_index.cache_clear()
    _vault_results.cache_clear()
    if WEB_CACHE is not None:
        WEB_CACHE.clear()
    build_vault_index(vault_path())
    return {"ok": True}
