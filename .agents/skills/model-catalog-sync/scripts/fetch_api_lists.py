"""Fetch the two official model-list APIs and cache the canonical id list.

Outputs .sync-tmp/api_lists.json:
  { "opencode": [ {id, name?} ], "cmdc": [ {id, name, context_length?} ] }

API keys are read from .sync-tmp/api_keys.env (lines KEY=value); the env var
names each platform accepts are listed in common.API_ENDPOINTS. A key is
optional when the endpoint is publicly reachable (CommandCode /provider/v1/models
responds without auth), but recommended.

Usage: python3 fetch_api_lists.py [--refresh]
"""
import argparse
import json
import sys
import urllib.request

from common import API_ENDPOINTS, API_LISTS_PATH, SYNC_DIR, dump_json, load_env

UA = "model-catalog-sync/2.0"


def _http_json(url: str, headers: dict | None = None, timeout: int = 60):
    req = urllib.request.Request(url, headers=headers or {"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _platform_list(platform: str, env: dict, refresh: bool):
    cache = None
    if API_LISTS_PATH.exists() and not refresh:
        cache = json.loads(API_LISTS_PATH.read_text(encoding="utf-8"))
        if platform in cache:
            print(f"  {platform}: using cached api_lists.json (--refresh to re-fetch)")
            return cache[platform]
    url, env_names = API_ENDPOINTS[platform]
    headers = {"User-Agent": UA, "Accept": "application/json"}
    for name in env_names:
        if env.get(name):
            headers["Authorization"] = f"Bearer {env[name]}"
            break
    body = _http_json(url, headers)
    items = body.get("data") or []
    out = []
    for it in items:
        rec = {"id": it["id"]}
        if it.get("name"):
            rec["name"] = it["name"]
        if it.get("context_length"):
            rec["context_length"] = it["context_length"]
        out.append(rec)
    print(f"  {platform}: {len(out)} models from {url}")
    return out


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--refresh", action="store_true", help="force re-fetch even if cached")
    args = parser.parse_args()

    SYNC_DIR.mkdir(parents=True, exist_ok=True)
    env = load_env()
    if not env:
        print("  note: no .sync-tmp/api_keys.env found; falling back to anonymous requests")

    lists = {}
    for platform in ("opencode", "cmdc"):
        try:
            lists[platform] = _platform_list(platform, env, args.refresh)
        except Exception as exc:  # noqa: BLE001
            print(f"  FAILED {platform}: {exc}", file=sys.stderr)
            return 1

    dump_json(API_LISTS_PATH, lists)
    print(f"wrote {API_LISTS_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
