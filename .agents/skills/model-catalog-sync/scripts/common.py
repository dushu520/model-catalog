"""Shared helpers for the (rewritten, minimal) model-catalog-sync skill.

Only path resolution and the identity normalization that is the merge pivot:
the merged key, the opencode platform id and the bare (prefix-stripped) cmdc
platform id all denote the *same model string* once lower-cased and stripped
of non-alphanumerics. No vendor-prefix table is needed.
"""
import json
import re
from pathlib import Path

# <project>/.agents/skills/model-catalog-sync/scripts
SCRIPTS_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPTS_DIR.parent
PROJECT_ROOT = SKILL_DIR.parents[2]

MERGED_PATH = PROJECT_ROOT / "client" / "src" / "data" / "models.merged.json"
SYNC_DIR = PROJECT_ROOT / ".sync-tmp"
BACKUP_DIR = SYNC_DIR / "backups"
DIFF_DIR = PROJECT_ROOT / ".sync-diff"
API_LISTS_PATH = SYNC_DIR / "api_lists.json"
ENV_PATH = SYNC_DIR / "api_keys.env"

API_ENDPOINTS = {
    # platform key -> (endpoint, list of env var names to try)
    "opencode": ("https://opencode.ai/zen/go/v1/models", ["OPENCODE_API_KEY", "OC_KEY"]),
    "cmdc": ("https://api.commandcode.ai/provider/v1/models", ["CC_KEY", "COMMANDCODE_API_KEY"]),
}


def norm(value: str) -> str:
    """Identity normalization that aligns opencode id / bare cmdc id / merged key."""
    return re.sub(r"[^a-z0-9]", "", value.lower())


def load_merged() -> dict:
    return json.loads(MERGED_PATH.read_text(encoding="utf-8"))


def load_env() -> dict:
    """Read .sync-tmp/api_keys.env if present: lines of KEY=value."""
    if not ENV_PATH.exists():
        return {}
    env = {}
    for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, _, v = line.partition("=")
            env[k.strip()] = v.strip()
    return env


def dump_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
