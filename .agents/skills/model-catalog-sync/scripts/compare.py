"""Compare the cached official API model lists against the local catalog.

Local side is read from client/src/data/models.merged.json directly (no need
for the server to be running). Each local model contributes, per platform, the
stored platform id. Matching is by normalized identity:
    norm(api_id)  ==  norm(local key)        # pivot: merged key is canonical
                  ==  norm(platform_id)
so vendor-prefixed cc ids (deepseek/deepseek-v4-flash) and differently-cased
vendor ids (moonshotai/Kimi-K3) all line up with key kimi-k3 automatically.

Outputs to stdout and .sync-diff/<ts>/compare.json:
  { "opencode": { added:[...], missing:[...], kept:[...] }, "cmdc": {...} }
  - added:   API has it, local does not   -> needs params fetched, then apply
  - missing: local has it, API does not   -> possible removal, review by hand
  - kept:    both sides agree

Usage: python3 compare.py [--server http://localhost:3006]   (server optional)
"""
import argparse
import json
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from common import API_LISTS_PATH, DIFF_DIR, MERGED_PATH, norm


def local_platform_ids() -> dict:
    """{ platform: [ {key, platform_id} ] } from models.merged.json."""
    merged = json.loads(MERGED_PATH.read_text(encoding="utf-8"))
    out = {"opencode": [], "cmdc": []}
    for key, model in merged.get("models", {}).items():
        for platform in ("opencode", "cmdc"):
            rec = (model.get("platforms") or {}).get(platform)
            if rec and rec.get("id"):
                out[platform].append({"key": key, "platform_id": rec["id"]})
    return out


def local_from_server(base: str) -> dict:
    """Optional: read the same list from the running server instead of disk."""
    # The dev machine may export HTTP(S)_PROXY; never route localhost through it.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(base + "/api/models/list", timeout=10) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    out = {"opencode": [], "cmdc": []}
    for platform in ("opencode", "cmdc"):
        for item in payload.get(platform, []):
            out[platform].append({"key": item["id"], "platform_id": item["id"]})
    return out


def compare_platform(api_items: list, local_items: list) -> dict:
    local_by_norm = {}
    for item in local_items:
        local_by_norm[norm(item["platform_id"])] = item
        local_by_norm[norm(item["key"])] = item
    added, kept, missing = [], [], []
    seen = set()
    for api in api_items:
        key = local_by_norm.get(norm(api["id"]))
        if key:
            seen.add(norm(key["platform_id"]))
            kept.append({"id": api["id"], "key": key["key"]})
        else:
            added.append({"id": api["id"], "name": api.get("name")})
    # local records with no API counterpart
    api_norms = {norm(a["id"]) for a in api_items}
    for item in local_items:
        if norm(item["platform_id"]) not in api_norms and norm(item["key"]) not in api_norms:
            missing.append({"key": item["key"], "platform_id": item["platform_id"]})
    return {"added": added, "missing": missing, "kept": kept}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--server", default=None, help="optional base URL of running model-catalog server")
    parser.add_argument("--out", default=None)
    args = parser.parse_args()

    if not API_LISTS_PATH.exists():
        print("no .sync-tmp/api_lists.json — run fetch_api_lists.py first", file=sys.stderr)
        return 1

    api_lists = json.loads(API_LISTS_PATH.read_text(encoding="utf-8"))
    local = local_from_server(args.server) if args.server else local_platform_ids()

    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "note": "added = API 有但本地没有（需取参数后 apply）；missing = 本地有但 API 没有（人工复核，不自动删）",
    }
    for platform in ("opencode", "cmdc"):
        report[platform] = compare_platform(api_lists.get(platform, []), local[platform])
        c = report[platform]
        print(f"== {platform}: added {len(c['added'])}  missing {len(c['missing'])}  kept {len(c['kept'])}")
        for a in c["added"]:
            print(f"   + {a['id']}")
        for m in c["missing"]:
            print(f"   - {m['key']} ({m['platform_id']})")

    out_path = Path(args.out) if args.out else DIFF_DIR / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") / "compare.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"report -> {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
