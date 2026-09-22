"""Merge LLM-produced model-parameter JSON into client/src/data/models.merged.json.

The JSON is produced by an LLM that read the official docs page (see SKILL.md
for the exact prompt + schema). Each record describes ONE platform side of a
model:

  {
    "platform": "opencode" | "cmdc",
    "key": "canonical merged key, e.g. gemini-3.8-flash (bare id, lower-dash)",
    "id":   "real callable id from the API list, e.g. google/gemini-3.8-flash",
    "name": "...", "provider": "...", "category": "opensource|premium",
    "context_size": 1000000,                // optional
    "pricing":  { input, output, cache_read, cache_write, tiers, time_of_day }, // optional
    "allowance":{ monthly_usd, plan_allowance },  // optional
    "notes": "...",                          // optional
    "deprecated": false
  }

apply_json merges each record onto the platform record of the merged model with
that key, creating the model when it does not yet exist. Only provided fields
are written; absent fields are left untouched (never nulled). Unknown keys in
the merged file and other platforms are preserved. A backup is written first.

Usage: python3 apply_json.py <llm_models.json> [--write]
"""
import argparse
import json
import re
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

from common import BACKUP_DIR, MERGED_PATH, dump_json, norm

# Canonical CC prefix for a provider family, used to double check the id the
# LLM returns against the API list when present.
PROVIDER_ANTHROPIC = {"anthropic", "claude"}


def _cc_protocol(provider: str | None, name: str | None) -> list:
    """CommandCode exposes only chat (/chat/completions) except Anthropic
    (messages). This mirrors how the catalog was originally built."""
    text = f"{provider or ''} {name or ''}".lower()
    if "anthropic" in text or "claude" in text:
        return ["messages"]
    return ["chat"]


def _platform_record(doc: dict, platform: str) -> dict:
    """Build the platform record payload from an LLM doc, keeping only fields
    that are present (never inventing values)."""
    rec = {"id": doc["id"]}
    if "protocols" in doc and doc["protocols"]:
        rec["protocols"] = list(doc["protocols"])
    elif platform == "cmdc":
        # Deterministic default; page never lists it.
        rec["protocols"] = _cc_protocol(doc.get("provider"), doc.get("name"))
    if "multimodal" in doc and doc["multimodal"]:
        rec["multimodal"] = list(doc["multimodal"])
    if "pricing" in doc and doc["pricing"]:
        rec["pricing"] = {"currency": "USD", **doc["pricing"]}
    if "allowance" in doc and doc["allowance"]:
        rec["allowance"] = doc["allowance"]
    if "discount" in doc and doc["discount"]:
        rec["discount"] = doc["discount"]
    if "deprecated" in doc:
        rec["deprecated"] = bool(doc["deprecated"])
    if "notes" in doc and doc.get("notes"):
        rec["notes"] = doc["notes"]
    rec["source"] = (
        "opencode.ai/docs/zh-cn/go" if platform == "opencode" else "commandcode.ai/docs/resources/pricing-limits"
    )
    return rec


def _new_model(doc: dict, platform: str) -> dict:
    key = doc["key"]
    record = _platform_record(doc, platform)
    root = {
        "key": key,
        "name": doc.get("name") or key,
        "provider": doc.get("provider"),
        "category": doc.get("category"),
    }
    if doc.get("context_size"):
        root["context_size"] = doc["context_size"]
    return {
        **root,
        "platforms": {platform: record},
        "coverage": {"platforms": [platform], "count": 1},
        "capabilities": {
            "multimodal": sorted(record.get("multimodal") or ["text"]),
            "protocols": sorted(record.get("protocols") or []),
            "platform_count": 1,
        },
        "sources": [record["source"]],
    }


def _merge_into(model: dict, doc: dict, platform: str) -> dict:
    platforms = dict(model.get("platforms") or {})
    old = platforms.get(platform) or {}
    # Preserve the stored real id unless the doc gives a *new* one (kept for
    # id drift, e.g. claude-haiku-4-5 -> claude-haiku-4-5-20251001).
    rec = {**old}
    rec["id"] = doc["id"]
    for field, val in (
        ("pricing", doc.get("pricing")),
        ("allowance", doc.get("allowance")),
        ("discount", doc.get("discount")),
        ("notes", doc.get("notes")),
    ):
        if val is not None:
            if field == "pricing":
                merged_pricing = {**old.get("pricing", {}), "currency": "USD"}
                merged_pricing.update(val)
                rec["pricing"] = merged_pricing
            else:
                rec[field] = val
    if doc.get("context_size"):
        rec["context_size"] = doc["context_size"]
    if "multimodal" in doc and doc["multimodal"]:
        cur = set(rec.get("multimodal") or [])
        cur.update(doc["multimodal"])
        rec["multimodal"] = sorted(cur)
    if "protocols" in doc and doc["protocols"]:
        cur = set(rec.get("protocols") or [])
        cur.update(doc["protocols"])
        rec["protocols"] = sorted(cur)
    elif platform == "cmdc" and not rec.get("protocols"):
        rec["protocols"] = _cc_protocol(doc.get("provider") or model.get("provider"), doc.get("name") or model.get("name"))
    if "deprecated" in doc:
        rec["deprecated"] = bool(doc["deprecated"])
    rec["source"] = "opencode.ai/docs/zh-cn/go" if platform == "opencode" else "commandcode.ai/docs/resources/pricing-limits"
    platforms[platform] = rec

    model = dict(model)
    model["platforms"] = platforms
    # root shared fields, only filled when absent
    for f in ("name", "provider", "category"):
        if not model.get(f) and doc.get(f):
            model[f] = doc[f]
    if doc.get("context_size") and not model.get("context_size"):
        model["context_size"] = doc["context_size"]
    return model


def _finalize(model: dict) -> dict:
    platforms = {p: r for p, r in (model.get("platforms") or {}).items() if r and r.get("id")}
    keys = sorted(platforms)
    model["platforms"] = platforms
    model["coverage"] = {"platforms": keys, "count": len(keys)}
    mm, protos, sources = set(), set(), []
    for p in keys:
        rec = platforms[p]
        mm.update(rec.get("multimodal") or [])
        protos.update(rec.get("protocols") or [])
        if rec.get("source"):
            sources.append(rec["source"])
    model["capabilities"] = {
        "multimodal": sorted(mm),
        "protocols": sorted(protos),
        "platform_count": len(keys),
    }
    model["sources"] = sources or model.get("sources", [])
    return model


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("llm_json", help="path to LLM-produced model JSON")
    parser.add_argument("--write", action="store_true", help="commit (default: dry run)")
    args = parser.parse_args()

    docs = json.loads(Path(args.llm_json).read_text(encoding="utf-8"))
    if isinstance(docs, dict):
        docs = docs.get("models", [])
    if not isinstance(docs, list):
        print("input JSON must be a list of model records (or {models:[...]})", file=sys.stderr)
        return 1

    merged = json.loads(MERGED_PATH.read_text(encoding="utf-8"))
    models = merged["models"]
    by_key = {norm(k): k for k in models}
    by_platform_id = {}
    for key, model in models.items():
        for p, rec in (model.get("platforms") or {}).items():
            if rec and rec.get("id"):
                by_platform_id[(p, norm(rec["id"]))] = key

    actions = []
    for doc in docs:
        platform = doc.get("platform")
        if platform not in ("opencode", "cmdc"):
            actions.append(f"skip: unknown platform {platform!r} for {doc.get('id')}")
            continue
        key = doc.get("key")
        # resolve existing model: by key or by any platform record with this id
        target = by_key.get(norm(key)) if key else None
        if not target:
            target = by_platform_id.get((platform, norm(doc["id"])))
        if target:
            models[target] = _finalize(_merge_into(models[target], doc, platform))
            actions.append(f"update: {target}.{platform} <- {doc['id']}")
        else:
            if not key:
                bare = doc["id"].split("/")[-1]
                key = re.sub(r"[^a-z0-9]+", "-", bare.lower()).strip("-")
                doc["key"] = key
            # avoid clobbering an existing model with a slightly different key
            key_n = norm(key)
            if key_n in by_key:
                models[by_key[key_n]] = _finalize(_merge_into(models[by_key[key_n]], doc, platform))
                actions.append(f"update: {by_key[key_n]}.{platform} <- {doc['id']} (key-normalized)")
            else:
                models[key] = _finalize(_new_model(doc, platform))
                by_key[key_n] = key
                actions.append(f"add: new model {key} [{platform}]")

    print("\n".join(actions))
    print(f"models: {len(models)} total after merge")

    if not args.write:
        print("(dry run — pass --write to commit; backup is taken first)")
        return 0

    backup = BACKUP_DIR / f"models.merged.{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.json"
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(MERGED_PATH, backup)
    print(f"backup -> {backup}")

    merged["models"] = dict(sorted(models.items()))
    meta = merged.setdefault("meta", {})
    meta["last_synced_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    meta.setdefault("aggregation", {})["merged_models"] = len(models)
    meta.setdefault("aggregation", {})["total"] = len(models)
    dump_json(MERGED_PATH, merged)
    print(f"wrote {MERGED_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
