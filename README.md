# Model Catalog

把 **OpenCode Go** 与 **CommandCode** 两个平台的模型记录聚合为单一数据集，并提供可筛选、可对比、可测试的本地浏览界面。

- 数据源：`client/src/data/models.merged.json`（唯一数据文件，前端直接读取）
- 前端：Vite 7 + React 19 + TypeScript + Tailwind 4 + Radix UI
- 服务端：Express 4（查询、收藏、LiteLLM 价格表、模型维护）
- 包管理：pnpm · 开发端口：`3006`

## 功能

| 页面 | 说明 |
| --- | --- |
| `/` | 模型目录：按名称/ID/供应商搜索，按平台、双平台覆盖、类型、输入模态、推理能力筛选与排序；行点击开详情抽屉；可导出当前聚合 JSON |
| `/compare` | 双平台性价比对比，仅列两平台都收录的模型，按「价格系数 = 月额度 / 10」「价格比 = OC 系数 / CC 系数」计算 |
| `/favorites` | 我的模型（收藏的平台侧模型卡片：平台徽标、调用 ID、上下文、最大输出、价格、推理档位） |
| `/maintenance` | 模型维护：双栏列出各平台模型，支持隐藏/收藏/测试；「更新模型」拉取官方 `/models` 后对比新增与移除并写回数据 |

另提供 API Key 设置弹窗（`OPENCODE_API_KEY` / `CC_KEY`，仅存于浏览器 localStorage）与模型测试弹窗，按模型的 `protocols` 在 Chat Completions / Messages / Responses 间切换请求格式。请求由浏览器直连平台端点，实际结果受平台 CORS、权限与额度限制。

## 快速开始

```bash
pnpm install      # 首次需完整安装依赖

pnpm dev          # 开发服务器（vite --host，端口 3006）
pnpm check        # tsc --noEmit 类型检查
pnpm build        # 构建前端到 dist/public + 打包 server/index.ts 到 dist/index.js
pnpm start        # 生产模式运行 dist/index.js
pnpm format       # prettier --write .
```

## 目录结构

```
model-catalog/
├── client/
│   ├── index.html
│   └── src/
│       ├── App.tsx                # 路由：/ /compare /favorites /maintenance
│       ├── components/            # ModelDrawer、TestDialog、ApiKeyDialog 等
│       ├── pages/                 # Home / Compare / Favorites / Maintenance
│       ├── lib/model-catalog.ts   # 数据契约类型 + 格式化工具
│       └── data/
│           ├── models.merged.json   # 唯一数据源（聚合结果）
│           └── models.favorite.json # 后端持久化收藏
├── server/index.ts                # 全部 HTTP API
├── shared/const.ts
├── .agents/skills/model-catalog-sync/  # 官方数据同步流程（Python 标准库）
├── MODEL_CATALOG.md               # 数据与页面详细说明
└── vite.config.ts                 # 开发/构建配置（root = client）
```

## 数据模型

每个模型以规范化的 **canonical key** 为对象键，共享字段放在模型根部，平台差异放在 `platforms.opencode` / `platforms.cmdc` 下；当两平台在名称、上下文等共享字段上不一致时，根部保留便于列表扫描的默认值，并生成对应的 `*_by_platform`。

CommandCode 的 `id` 是带厂商前缀的完整调用 ID（如 `qwen/qwen3.8-max`），而 `key` 是去前缀后的规范形式（`qwen-3.8-max`）；匹配仅做确定性归一化，不做相似名称的模糊合并。

完整字段契约见 [`client/src/lib/model-catalog.ts`](client/src/lib/model-catalog.ts)，聚合口径与页面说明见 [`MODEL_CATALOG.md`](MODEL_CATALOG.md)。

## API

平台参数统一归一化：`oc` / `opencode` / `opencode-go` → `opencode`；`cc` / `cc-goat` / `cmdc` / `commandcode` → `cmdc`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/models` | 模型目录查询，可选 `?platform=oc&model=deepseek-v4-pro`；带 `platform` 时按平台投影 |
| GET | `/api/models/list` | 每平台 `[{id,name}]` 列表，id 为平台真实调用 id |
| GET | `/api/models/favorite` | 收藏模型（供 dsh 等 agent 配置），cmdc 对外显示为 `cc-goat`；每条仅 `id/name/contextWindow/maxTokens/input/reasoningEfforts` |
| GET | `/api/models/prices` | 输出 LiteLLM `model_prices_and_context_window.json` 同构的扁平价格表，可选 `?platform=oc|cc` |
| GET / POST | `/api/models/favorites` | 收藏引用的读取与整体覆盖落盘 |
| GET | `/api/maintenance/local` | 当前全量模型数据 |
| GET | `/api/maintenance/live` | 服务端代拉官方 `/models`（前端 CORS 失败时的兜底），`?platform=opencode|cmdc` |
| POST | `/api/maintenance/apply` | 将模型参数 JSON 合并进 `models.merged.json`（写前自动备份） |
| POST | `/api/maintenance/remove` | 删除某模型的一个平台参数，无剩余平台则删除整条模型 |
| POST | `/api/maintenance/pricing` | 修改某平台记录的价格（指定档的四项单价 + 月额度），只动 `pricing`/`allowance`，写前自动备份 |

## 同步官方数据

`.agents/skills/model-catalog-sync/` 封装了周期性同步流程：拉取两个官方 model-list API → 与本地数据对比出新增/消失 → 由 LLM 阅读官方文档页输出结构化参数 JSON → 合并回 `models.merged.json`（写前自动备份，只动数据文件）。

```bash
python3 .agents/skills/model-catalog-sync/scripts/fetch_api_lists.py --refresh
python3 .agents/skills/model-catalog-sync/scripts/compare.py
pnpm check && pnpm build
```

API key 写入 `.sync-tmp/api_keys.env`（已 gitignore，不入版本库）。详见 [`SKILL.md`](.agents/skills/model-catalog-sync/SKILL.md)。

## 许可

MIT
