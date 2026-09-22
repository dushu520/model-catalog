# Model Catalog 数据与页面说明

本项目将 `/home/ubuntu/upload/models.json` 中的 OpenCode Go 与 CommandCode 平台记录整理为 `client/src/data/models.merged.json`，并由 React 页面直接读取这份静态聚合数据。

## 聚合结果

| 项目 | 数量 |
| --- | ---: |
| 原始平台记录 | 91 |
| OpenCode Go | 26 |
| CommandCode | 65 |
| 聚合后模型身份 | 66 |
| 双平台共同模型 | 25 |
| 仅 OpenCode Go | 1 |
| 仅 CommandCode | 40 |

## 数据结构

每个模型以 canonical key 为对象键。共同字段放在模型根部，平台差异放在 `platforms` 下；其中 CommandCode 的 `id` 是带供应商前缀的完整调用 ID：

```json
{
  "models": {
    "deepseek-v4-flash": {
      "key": "deepseek-v4-flash",
      "name": "DeepSeek V4 Flash",
      "provider": "DeepSeek",
      "category": "opensource",
      "reasoning": true,
      "tool_use": true,
      "context_size": 1000000,
      "max_output": 131072,
      "capabilities": {
        "multimodal": ["text"],
        "protocols": ["chat", "responses"],
        "platform_count": 2
      },
      "coverage": {
        "platforms": ["opencode", "cmdc"],
        "count": 2
      },
      "platforms": {
        "opencode": {
          "id": "deepseek-v4-flash",
          "pricing": {},
          "allowance": {},
          "source": "opencode.ai/docs/zh-cn/go"
        },
        "cmdc": {
          "id": "deepseek/deepseek-v4-flash",
          "pricing": {},
          "allowance": {},
          "source": "commandcode.ai/docs/resources/pricing-limits"
        }
      }
    }
  }
}
```

当两个平台在名称、上下文、更新时间等共享字段上存在差异时，根部保留一个便于列表扫描的默认值，同时生成对应的 `*_by_platform` 字段；平台原始记录仍完整放在 `platforms.opencode` 或 `platforms.cmdc` 中。

## 匹配规则

合并首先对模型身份做确定性归一化，同时把 CommandCode 的完整供应商前缀 ID 映射回共享模型身份；例如 `qwen/qwen3.8-max` 与 OpenCode 的 `qwen3.8-max` 会合并为 `qwen-3.8-max`，但 `platforms.cmdc.id` 始终保留完整的 `qwen/qwen3.8-max`。本次覆盖包括 `deepseek/deepseek-v4-flash`、`moonshotai/kimi-k3`、`zai-org/glm-5.3`、`nvidia/nemotron-3-ultra-550b-a55b` 等用户提供的完整 ID。不会根据相似名称做模糊合并，以避免把不同版本误合并。

## 页面功能

首页提供模型名称、ID、供应商搜索；平台来源、双平台覆盖、模型类型、输入模态与推理能力筛选；按推荐、名称、上下文和更新时间排序；点击模型行打开右侧详情抽屉；详情中展示平台侧 ID、协议、输入输出价格、缓存价格、额度与来源链接；导出按钮可下载当前聚合 JSON。新增 `/compare` 性价比对比页，仅展示两个平台都收录的模型，并按以下口径计算：`价格系数 = 月额度 / 10`，`价格比 = OC 价格系数 / CC 价格系数`，价格比越大表示 OC 相对额度越高。表格列包含模型、两平台输入/输出/缓存读取价格、月额度、价格系数和价格比。

页面还提供 API Key 设置弹窗。OpenCode Go 使用 `OPENCODE_API_KEY`，CommandCode 使用 `CC_KEY`；Key 仅以 JSON 形式保存在当前浏览器的 localStorage，测试请求由浏览器直接发送到平台端点。模型测试弹窗会根据所选平台与模型的 `protocols` 字段显示允许协议，并在 Chat Completions、Messages 或 Responses 之间切换请求格式。由于静态页面无法替代平台的 CORS、权限或额度限制，实际请求失败时会在弹窗中显示 HTTP 错误或网络错误。

页面采用 Editorial Atlas 视觉方向：深石墨背景对应档案室，暖纸张面板承载模型详情，Signal Orange `#F59E0B` 只用于档案签、焦点、计数与主行动入口。

## 服务端 API（server/index.ts）

平台参数统一归一化（`PLATFORM_ALIASES`）：`oc`/`opencode`/`opencode-go` → `opencode`；`cc`/`cc-goat`/`cmdc`/`commandcode` → `cmdc`。无法识别的平台返回空结果或 400。

### GET /api/models

模型目录查询接口，过滤参数均可选：`?platform=oc&model=deepseek-v4-pro`。

- 不带参数返回全部模型；`platform` 无法识别返回空数组；`model` 按 key/name 归一化模糊匹配（忽略 `-_.`、空格与大小写，逗号分隔多值）。
- 带 `platform` 时按平台投影：`platforms` 只保留该平台记录，`*_by_platform` 有独立值则提升为主字段，`coverage` 收敛为仅该平台。

### GET /api/models/list

每平台模型的 id + name 列表：`{"opencode":[{id,name},...], "cmdc":[{id,name},...]}`，id 为各平台真实调用 id。

### GET /api/models/favorite — 收藏模型（dsh 等 agent 配置用）

只输出后端持久化的收藏（`client/src/data/models.favorite.json`，`{favorites:[{platform,key}]}`，按平台侧存，前端点心形图标时经 POST 同步写入），字段压扁。

- 对外平台名：`cmdc` 显示为 **`cc-goat`**；查询时 `platform=cc|cmdc|cc-goat` 均可，`opencode` 保持不变。
- `GET /api/models/favorite?platform=cc-goat` → `{platform:"cc-goat", models:[...]}`；不带 `platform` 返回 `{platforms:{opencode:[...], "cc-goat":[...]}}`。
- 传 `favorites` 参数（JSON 数组 `[{"platform":"cmdc","key":"..."}]` 或 `platform:key,...` 简写）可覆盖文件内容；不传则读后端文件（不再返回全部模型）。
- 每条模型只有 6 个 key：`id`（该平台真实调用 id）、`name`（该平台侧名称，`name_by_platform` 优先）、`contextWindow`、`maxTokens`（平台独立值优先）、`input`（该平台侧 `multimodal`，如 `["text"]`）、`reasoningEfforts`（`off` 恒为 null，其余档位仅输出模型支持的，不支持的不输出 key）。

示例：

```json
{
  "platform": "cc-goat",
  "models": [{
    "id": "deepseek/deepseek-v4-pro",
    "name": "DeepSeek V4 Pro (latest)",
    "contextWindow": 1000000,
    "maxTokens": 384000,
    "input": ["text"],
    "reasoningEfforts": {"off": null, "low": "low", "high": "high", "max": "max"}
  }]
}
```

### GET /api/models/prices — LiteLLM 官方价格表格式输出

把目录价格转成 LiteLLM `model_prices_and_context_window.json` 同构的扁平 map，key 为各平台真实调用 id：`GET /api/models/prices`（全部）或 `?platform=oc|cc`（单平台）。

- 价格换算为 USD/token（数据侧为 USD/1M tokens）；`context` 分档中带 token 阈值的映射为 `input/output_cost_per_token_above_N_tokens`（取基准档为最小 `<=` 阈值档、超限档为最大 `>` 阈值档，Off-Peak/Peak 等无法表达的档位忽略，退回主价格）。
- 缓存价格映射 `cache_read_input_token_cost` / `cache_creation_input_token_cost`；窗口映射 `max_input_tokens` / `max_tokens` / `max_output_tokens`。
- `supports_vision` / `supports_function_calling` / `supports_reasoning` / `supports_prompt_caching` 仅在为真时输出（与 LiteLLM 官方文件一致）；`litellm_provider` 取 provider 小写，`mode` 恒为 `chat`。
- 同一 id 在两个平台都存在时，条目 key 加 `<platform>/` 前缀消歧；无定价或非 USD 的平台记录跳过。

### GET /api/models/favorites · POST /api/models/favorites

后端收藏引用的读取与整体覆盖落盘。POST body 为 `{favorites:[{platform,key}]}`，校验平台合法性、去重后写入 `models.favorite.json`，返回落盘结果。

### 模型维护（/maintenance 页配套）

- `GET /api/maintenance/local` — 当前全量模型数据（写盘后与内存一致，维护页实时拉取）。
- `GET /api/maintenance/live?platform=opencode|cmdc` — 服务端代拉官方 `/models`（前端直连 CORS 失败时的兜底），返回 `{platform,count,items:[{id,name?,context_length?}]}`，Key 取自 `.sync-tmp/api_keys.env`。
- `POST /api/maintenance/apply` — 把 LLM 产出的模型参数 JSON 合并进 `models.merged.json`（只写提供的字段，写前自动备份到 `.sync-tmp/backups/`，成功后同步内存并返回 actions + updated）。
- `POST /api/maintenance/remove` — 删除某模型的一个平台参数（body `{key,platform}`）；无剩余平台则彻底删除整条模型，写前自动备份。
- `POST /api/maintenance/pricing` — 修改某平台记录的价格（body `{key,platform,tierIndex?,input?,output?,cache_read?,cache_write?,monthly_usd?}`）：`tierIndex` 指向 `pricing.tiers[i]`（记录无 tiers 时根级单价即唯一档）；未提供的字段保持原值，显式传 `null` 清空；改第 0 档时同步写回根级主价格以维持 `tiers[0] ≡ pricing` 不变量（首页、对比页与 LiteLLM 导出据此读价）；只触碰 `pricing`/`allowance`，不动 id/协议等，写前自动备份。

## 页面功能（续）

`/maintenance` 模型维护页：双栏（OpenCode Go / CommandCode，默认只显示 CommandCode，可切换）列出模型名、平台侧 ID 与价格；每行可**改价**（弹出编辑器，按档位编辑该平台的输入/输出/缓存读/缓存写单价与月额度）、可隐藏（全局隐藏，首页/对比页同步过滤，可恢复）、可收藏（心形，按平台侧存入我的模型）、点击标题可测试（默认选中当前列平台）。每列「更新模型」拉取官方 `/models` 后弹窗展示新增/移除双 Tab。**新增走后台队列**（`client/src/lib/enrich-queue.ts`）：可单条「新增」或「全部新增」，固定并发 3 条、单条失败不影响其他（失败的提供「重试」），队列活在模块作用域，因此关闭弹窗或切换页面任务仍继续，页头胶囊显示运行/排队/失败数；每个任务由 `deepseek-v4-flash` 读取该模型文档页提取参数后经 `/api/maintenance/apply` 写入。移除逐条删除平台参数。

`/favorites` 我的模型页：展示收藏的平台侧模型卡片（平台徽标、调用 ID、上下文窗口、最大输出、价格、推理档位），支持详情、测试、取消喜爱；收藏存于后端 `models.favorite.json` 并在浏览器 localStorage 缓存。

## 更新数据

如果 `/home/ubuntu/upload/models.json` 被更新，可重新执行：

```bash
cd /home/ubuntu/model-catalog
python3 build_merged_data.py
pnpm check
pnpm build
```
