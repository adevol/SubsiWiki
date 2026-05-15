import argparse, json, logging, os, subprocess
from pathlib import Path

import httpx, litellm, yaml
from dotenv import load_dotenv
from llama_index.core import SimpleDirectoryReader
from llama_index.core.node_parser import SentenceSplitter
from llama_index.retrievers.bm25 import BM25Retriever

COLORS = {"you": 94, "assistant": 93, "tool": 32, "dim": 2, "error": 31}
def c(role, text): return f"\033[{COLORS[role]}m{text}\033[0m"

logging.getLogger("bm25s").setLevel(logging.WARNING)


def read_file(path: str) -> str:
    return Path(path).read_text(encoding="utf-8")

def list_files(directory: str = ".") -> str:
    entries = sorted(Path(directory).iterdir(), key=lambda p: (p.is_file(), p.name))
    return "\n".join(("  " if e.is_file() else "[D] ") + e.name for e in entries) or "(empty)"

def edit_file(path: str, content: str) -> str:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")
    return f"Successfully wrote {path}"

def run_bash(command: str) -> str:
    r = subprocess.run(command, shell=True, capture_output=True, text=True, timeout=30)
    return (r.stdout + r.stderr).strip() or "(no output)"

KB = {"vault": None, "retriever": None}

def load_vault() -> None:
    vault = Path(os.getenv("VAULT_DIR", "SubsiWiki")).resolve()
    if KB["vault"] == vault and KB["retriever"]:
        return
    docs = SimpleDirectoryReader(
        vault,
        recursive=True,
        required_exts=[".md"],
        filename_as_id=True,
        file_metadata=lambda p: {"path": Path(p).relative_to(vault).as_posix()},
    ).load_data()
    nodes = SentenceSplitter(chunk_size=900, chunk_overlap=80).get_nodes_from_documents(docs)
    KB.update(vault=vault, retriever=BM25Retriever.from_defaults(nodes=nodes, similarity_top_k=8) if nodes else None)

def search_vault(query: str) -> str:
    load_vault()
    if not KB["retriever"]:
        return "No vault chunks found."
    return "\n\n".join(
        f"{i}. {r.node.metadata.get('path', Path(r.node.node_id).as_posix())}\n"
        f"Score: {(r.score or 0):.2f}\n"
        f"Excerpt: {r.node.get_content(metadata_mode='none').strip()[:1200]}"
        for i, r in enumerate(KB["retriever"].retrieve(query), 1)
    ) or "No relevant vault results found."

def search_web(query: str) -> str:
    key = os.getenv("BROWSERBASE_API_KEY")
    if not key:
        return "Error: BROWSERBASE_API_KEY is not set."
    r = httpx.post(
        "https://api.browserbase.com/v1/search",
        headers={"Content-Type": "application/json", "X-BB-API-Key": key},
        json={"query": query, "numResults": 8},
        timeout=20,
    )
    r.raise_for_status()
    results = r.json().get("results", [])
    return "\n\n".join(
        f"{i}. {x.get('title') or x.get('name') or '(untitled)'}\n"
        f"URL: {x.get('url') or x.get('link') or ''}\n"
        f"Snippet: {x.get('snippet') or x.get('description') or ''}"
        for i, x in enumerate(results, 1)
    ) or "No results found."


def tool(func, desc, *params):
    schema = {"type": "function", "function": {
        "name": func.__name__, "description": desc,
        "parameters": {"type": "object",
                       "properties": {p: {"type": "string"} for p in params},
                       "required": list(params)}}}
    return func.__name__, (func, schema)

TOOLS = dict([
    tool(read_file,  "Read a file.",             "path"),
    tool(list_files, "List a directory.",        "directory"),
    tool(edit_file,  "Write content to a file.", "path", "content"),
    tool(run_bash,   "Run a shell command.",     "command"),
    tool(search_vault, "Search the Obsidian vault with BM25.", "query"),
    tool(search_web, "Search the web with Browserbase.", "query"),
])

def runtool(name: str, args: dict) -> str:
    if name not in TOOLS:
        return f"Error: unknown tool: {name}"
    try:
        return TOOLS[name][0](**args)
    except Exception as e:
        return f"Error: {e}"


def cmd_context(messages, model):
    window = (litellm.get_model_info(model) or {}).get("max_input_tokens") or 0
    used = litellm.token_counter(model=model, messages=messages)
    pct = f" ({used / window * 100:.1f}%)" if window else ""
    print(c("dim", f"  window: {window or '?'}  |  used: {used:,}{pct}"))
    for role in ("system", "user", "assistant", "tool"):
        msgs = [m for m in messages if m.get("role") == role]
        if msgs:
            print(c("dim", f"    {role:<10} {litellm.token_counter(model=model, messages=msgs):>7,}  ({len(msgs)} msg)"))
    print()

COMMANDS = {"/context": cmd_context}


def main() -> None:
    load_dotenv()
    parser = argparse.ArgumentParser(description="SubsiWiki harness")
    parser.add_argument("--model", default=None, help="litellm model string")
    parser.add_argument("--config", default="config.yaml", help="Path to YAML config file")
    args = parser.parse_args()

    cfg = yaml.safe_load(Path(args.config).read_text(encoding="utf-8"))
    COLORS.update(cfg.get("colors", {}))
    model = args.model or cfg["model"]
    litellm.suppress_debug_info = True

    print(c("dim", f"SubsiWiki harness  |  model: {model}  (ctrl-c to quit)") + "\n")
    messages = [{"role": "system", "content": cfg["system_prompt"].strip()}]

    while True:
        try:
            prompt = input(c("you", "You: ")).strip()
        except (KeyboardInterrupt, EOFError):
            print()
            break
        if not prompt:
            continue
        if prompt in ("exit", "quit", "q"):
            break
        if prompt in COMMANDS:
            COMMANDS[prompt](messages, model)
            continue
        messages.append({"role": "user", "content": prompt})
        try:
            while True:
                reply = litellm.completion(
                    model=model, messages=messages, tools=[t[1] for t in TOOLS.values()],
                ).choices[0].message.model_dump()
                messages.append(reply)
                if not reply.get("tool_calls"):
                    print(f"\n{c('assistant', 'Agent:')} {reply.get('content', '')}\n")
                    break
                for tc in reply["tool_calls"]:
                    name = tc["function"]["name"]
                    tool_args = json.loads(tc["function"]["arguments"])
                    short = ", ".join(f"{k}={repr(v)[:50]}" for k, v in tool_args.items())
                    print(c("tool", f"  [{name}]") + c("dim", f"({short})"))
                    result = runtool(name, tool_args)
                    messages.append({"role": "tool", "tool_call_id": tc["id"], "content": result})
        except Exception as e:
            print(c("error", f"  [error] {type(e).__name__}: {e}\n"))

if __name__ == "__main__":
    main()
