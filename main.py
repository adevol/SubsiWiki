import logging, os
from functools import cache
from pathlib import Path

import httpx, litellm, yaml
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from llama_index.core import SimpleDirectoryReader
from llama_index.core.node_parser import SentenceSplitter
from llama_index.retrievers.bm25 import BM25Retriever

load_dotenv()
logging.getLogger("bm25s").setLevel(logging.WARNING)
logging.getLogger("LiteLLM").setLevel(logging.WARNING)
logging.getLogger("litellm").setLevel(logging.WARNING)
litellm.suppress_debug_info = True

def config() -> dict:
    return yaml.safe_load(Path(os.getenv("SUBSIWIKI_CONFIG", "config.yaml")).read_text(encoding="utf-8"))

def model_name() -> str:
    model = os.getenv("OPENROUTER_MODEL") or config()["model"]
    return model if model.startswith("openrouter/") else f"openrouter/{model}"

def source(title, text, *, path="", url="", kind="", score=0) -> dict:
    return {
        "title": title,
        "path": path,
        "url": url,
        "kind": kind,
        "sourceType": "web" if url else "vault",
        "excerpts": [text[:320]],
        "text": text[:1200],
        "score": score,
    }

def vault_path() -> Path:
    return Path(os.getenv("VAULT_DIR", "SubsiWiki")).resolve()

@cache
def retriever(vault: Path):
    docs = SimpleDirectoryReader(
        vault,
        recursive=True,
        required_exts=[".md"],
        filename_as_id=True,
        file_metadata=lambda p: {"path": Path(p).relative_to(vault).as_posix()},
    ).load_data()
    nodes = SentenceSplitter(chunk_size=900, chunk_overlap=80).get_nodes_from_documents(docs)
    return BM25Retriever.from_defaults(nodes=nodes, similarity_top_k=8) if nodes else None

@cache
def results(kind: str, query: str) -> tuple[dict, ...]:
    if kind == "vault":
        r = retriever(vault_path())
        if not r:
            return ()
        return tuple(source(
            path := x.node.metadata.get("path", Path(x.node.node_id).as_posix()),
            x.node.get_content(metadata_mode="none").strip(),
            path=path,
            kind="vault",
            score=x.score or 0,
        ) for x in r.retrieve(query))

    if kind != "web":
        return ()
    key = os.getenv("BROWSERBASE_API_KEY")
    if not key:
        return ()
    r = httpx.post(
        "https://api.browserbase.com/v1/search",
        headers={"Content-Type": "application/json", "X-BB-API-Key": key},
        json={"query": query, "numResults": 5},
        timeout=20,
    )
    r.raise_for_status()
    return tuple(source(
        x.get("title") or x.get("name") or "(untitled)",
        x.get("snippet") or x.get("description") or "",
        url=x.get("url") or x.get("link") or "",
        kind="web search",
    ) for x in r.json().get("results", []))

def number_sources(sources: list[dict]) -> list[dict]:
    numbered, seen = [], set()
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
    if not sources:
        return "I could not find relevant information in the SubsiWiki vault."
    answer = f"I found relevant SubsiWiki sources for: {question}\n\n"
    answer += "\n\n".join(f"[{s['id']}] {s['title']}: {s['excerpts'][0]}" for s in sources[:5])
    return answer + (f"\n\nLLM call failed: {error}" if error else "")

def answer(question: str, allow_web: bool = False) -> dict:
    try:
        found = list(results("vault", question)) + (list(results("web", question)) if allow_web else [])
    except Exception:
        found = list(results("vault", question))
    sources = number_sources(found)
    trace = [{"tool": "search_vault", "input": question, "sources": [s["id"] for s in sources if s["sourceType"] == "vault"]}]
    if allow_web:
        trace.append({"tool": "search_web", "input": question, "sources": [s["id"] for s in sources if s["sourceType"] == "web"]})
    if not os.getenv("OPENROUTER_API_KEY"):
        return {"answer": fallback(question, sources), "sources": sources, "trace": trace, "usedLLM": False, "usedAgent": False}
    try:
        msg = litellm.completion(
            model=model_name(),
            max_tokens=int(os.getenv("MAX_TOKENS", "1200")),
            messages=[
                {"role": "system", "content": config()["system_prompt"].strip()},
                {"role": "user", "content": f"Question: {question}\n\nSources:\n{context(sources)}"},
            ],
        ).choices[0].message.content
        return {"answer": msg, "sources": sources, "trace": trace, "usedLLM": True, "usedAgent": False}
    except Exception as e:
        return {"answer": fallback(question, sources, str(e)), "sources": sources, "trace": trace, "usedLLM": False, "usedAgent": False}

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

@app.post("/api/query")
def api_query(body: dict):
    question = str(body.get("question", "")).strip()
    if not question:
        raise HTTPException(status_code=400, detail="Question is required.")
    return answer(question, allow_web=body.get("allowWeb", False) is True)

@app.get("/api/sources")
def api_sources():
    vault = vault_path()
    return [{"title": p.stem, "path": p.relative_to(vault).as_posix(), "kind": "vault"} for p in vault.rglob("*.md")]

@app.post("/api/reload")
def api_reload():
    retriever.cache_clear()
    results.cache_clear()
    retriever(vault_path())
    return {"ok": True}
