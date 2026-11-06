# aligns-gate

OpenCode 插件。用来解决多 Agent 协作里几个最让人头疼的实际问题：

1. **子 Agent 交卷糊弄，主控盲信口头汇报**：`@designer` 或 `@fixer` 跑完回来说“已全部完成”，主控不看页面截图、不跑测试就直接采信。
2. **审稿规则常驻导致上下文膨胀**：把验收要求写进全局 Prompt 里，平时聊天也占地方；而主控审稿时截的几张大图一旦留在历史消息里，两三轮下来 Token 就爆了。
3. **代码越改越肿、主控手痒自己下场改代码**：跑几轮需求后单文件不知不觉堆到上千行；或者主控嫌派发麻烦，直接自己调 `edit` 改业务源码。

`aligns-gate` 的做法很简单：在项目根目录放一个 `ALIGNS.md`，插件只在 `@designer` / `@fixer` 刚跑完回来的那一刻把对应的验收红线塞给主控，审完即焚，顺手把审稿期的截图和长输出脱水清掉；审稿结束后如果发现仓库里有超过 500 行的源码文件，再自动推一棒让 `@fixer` 去拆文件。

## 它具体做什么

- **第一棒：人类意图对齐（`◈ aligns-gate: 人类意图对齐`）**  
  只有 `@designer` 或 `@fixer` 刚完成任务回归时，才向主控注入 `ALIGNS.md`。如果文件里分了 `## @designer` 和 `## @fixer` 章节，只注入对应角色的部分。单轮对话最多触发 2 次，一旦主控继续派发任务、向用户提问或进入下一轮，注入的规则自动从上下文里剥离。

- **审稿完自动脱水（释放截图与长输出）**  
  审稿窗口关闭后，该窗口期内产生的页面截图附件和超长工具输出（>180 字符）会被替换成 `[Audit result cleared after review]`。保留调度轨迹，清掉一次性审稿载荷。

- **第二棒：巨石文件拆分（`◈ aligns-gate: 巨石文件拆分`）**  
  第一棒审稿正常收尾、且后台没有挂起任务时，插件会扫一遍仓库源码（跳过 `node_modules`、`dist`、测试文件等）。只要发现超过 500 行的文件，就会自动发一条合成消息唤醒主控，让它派 `@fixer` 把最大的那个文件按职责拆到 500 行以内（每轮对话最多触发一次）。

- **主控写入拦截（`[审慎写入确认]`）**  
  主控直接对业务代码调 `edit` / `write` / `patch` 时，第一次会被拦下并提示复用刚才的 `@designer` / `@fixer` 热会话 `sessionID`。如果确实只是改两行的小修补，对同一个文件再调一次就会放行，放行后立即恢复拦截状态（改 `README.md`、`ALIGNS.md`、`package.json` 等不拦截）。

- **重复 `<task>` 通知去重**  
  多工作区实例挂载或前台复用后台 `sessionID` 时，如果底层重复投递了同一个子会话的 `<task state="completed">`，插件会自动拦截并折叠，防止主控被反复唤醒重跑截图。

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

插件向上查找项目根目录下的 `ALIGNS.md`（没有这个文件时插件不会触发审稿和拆文件）。可以参考 [`examples/ALIGNS.example.md`](./examples/ALIGNS.example.md)：

```markdown
<!-- aligns-gate: max_lines=500, max_windows=2, auto_split=true, router_guard=true -->
# ALIGNS.md

当前处于子任务回归后的审稿窗口。不要直接相信子任务的文字总结，先核验产物：

## @designer
1. 打开浏览器实机截图（桌面端 + 移动端视口），点击主要交互确认状态切换正常。
2. 检查是否有文字溢出、等宽呆板卡片堆砌、悬停/空状态缺失或生硬机翻文案。
3. 不达标直接带原 sessionID 打回 @designer 返工。

## @fixer
1. 跑一遍相关测试、类型检查或构建，看真实退出码和输出。
2. 检查边界条件、错误处理和接口契约有没有破损。
```

## 可选参数

写在 `ALIGNS.md` 第一行的注释里即可（注入给模型前会自动去掉，不占 Token），也可以用环境变量覆盖：

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
