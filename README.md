# aligns-gate

受 DeepSeek Harness 团队近期公开的 [《Super-agent 设计探索》](https://github.com/deepseek-ai/dsh-superagent-prototype) 启发而写的 OpenCode 插件。

DeepSeek 在那篇实验里提到了一个很有意思的现象：哪怕给主模型配了 Subagent 工具，在中性提示词下，它做实验时**一次都没调过 Subagent**——模型天然喜欢自己一把梭干到底。而在日常重度用 OpenCode 跑多 Agent 时，也经常碰到三个头疼问题：

1. **主控老想自己下场写代码**：嫌派发麻烦，直接调 `edit` 改业务文件，几轮下来主会话上下文全被实现细节塞满。
2. **子任务交卷糊弄，主控闭眼过**：`@designer` 或 `@fixer` 跑完回来说“改好了”，主控不看浏览器截图、也不跑测试就直接信了，最后还得人肉当监工。
3. **审稿截的图把上下文撑爆**：真让主控用 `chrome-devtools` 截图审稿，截个三四张大图留在历史消息里，没聊几句 Token 就见底了。

`aligns-gate` 的思路是按 Super-agent 的 **Router / Worker 分层** 和 **事件驱动机制**，把这几件事用插件钩子管起来，不用人盯着：

## 它是怎么跑的

**1. 平时主控手痒想自己改源码？先拦一刀**  
只要主控直接对业务源码调 `edit` / `write` / `patch`，第一次直接报错拦下并提示 `[审慎写入确认]`，顺手把最近跑过的 `@designer` 或 `@fixer` 的 `sessionID` 贴给它，让它把活派给 Worker。如果确实只是顺手改两行字，对同一个文件再调一次就会放行，放行完立刻恢复拦截。改 `README.md`、`ALIGNS.md`、`package.json` 这类配置与文档文件不拦截。

![审慎写入确认](https://iili.io/nthLjgR.png)

**2. Worker 刚跑完交卷？派 `@aligner` 独立审稿，审完连图带字一起清掉**  
`ALIGNS.md` 平时不进上下文。只有 `@designer` 或 `@fixer` 刚干完活回来的那一刻，界面出现 `aligns-gate: 人类意图对齐`，插件会提醒主控调 `@aligner` 独立审稿，并自动把用户原话、Worker 报告和 `ALIGNS.md` 对应角色的红线拼进 `@aligner` 的提示词里，让它去截真机图或跑测试。不达标就打回原 `sessionID` 重做，单轮对话最多审 2 次。  
等这波审稿一结束，临时注入的提示词自动剥离，审稿期间截的页面大图和超过 180 字符的工具长输出也会被原地替换成 `[Audit result cleared after review]`，给主控腾出干净的上下文。

![人类意图对齐](https://iili.io/nthLy1j.png)

**3. 审稿收尾进入空闲？顺手扫一眼有没有超过 500 行的肥文件**  
等审稿结束、主会话进入 `idle` 且后台没有挂起任务时，插件会自动扫一遍仓库源码，跳过 `node_modules`、`dist` 和测试文件。只要发现有超过 500 行的源码文件，就自动推一条 `aligns-gate: 巨石文件拆分`，让主控派 `@fixer` 把最大的那个文件按职责拆小，每轮最多触发一次。

此外，如果多个工作区实例或前后台切换导致同一个子任务重复发来 `<task state="completed">`，插件会自动折叠重复通知，防止主控被反复唤醒重跑截图。

## 安装

在 `~/.config/opencode/opencode.json` 或项目级 `opencode.json` 里加上：

```json
{
  "plugin": [
    "oh-my-opencode-slim",
    "aligns-gate"
  ]
}
```

如果是本地 clone 下来用，直接填目录绝对路径：

```json
{
  "plugin": [
    "oh-my-opencode-slim",
    "/path/to/aligns-gate"
  ]
}
```

## 在项目根目录放一份 `ALIGNS.md`

插件向上查找项目根目录下的 `ALIGNS.md`，没放这个文件的项目不会触发审稿和拆文件。可以直接参考 [`examples/ALIGNS.example.md`](./examples/ALIGNS.example.md)：

```markdown
<!-- aligns-gate: max_lines=500, max_windows=2, auto_split=true, router_guard=true, use_aligner=true -->
# ALIGNS.md

当前处于子任务回归后的审稿窗口。不要直接采信子任务的文字总结，先核验实际产物：

## @designer
1. 打开浏览器实机截图桌面端与移动端视口，点击主要交互确认状态切换正常。
2. 检查是否有文字溢出、等宽呆板卡片堆砌、悬停/空状态缺失或生硬机翻文案。
3. 不达标直接带原 sessionID 打回 @designer 返工。

## @fixer
1. 跑一遍相关测试、类型检查或构建，看真实退出码和输出。
2. 检查边界条件、错误处理和接口契约有没有破损。
```

## 可选参数

写在 `ALIGNS.md` 第一行的注释里即可，发给模型前会自动剥离，不占 Token；也可以通过环境变量覆盖：

- `max_lines` / `ALIGNS_GATE_MAX_LINES`：超过多少行触发拆文件，默认 `500`
- `max_windows` / `ALIGNS_GATE_MAX_WINDOWS`：单轮最多激活几次审稿窗口，默认 `2`
- `auto_split` / `ALIGNS_GATE_AUTO_SPLIT`：审稿完是否自动扫大文件并触发拆分，默认 `true`
- `router_guard` / `ALIGNS_GATE_ROUTER_GUARD`：是否拦截主控直接改业务源码，默认 `true`
- `use_aligner` / `ALIGNS_GATE_USE_ALIGNER`：是否派发独立 `@aligner` 审稿，默认 `true`

## 测试

```bash
npm test
```

## License

MIT
