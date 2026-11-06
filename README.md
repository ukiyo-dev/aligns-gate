# aligns-gate

受 DeepSeek Harness 团队近期公开的 [《Super-agent 设计探索》](https://github.com/deepseek-ai/dsh-superagent-prototype) 启发而写的 OpenCode 插件。

DeepSeek 在那篇实验里点破了一个很扎心的工程事实：**现在的模型单兵干活能力已经够强了，真正的瓶颈是人的注意力**。而在传统“单 Session + Subagent 工具”模式下，靠提示词约束主模型往往有三个通病：

1. **Router 越界当 Worker**：在中性提示下，主控模型经常嫌派发麻烦，不调 Subagent 而是自己下场改代码，几轮下来主会话上下文全被实现细节污染。
2. **Worker 交卷糊弄，Router 盲目采信**：`@designer` 或 `@fixer` 跑完回来说“已全部完成”，主控不看实机截图、不跑测试就直接转告用户，最后还得人肉当监工。
3. **审稿载荷撑爆 Router 上下文**：把验收规则常驻在系统提示里浪费 Token；而主控审稿时截的几张页面大图一旦留在历史消息里，两三轮下来上下文就满了。

`aligns-gate` 把 Super-agent 里的 **Router/Worker 职责硬隔离**、**事件驱动验收（Trigger）** 和 **后台巡检（Watchdog）** 落成了几条轻量的运行期钩子：只要项目根目录放一个 `ALIGNS.md`，重活和返工留在子会话，主控只管对齐人类意图与架构巡检。

## 工作机制

### 1. 第一棒：`◈ aligns-gate: 人类意图对齐`（事件驱动审稿 + 审完即焚）
不需要在全局 Prompt 里常驻长篇大论。插件监听子任务回归事件：只有当 `@designer` 或 `@fixer` 刚干完活回到主会话时，才打开**审稿窗口**，按角色截取 `ALIGNS.md` 中对应的段落（通用规则 + `## @designer` 或 `## @fixer`）注入给主控。

主控在窗口期内完成截图核验或跑通测试后（或带原 `sessionID` 打回 Worker 返工，单轮最多触发 2 次），一旦进入下一轮或继续派发，注入的 `ALIGNS.md` 自动从历史消息中无痕剥离。

### 2. 审稿窗口自动脱水（保持 Router 上下文干净）
Router 的上下文应该留给全局调度，而不是存满历史截图。一旦审稿窗口关闭，该窗口期内产生的多模态图片附件和超长工具输出（>180 字符）会被自动脱水为 `[Audit result cleared after review]`——只留调度轨迹与结论，清掉一次性审稿载荷。

### 3. 第二棒：`◈ aligns-gate: 巨石文件拆分`（空闲态 Watchdog 巡检）
借鉴后台投机巡检的思路：当第一棒业务审稿正常收尾、主会话进入 `idle` 且后台没有挂起任务时，插件会扫一遍仓库源码（跳过 `node_modules`、`dist`、测试文件等）。如果发现有超过 500 行的巨石文件，会自动发一条合成消息唤醒主控，让它派 `@fixer` 把最大的那个文件按职责拆到 500 行以内（每轮对话最多触发一次）。

### 4. 主控 `[审慎写入确认]`（守住 Router / Worker 边界）
主控（`orchestrator`）直接对业务源码调 `edit` / `write` / `patch` 时，第一次会被直接拦下，并附上刚才的 `@designer` / `@fixer` 热会话 `sessionID` 提醒它派发给 Worker。如果主控判断确实只是改两行字的小修补，对同一个文件再调一次就会放行，放行后立即恢复拦截态（修改 `README.md`、`ALIGNS.md`、`package.json` 等文档配置不拦截）。

### 5. 跨实例重复 `<task>` 通知去重
多工作区实例同时挂载或前台复用后台 `sessionID` 时，如果底层重复投递了同一个子会话的 `<task state="completed">`，插件会在入队层和上下文层双重拦截折叠，防止 Router 被重复唤醒、陷入重跑截图的死循环。

## 安装

在 `~/.config/opencode/opencode.json`（或项目级 `opencode.json`）里加上：

```json
{
  "plugin": [
    "oh-my-opencode-slim",
    "aligns-gate"
  ]
}
```

如果是本地 clone 下来用，直接填目录绝对路径即可：

```json
{
  "plugin": [
    "oh-my-opencode-slim",
    "/path/to/aligns-gate"
  ]
}
```

## 在项目里放一份 `ALIGNS.md`

插件向上查找项目根目录下的 `ALIGNS.md`（没有这个文件时不会触发审稿和拆文件）。可以直接参考 [`examples/ALIGNS.example.md`](./examples/ALIGNS.example.md)：

```markdown
<!-- aligns-gate: max_lines=500, max_windows=2, auto_split=true, router_guard=true -->
# ALIGNS.md

当前处于子任务回归后的审稿窗口。不要直接采信子任务的文字总结，先核验实际产物：

## @designer
1. 打开浏览器实机截图（桌面端 + 移动端视口），点击主要交互确认状态切换正常。
2. 检查是否有文字溢出、等宽呆板卡片堆砌、悬停/空状态缺失或生硬机翻文案。
3. 不达标直接带原 sessionID 打回 @designer 返工。

## @fixer
1. 跑一遍相关测试、类型检查或构建，看真实退出码和输出。
2. 检查边界条件、错误处理和接口契约有没有破损。
```

## 可选参数

写在 `ALIGNS.md` 第一行的注释里即可（送入模型前会自动剥离，不占 Token），也可以用环境变量覆盖：

- `max_lines`（环境变量 `ALIGNS_GATE_MAX_LINES`，默认 `500`）：超过多少行触发拆文件
- `max_windows`（环境变量 `ALIGNS_GATE_MAX_WINDOWS`，默认 `2`）：单轮最多激活几次审稿窗口
- `auto_split`（环境变量 `ALIGNS_GATE_AUTO_SPLIT`，默认 `true`）：审稿结束后是否自动扫描并触发拆文件
- `router_guard`（环境变量 `ALIGNS_GATE_ROUTER_GUARD`，默认 `true`）：是否拦截主控直接改业务源码

## 测试

```bash
npm test
```

## License

MIT
