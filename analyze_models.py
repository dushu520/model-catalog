import json
from collections import Counter, defaultdict
from pathlib import Path

source = Path('/home/ubuntu/upload/models.json')
data = json.loads(source.read_text())
models = data['models']
by_platform = defaultdict(list)
for row in models:
    by_platform[row['platform']].append(row)

print('meta.total:', data.get('meta', {}).get('total'))
print('raw_count:', len(models))
for platform, rows in by_platform.items():
    print(platform, len(rows), 'unique_ids', len({r['id'] for r in rows}))
    print(' keys:', sorted({key for row in rows for key in row.keys()}))

ids = {platform: {r['id'] for r in rows} for platform, rows in by_platform.items()}
print('intersection_exact_id:', len(ids['opencode'] & ids['cmdc']))
print('union_exact_id:', len(ids['opencode'] | ids['cmdc']))
print('exact_intersection:', sorted(ids['opencode'] & ids['cmdc']))

# Candidate identity keys: normalized id and normalized provider/name pairs.
def norm(value):
    return ''.join(ch.lower() for ch in str(value) if ch.isalnum())

groups = defaultdict(list)
for row in models:
    groups[norm(row['id'])].append(row)
print('normalized_id_groups:', len(groups))
print('normalized_id_collisions:', [(key, [(r['platform'], r['id']) for r in rows]) for key, rows in groups.items() if len(rows) > 1][:20])

name_groups = defaultdict(list)
for row in models:
    name_groups[norm(row.get('name', ''))].append(row)
print('normalized_name_groups_with_cross_platform:', [(key, [(r['platform'], r['id']) for r in rows]) for key, rows in name_groups.items() if len({r['platform'] for r in rows}) > 1][:50])

print('categories:', Counter(r.get('category') for r in models))
print('providers:', Counter(r.get('provider') for r in models))
print('protocols:', Counter(protocol for r in models for protocol in r.get('protocols', [])))
print('multimodal:', Counter(mode for r in models for mode in r.get('multimodal', [])))

# Print all IDs grouped by platform for identity matching review.
for platform, rows in by_platform.items():
    print('\n', platform)
    for r in rows:
        print(r['id'], '|', r.get('name'), '|', r.get('provider'))
