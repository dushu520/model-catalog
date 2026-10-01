"""Extract exact model pricing & configuration from official docs JSON streams.

For CommandCode (https://commandcode.ai/docs/plans/goat or pricing-limits):
Next.js RSC embeds the complete models catalog JSON directly in `self.__next_f.push`.
This script downloads the page, decodes the stream, parses full tiered pricing,
context window, time-of-day peak/off-peak rates, promotional deals, and formats
them ready for apply_json.py.

Usage:
    python3 fetch_doc_data.py --platform cmdc [--out .sync-tmp/cmdc_doc_models.json]
    python3 fetch_doc_data.py --platform all
"""
import argparse
import json
import re
import sys
import urllib.request
from pathlib import Path

from common import SYNC_DIR, dump_json, norm


def fetch_cmdc_doc_models() -> list:
    """Fetch and extract CommandCode full model data from Next.js RSC payload."""
    url = "https://commandcode.ai/docs/plans/goat"
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        html = resp.read().decode("utf-8")

    # Decode Next.js RSC chunks
    regex = re.compile(r'self\.__next_f\.push\(\[1,\s*"(.*?)"\]\)', re.DOTALL)
    payload = ""
    for match in regex.finditer(html):
        try:
            payload += json.loads('"' + match.group(1) + '"')
        except Exception:
            pass

    idx = payload.find('"models":[')
    if idx == -1:
        raise ValueError("Could not find 'models':[] array in CommandCode page RSC stream.")

    start_bracket = idx + 9
    depth = 0
    end_bracket = -1
    for i in range(start_bracket, len(payload)):
        if payload[i] == "[":
            depth += 1
        elif payload[i] == "]":
            depth -= 1
            if depth == 0:
                end_bracket = i + 1
                break

    if end_bracket == -1:
        raise ValueError("Malformed models JSON array in CommandCode RSC stream.")

    raw_json = payload[start_bracket:end_bracket].replace('"$undefined"', "null")
    raw_models = json.loads(raw_json)

    extracted = []
    for m in raw_models:
        # Construct model key (strip vendor prefixes like 'openai/', 'google/', etc. or use slug/id)
        raw_id = m.get("id") or m.get("slug")
        bare_key = raw_id.split("/")[-1] if "/" in raw_id else raw_id
        canonical_key = bare_key.lower()

        # Pricing structure
        input_cost = m.get("inputCost") or 0
        output_cost = m.get("outputCost") or 0
        cache_read = m.get("cacheReadCost") or 0
        cache_write = m.get("cacheWriteCost") or 0

        # Tiers & context pricing
        tiers = []
        if m.get("tiers"):
            for t in m["tiers"]:
                rates = t.get("rates") or {}
                tiers.append({
                    "label": t.get("label"),
                    "context": t.get("context"),
                    "input": rates.get("input", input_cost),
                    "output": rates.get("output", output_cost),
                    "cache_read": rates.get("cacheRead", cache_read),
                    "cache_write": rates.get("cacheWrite", cache_write),
                })

        pricing = {
            "input": input_cost,
            "output": output_cost,
            "cache_read": cache_read,
            "cache_write": cache_write,
        }
        if tiers:
            pricing["tiers"] = tiers

        # Time of day (peak / off-peak discounts)
        if m.get("timeOfDay"):
            pricing["time_of_day"] = m["timeOfDay"]

        # Capabilities / Multimodal
        caps = m.get("caps") or {}
        multimodal = ["text"]
        if m.get("vision") or caps.get("vision"):
            multimodal.append("image")

        # Allowance
        # By default GOAT plan includes $70 or $60 base allowance
        monthly_credits = 70.0 if m.get("minPlanName") == "GOAT" else 60.0
        allowance = {
            "monthly_usd": monthly_credits,
            "plan_allowance": {
                "goat": monthly_credits,
            }
        }

        # Notes / Deal
        notes = []
        if m.get("deal") and isinstance(m["deal"], dict):
            notes.append(m["deal"].get("note") or m["deal"].get("label", ""))
        if m.get("minPlanName"):
            notes.append(f"Min plan: {m['minPlanName']}")

        extracted.append({
            "platform": "cmdc",
            "key": canonical_key,
            "id": raw_id,
            "name": m.get("name") or canonical_key,
            "provider": m.get("vendor"),
            "category": m.get("category") or "opensource",
            "context_size": m.get("contextWindow"),
            "multimodal": multimodal,
            "pricing": pricing,
            "allowance": allowance,
            "notes": " · ".join(filter(None, notes)) if notes else None,
            "deprecated": False,
        })

    return extracted


def main() -> int:
    parser = argparse.ArgumentParser(description="Fetch model pricing directly from official docs JSON stream.")
    parser.add_argument("--platform", choices=["cmdc", "all"], default="cmdc")
    parser.add_argument("--out", default=None, help="Output JSON path")
    args = parser.parse_args()

    out_path = Path(args.out) if args.out else (SYNC_DIR / "doc_models_cmdc.json")

    print(f"Fetching {args.platform} models from official documentation stream...")
    if args.platform in ("cmdc", "all"):
        models = fetch_cmdc_doc_models()
        dump_json(out_path, models)
        print(f"✓ Successfully extracted {len(models)} models from CommandCode doc stream to {out_path}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
