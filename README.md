# aligns-gate

零外部依赖的 OpenCode 主控审稿门禁与上下文治理插件（同时兼容 OpenCode V1 `experimental.chat.messages.transform` 与 V2 `ctx.session.hook("context")`）。

当项目根目录（或上级 Git 仓库根目录）存在 `ALIGNS.md` 时，`aligns-gate` 会自动激活四大核心机制：

---

## 核心特性

### 1. 第一棒：`◈ aligns-gate: 人类意图对齐`（按角色动态注入 + 无痕剥离）
- **触发时机**：仅当写入型子代理（`@designer` 或 `@fixer`，无论是后台异步回归还是前台同步完成）刚交卷回归时，开启**审稿窗口期**。
- **按角色精准裁剪**：若 `@designer` 回归，自动提取 `ALIGNS.md` 中的通用段落与 `## ... @designer` 专属章节；若 `@fixer` 回归，则提取通用段落与 `## ... @fixer` 专属章节。
- **状态胶丸可见、上下文零污染**：自动在 TUI 界面展示 `◈ aligns-gate: 人类意图对齐` 提示，并在下一轮或审稿窗口关闭（如主控继续派发子代理、调用 `question` 或本轮达审稿上限）时将 `ALIGNS.md` 提醒彻底从历史消息中无痕剥离。

### 2. 审稿窗口自动脱水（Context Dehydration）
- 审稿期主控往往会拍摄多张页面截图（`chrome-devtools`）或读取大量验证输出。
- 一旦当前审稿窗口关闭，`aligns-gate` 会自动将已关闭审稿窗口内的**多模态图片附件**与**超长工具输出（>180 字符）**原地替换为 `[Audit result cleared after review]`，释放主控上下文空间，同时完整保留 `subagent` / `task` / `question` 等核心调度记录。

### 3. 第二棒：`◈ aligns-gate: 巨石文件拆分`（全仓超限源码自动接力）
- 当第一棒人类意图对齐审稿正常收尾、主控进入空闲且后台无挂起子任务时，`aligns-gate` 会快速扫描工作区源码文件（自动跳过 `node_modules`、`dist`、`.git`、测试与声明文件）。
- 若发现超过行数红线（默认 `500` 行）的巨石文件，将在本轮自动发起一次 `◈ aligns-gate: 巨石文件拆分` 合成接力，引导主控派发 `@fixer` 对榜首巨石文件按高内聚职责拆分子模块并跑通验证（每轮用户对话最多触发一次）。

### 4. 主控 `[审慎写入确认]`（一次性重入放行并自动重置）
- 拦截主控（`orchestrator`）直接对业务源码文件调用 `edit` / `write` / `patch` / `apply_patch`（自动放行 `ALIGNS.md`、`README*.md`、`AGENTS.md`、`package.json` 等文档与配置文件）。
- **第 1 次调用**：抛出 `[审慎写入确认]` 提醒，并附带当前热会话 `sessionID` 复用建议；同时为该文件签发一枚一次性放行令牌。
- **第 2 次重试**：若主控确认属于几行以内的极小修补并再次对该文件调用写入工具，自动消费令牌予以放行，并在放行后**立即重置为拦截态**（第 3 次调用将重新触发确认）。

### 5. 内置跨工作区重复 `<task>` 通知去重锁
- 在同一进程挂载多个工作区实例或前台同步复用（`background: false`）后台热会话时，自动拦截并折叠跨实例重复投递的 `<task id="ses_..." state="completed">` 通知，防止主控被重复唤醒或重跑截图审稿。

---

## 安装与启用

在 `~/.config/opencode/opencode.json`（或项目级 `opencode.json`）的 `plugin` 数组中添加：

```json
{
  "plugin": [
    "oh-my-opencode-slim",
    "aligns-gate"
  ]
}
```

（本地开发或直接目录引用可使用绝对路径 `"/path/to/aligns-gate"`。）

随后在你的项目根目录放置一份 `ALIGNS.md`（可参考 [`examples/ALIGNS.example.md`](./examples/ALIGNS.example.md)）。

---

## 轻量配置（可选）

无需修改插件代码，可在项目 `ALIGNS.md` 顶部通过 HTML 注释或 YAML Frontmatter 覆盖默认参数（配置块在注入模型前会自动剥离，不占用 Token）：

```markdown
<!-- aligns-gate: max_lines=500, max_windows=2, auto_split=true, router_guard=true -->
```

或者使用环境变量：

| 配置项 | 环境变量 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `max_lines` | `ALIGNS_GATE_MAX_LINES` | `500` | 触发“巨石文件拆分”的源码单文件行数阈值 |
| `max_windows` | `ALIGNS_GATE_MAX_WINDOWS` | `2` | 单轮用户对话内最多激活审稿窗口的次数 |
| `auto_split` | `ALIGNS_GATE_AUTO_SPLIT` | `true` | 是否在审稿结束后自动扫描并触发巨石文件拆分 |
| `router_guard` | `ALIGNS_GATE_ROUTER_GUARD` | `true` | 是否启用主控直接改业务源码的 `[审慎写入确认]` |

---

## 运行测试

```bash
npm test
```
