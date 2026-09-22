# 浏览器检查记录

- 首页可以看到 `性价比对比` 导航、`API Key 设置` 按钮、`导出聚合 JSON` 按钮。
- 模型列表中的每一行都包含 `测试` 入口；模型行仍然可点击打开详情。
- API Key 设置弹窗可见两个输入项：OpenCode Go Key 与 CommandCode Key，并提供显示/隐藏、保存、取消操作。
- `/compare` 首屏可以加载，展示“25 个双平台模型”、价格公式说明和按 OC/CC 分组的对比表。
- 移动端 `/compare` 公式区会堆叠，表格使用横向滚动容器。

补充检查：通过页面 DOM 验证首页存在 66 个测试入口；打开首条模型测试弹窗后，实际看到 OpenCode Go / CommandCode 平台切换和 Chat / Responses / Messages 协议按钮。API Key 弹窗也已实际打开并显示两个 Key 输入框。未发送真实请求，因为当前浏览器未设置用户 API Key。
