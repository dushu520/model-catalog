import json
from pathlib import Path

data = json.loads(Path('/home/ubuntu/model-catalog/client/src/data/models.merged.json').read_text())
for key in ['deepseek-v4-flash', 'grok-4.6', 'claude-sonnet-5', 'qwen-3.8-max']:
    model = data['models'].get(key)
    print('\n', key)
    if not model:
        continue
    for platform, record in model['platforms'].items():
        print(platform, 'id=', record.get('id'))
        print(' pricing=', record.get('pricing'))
        print(' allowance=', record.get('allowance'))
