import copy
import json
import re
from collections import OrderedDict
from pathlib import Path

SOURCE = Path('/home/ubuntu/upload/models.json')
TARGET = Path('/home/ubuntu/model-catalog/client/src/data/models.merged.json')
TARGET.parent.mkdir(parents=True, exist_ok=True)

raw = json.loads(SOURCE.read_text())

# Keep identity matching deterministic. Removing punctuation covers most provider ID variations;
# these aliases cover provider-prefixed IDs whose canonical identity is visible in the model name.
ALIASES = {
    'tencent/hy4-preview': 'hy4-preview',
    'tencent/hy3-paid': 'hy3',
}

# CommandCode exposes provider-prefixed IDs. Keep the complete ID in the platform record,
# while mapping it back to the shared model identity for cross-platform aggregation.
CC_ID_OVERRIDES = {
    'deepseek-v4-pro': 'deepseek/deepseek-v4-pro',
    'deepseek-v4-flash': 'deepseek/deepseek-v4-flash',
    'deepseek-v4-flash-vision-exp': 'deepseek/deepseek-v4-flash-vision-exp',
    'deepseek-v4-flash-fast': 'deepseek/deepseek-v4-flash-fast',
    'kimi-k3': 'moonshotai/kimi-k3',
    'kimi-k2.7-code': 'moonshotai/kimi-k2.7-code',
    'kimi-k2.7-code-highspeed': 'moonshotai/kimi-k2.7-code-highspeed',
    'kimi-k2.6': 'moonshotai/kimi-k2.6',
    'kimi-k2.5': 'moonshotai/kimi-k2.5',
    'glm-5.3-flash': 'z-ai/glm-5.3-flash',
    'glm-5.3': 'zai-org/glm-5.3',
    'glm-5.2': 'zai-org/glm-5.2',
    'glm-5.2-fast': 'zai-org/glm-5.2-fast',
    'glm-5.1': 'zai-org/glm-5.1',
    'glm-5': 'zai-org/glm-5',
    'minimax-m3': 'minimaxai/minimax-m3',
    'minimax-m2.7': 'minimaxai/minimax-m2.7',
    'minimax-m2.5': 'minimaxai/minimax-m2.5',
    'mimo-v2.5-pro': 'xiaomi/mimo-v2.5-pro',
    'mimo-v2.5': 'xiaomi/mimo-v2.5',
    'qwen-3.8-max': 'qwen/qwen3.8-max',
    'qwen-3.8-27b': 'qwen/qwen3.8-27b',
    'qwen-3.8-flash': 'qwen/qwen3.8-flash',
    'qwen-3.7-max': 'qwen/qwen3.7-max',
    'qwen-3.7-plus': 'qwen/qwen3.7-plus',
    'qwen-3.7-flash': 'qwen/qwen3.7-flash',
    'qwen-3.6-max': 'qwen/qwen3.6-max-preview',
    'qwen-3.6-plus': 'qwen/qwen3.6-plus',
    'step-3.7-flash': 'stepfun/step-3.7-flash',
    'step-3.5-flash': 'stepfun/step-3.5-flash',
    'hy3': 'tencent/hy3-paid',
    'hy4-preview': 'tencent/hy4-preview',
    'nemotron-3-ultra': 'nvidia/nemotron-3-ultra-550b-a55b',
    'inkling': 'thinkingmachines/inkling',
    'inkling-small': 'thinkingmachines/inkling-small',
    'laguna-s-2.1-free': 'poolside/laguna-s-2.1-free',
    'gemini-3.7-flash': 'google/gemini-3.7-flash',
    'gemini-3.6-flash': 'google/gemini-3.6-flash',
    'gemini-3.5-flash': 'google/gemini-3.5-flash',
    'gemini-3.5-flash-lite': 'google/gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite': 'google/gemini-3.1-flash-lite',
    'fugu-ultra': 'sakana/fugu-ultra',
    'muse-spark-1.1': 'meta/muse-spark-1.1',
    'muse-spark-1.2': 'meta/muse-spark-1.2',
    'muse-spark-1.2-contributor': 'meta/muse-spark-1.2-contributor',
    'grok-4.5': 'xai/grok-4.5',
    'grok-4.6': 'xai/grok-4.6',
}

CC_CANONICAL_BY_FULL = {full: old for old, full in CC_ID_OVERRIDES.items()}

def normalize(value: str) -> str:
    return re.sub(r'[^a-z0-9]', '', value.lower())

def canonical_key(row: dict) -> str:
    raw_id = row['id']
    if row.get('platform') == 'cmdc' and raw_id in CC_CANONICAL_BY_FULL:
        return CC_CANONICAL_BY_FULL[raw_id]
    if raw_id in ALIASES:
        return ALIASES[raw_id]
    normalized = normalize(raw_id)
    # Prefer a readable canonical spelling from the OpenCode side when available.
    for candidate in ('qwen-3.8-max', 'qwen-3.8-flash', 'qwen-3.7-max', 'qwen-3.7-plus', 'qwen-3.6-plus'):
        if normalize(candidate) == normalized:
            return candidate
    return raw_id

platforms = raw['meta']['platforms']
groups = OrderedDict()
for row in raw['models']:
    normalized_row = copy.deepcopy(row)
    if normalized_row.get('platform') == 'cmdc':
        normalized_row['id'] = CC_ID_OVERRIDES.get(normalized_row['id'], normalized_row['id'])
    key = canonical_key(normalized_row)
    groups.setdefault(key, []).append(normalized_row)

shared_fields = ('name', 'provider', 'category', 'reasoning', 'tool_use', 'open_weights', 'context_size', 'max_output', 'release_date', 'updated_at')
merged_models = OrderedDict()
for key, rows in groups.items():
    preferred = next((row for row in rows if row['platform'] == 'opencode'), rows[0])
    shared = {'key': key}
    for field in shared_fields:
        values = [row.get(field) for row in rows if row.get(field) is not None]
        if not values:
            shared[field] = None
        elif all(value == values[0] for value in values[1:]):
            shared[field] = values[0]
        else:
            # Preserve disagreement without hiding it; the UI surfaces platform-specific values.
            shared[field] = values[0]
            shared[f'{field}_by_platform'] = {row['platform']: row.get(field) for row in rows}

    merged_models[key] = {
        **shared,
        'platforms': {},
        'coverage': {
            'platforms': [row['platform'] for row in rows],
            'count': len(rows),
        },
    }

    union_multimodal = set()
    union_protocols = set()
    for row in rows:
        union_multimodal.update(row.get('multimodal', []))
        union_protocols.update(row.get('protocols', []))
        platform = row['platform']
        platform_copy = copy.deepcopy(row)
        platform_copy.pop('platform', None)
        platform_copy.pop('name', None)
        platform_copy.pop('provider', None)
        platform_copy.pop('category', None)
        for field in shared_fields:
            platform_copy.pop(field, None)
        merged_models[key]['platforms'][platform] = platform_copy

    merged_models[key]['capabilities'] = {
        'multimodal': sorted(union_multimodal),
        'protocols': sorted(union_protocols),
        'platform_count': len(rows),
    }

    # Preserve stable ordering: common OpenCode models first, then CommandCode-only additions.
    merged_models[key]['sources'] = [row.get('source') for row in rows if row.get('source')]

result = {
    'meta': {
        **raw['meta'],
        'aggregation': {
            'source_file': 'models.json',
            'raw_records': len(raw['models']),
            'merged_models': len(merged_models),
            'matching_strategy': 'normalized platform model id plus explicit provider-prefix aliases',
            'canonical_key_note': 'Shared fields live at model root; platform-specific fields live under platforms.<platform>.',
        },
    },
    'models': merged_models,
}
TARGET.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({
    'raw_records': len(raw['models']),
    'merged_models': len(merged_models),
    'shared_platform_models': sum(1 for model in merged_models.values() if model['coverage']['count'] == 2),
    'opencode_only': sum(1 for model in merged_models.values() if model['coverage']['platforms'] == ['opencode']),
    'cmdc_only': sum(1 for model in merged_models.values() if model['coverage']['platforms'] == ['cmdc']),
}, ensure_ascii=False))
