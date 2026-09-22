---
name: model-catalog-sync
description: >-
  同步 Model Catalog 的模型数据。当用户提到「更新模型/同步模型数据/和官方对比模型清单/
  模型该加的加该删的删/刷新模型价格和额度/检查新增模型」等需求时使用本技能。流程为：
  调用两个官方 model-list API 拿到最新模型清单 → 与项目当前模型数据对比找出新增/消失 →
  把官方文档页面交给 LLM 阅读、由 LLM 输出新增模型的参数 JSON → 合并回项目唯一的模型
  数据文件 client/src/data/models.merged.json（只动模型相关，不改 UI/server 其他代码）。
  适用于 model-catalog 项目（.agents/skills/model-catalog-sync/ 的上一级）。
---

# Model Catalog 模型同步

把两平台官方模型数据同步进 `client/src/data/models.merged.json`：

| 平台 | model-list API | 官方文档页 |
| --- | --- | --- |
| OpenCode Go | `https://opencode.ai/zen/go/v1/models` | https://opencode.ai/docs/zh-cn/go |
| CommandCode | `https://api.commandcode.ai/provider/v1/models` | https://commandcode.ai/docs/resources/pricing-limits |

## 设计原则

1. **不自己解析 HTML。** 模型的「参数」由 LLM 阅读官方页面后以 JSON 返回；脚本只做三件事：
   拉清单、对比清单、把 LLM 的 JSON 合并进数据。
2. **只改模型相关。** 唯一被写入的文件是 `client/src/data/models.merged.json`（写前自动备份）。
   不碰 server/UI/构建配置。
3. **key 是身份枢纽。** merged 数据里每个模型 `key` = 去厂商前缀的规范化 id；
   opencode 平台 id 就是 key；cmdc 完整 id 去前缀后经 `norm()`（去大小写/`-._`）也与 key 对齐。
   因此对比只需归一化，不需要厂商前缀表。
4. **新增模型的 id 以 API 返回的真实调用 id 为准**（含厂商前缀），不要再猜前缀。
5. **无官方值的字段不臆造、不置空。** 合并时只写 LLM JSON 里出现的字段，其余沿用现有值。

## 环境与密钥

- 仅 Python 3 标准库。脚本目录 `scripts/`。
- API key 不写入 skill 或仓库。首次运行前创建 `.sync-tmp/api_keys.env`（已 gitignore）：
  ```
  OPENCODE_API_KEY=sk-...
  CC_KEY=user_...
  ```
  CommandCode `/provider/v1/models` 匿名也可访问，无 key 时自动匿名请求。
- 若用本机 server 做对比（可选）：先 `pnpm dev` 或 `pnpm build && pnpm start`，监听 3006；
  提供 `GET /api/models/list`，返回每平台 `[{id,name}]`（id 为真实调用 id）。

## 工作流

在项目根执行：

```bash
# 1) 拉两个官方 model-list API → .sync-tmp/api_lists.json（带缓存，--refresh 强制重下）
python3 .agents/skills/model-catalog-sync/scripts/fetch_api_lists.py --refresh

# 2) 与本地模型数据对比 → 控制台 + .sync-diff/<ts>/compare.json
python3 .agents/skills/model-catalog-sync/scripts/compare.py
#    （或对比运行中的 server：python3 .../compare.py --server http://localhost:3006）
```

compare 输出三类：
- **added**：API 有、本地没有 → 本次要新增，需要取参数
- **missing**：本地有、API 没有 → 疑似下线，**人工复核后再决定删不删**（不要自动删）
- **kept**：两边一致

### 3) 让 LLM 从官方页面提取新增模型参数（关键步骤，不要自己解析页面）

对 compare 报告里每个 `added` 模型，向 LLM 提供官方页面内容并索取结构化 JSON。
做法（任选其一，推荐按顺序）：
1. 用 firecrawl 抓取官方页 markdown 给 LLM 读（已实测 OC 页 markdown 数据完整）：
   ```bash
   curl -sS -X POST https://api.firecrawl.dev/v2/scrape \
     -H 'Authorization: Bearer fc-...' -H 'Content-Type: application/json' \
     -d '{"url":"<官方页 URL>","formats":["markdown"],"onlyMainContent":true}'
   ```
2. 或直接把两个官方文档 URL 交给 LLM，让它访问并阅读（LLM 自己有联网抓取能力时）。
3. CC 页面正文不含 per-plan 美元额度（如 MiniMax M3 Pro $57）：LLM 拿不到就**省略该字段**，
   apply 时会沿用旧值或留空，不要编造。

LLM 必须严格按下面的 schema 输出 JSON 数组（每个记录 = 一个平台侧），字段缺省即"官方页面未提供"：

```json
[
  {
    "platform": "cmdc",
    "key": "gemini-3.8-flash",
    "id": "google/gemini-3.8-flash",
    "name": "Gemini 3.8 Flash",
    "provider": "Google",
    "category": "opensource",
    "context_size": 1000000,
    "pricing": {
      "input": 1.5, "output": 7.5, "cache_read": 0.15,
      "cache_write": null,
      "tiers": [ { "label": null, "context": null, "input": 1.5, "output": 7.5, "cache_read": 0.15, "cache_write": null } ]
    },
    "allowance": { "monthly_usd": 50, "plan_allowance": { "goat": 40, "pro": 50 } },
    "notes": "Available on GOAT and above."
  }
]
```

要求 LLM：
- `id` **必须等于** fetch_api_lists 输出（api_lists.json）里的 id；`key` = id 去厂商前缀后的规范小写横线形
  （如 `google/gemini-3.8-flash` → key `gemini-3.8-flash`）。
- 若某模型同时在两平台新增，则给两条记录（同 key、不同 platform）。
- 价格单位一律 USD / 每 1M token；有分档(tier/峰谷)就放 `pricing.tiers`。
- 无把握的字段宁可省略，**不要编**。

把 LLM 输出保存为 `.sync-tmp/llm_new_models.json`。

### 4) 合并进数据文件

```bash
python3 .agents/skills/model-catalog-sync/scripts/apply_json.py .sync-tmp/llm_new_models.json            # dry run
python3 .agents/skills/model-catalog-sync/scripts/apply_json.py .sync-tmp/llm_new_models.json --write    # 备份后写入
```

### 5) 校验 + 报告

```bash
cd model-catalog && pnpm check && pnpm build
```

向用户输出中文摘要：新增了哪些模型（含平台、价格/额度要点）、missing 里哪些疑似下线待确认、
字段沿用/缺失的说明。missing 的删除要等用户确认后，用 apply_json 里更新或手动编辑数据完成，
skill 本身不自动删。

## 注意事项 / 排错

- **不要删 missing 模型**：API 暂缺 ≠ 下线（定价页仍在列的 claude-opus-4-6 等属此类）。
  删除标准 = 官方文档与 API 都不再列出，且用户确认。
- LLM 返回的 `id` 若不在 api_lists.json 中，apply 会提示/需人工核对；宁可多问一次也不要写错 id。
- compare 显示某平台 added 数为 0 时，不需要执行第 3/4 步。
- firecrawl 或官方 API 结构变化导致失败时，把报错给用户并人工核对页面，脚本不做脆弱的解析兜底。
