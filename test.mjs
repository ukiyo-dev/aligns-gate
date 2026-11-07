import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, after } from "node:test";
import plugin, {
  analyzeAuditWindow,
  applyMandateGateToV1Messages,
  applyMandateGateToV2Event,
  enforceOrchestratorRouterGuard,
  enrichAlignerSubagentCall,
  ensureAlignerAgentConfigured,
  installSyntheticTaskDeduper,
  maybeEmitIntentAlignNotice,
  neutralizeDuplicateTaskNotifications,
  parseMandateConfig,
  stripMandateGate
} from "./index.mjs";

const dir = fs.mkdtempSync(path.join("/tmp/opencode", "aligns-gate-test-"));
fs.writeFileSync(path.join(dir, "ALIGNS.md"), "Review the implementation against user intent.");
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const user = () => ({ id: "human", role: "user", content: [{ type: "text", text: "Implement this" }] });
const completion = (session, id = session, tag = "task") => ({
  id: `msg_omos_${id}`, role: "user",
  content: [{ type: "text", text: tag === "task"
    ? `<task id="${session}" state="completed">Done</task>`
    : `<subagent sessionID="${session}" state="completed">Done</subagent>` }]
});
const dispatch = (session, background = true) => ({
  role: "assistant", content: [{ type: "tool", tool: "subagent", id: session,
    state: { status: "completed", input: { agent: "fixer", background, sessionID: session },
      output: background ? `working in the background sessionID: ${session}` : `sessionID: ${session}` } }]
});

test("duplicate task/subagent notices preserve the active window and watermark", () => {
  const messages = [user(), dispatch("ses_a"), dispatch("ses_b"), completion("ses_a"), completion("ses_b")];
  const original = analyzeAuditWindow(messages);
  messages.push(completion("ses_a", "duplicate", "subagent"));
  const state = analyzeAuditWindow(messages);
  assert.equal(state.windowCount, 2);
  assert.equal(state.watermark, original.watermark);
  assert.equal(state.inAuditWindow, true);
  assert.deepEqual(state.closedWindows, original.closedWindows);
  assert.deepEqual(state.duplicateNotificationIndices, [5]);
});

test("foreground completion deduplicates background notifications", () => {
  const messages = [user(), dispatch("ses_fg", false), completion("ses_fg")];
  const state = analyzeAuditWindow(messages);
  assert.equal(state.windowCount, 1);
  assert.equal(state.watermark, "fg:ses_fg");
  assert.deepEqual(state.closedWindows, []);
  assert.deepEqual(state.duplicateNotificationIndices, [2]);
});

test("new dispatch or genuine user message resets duplicate tracking", () => {
  const messages = [user(), completion("ses_again"), dispatch("ses_again"), completion("ses_again", "new")];
  assert.equal(analyzeAuditWindow(messages).windowCount, 2);
  assert.deepEqual(analyzeAuditWindow(messages).duplicateNotificationIndices, []);
  messages.push(user(), completion("ses_again", "newturn"));
  assert.equal(analyzeAuditWindow(messages).windowCount, 1);
  assert.deepEqual(analyzeAuditWindow(messages).duplicateNotificationIndices, []);
});

test("neutralization supports both message formats and invalid inputs", () => {
  neutralizeDuplicateTaskNotifications(null, []);
  neutralizeDuplicateTaskNotifications([], null);
  const messages = [{ parts: [{ text: "old" }] }, { content: [{ text: "old" }] }];
  neutralizeDuplicateTaskNotifications(messages, [0, 1, 99]);
  for (const msg of messages) {
    const parts = msg.parts ?? msg.content;
    assert.equal(parts[0].synthetic, true);
    assert.match(parts[0].text, /重复的子任务完成通知已自动折叠忽略/);
  }
});

test("V1 and V2 transforms neutralize duplicate notifications", () => {
  for (const v1 of [false, true]) {
    let messages = [user(), dispatch("ses_transform", false), completion("ses_transform")];
    if (v1) messages = messages.map(({ content, ...msg }) => ({ info: msg, parts: content }));
    assert.equal(v1 ? applyMandateGateToV1Messages(messages, dir)
      : applyMandateGateToV2Event({ messages, sessionID: "ses_transform_parent" }, dir), true);
    assert.match((messages[2].parts ?? messages[2].content)[0].text, /重复的子任务完成通知/);
    assert.equal(analyzeAuditWindow(messages).windowCount, 1);
  }
});

test("intent notices strip by ID or marker without losing other content", () => {
  const messages = [user(), { id: "msg_omos_aligns_notice_empty", role: "user" },
    { role: "user", parts: [{ text: "<!-- ALIGNS_INTENT_NOTICE -->notice" }, { text: "keep" }] }];
  stripMandateGate(messages);
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[1].parts, [{ text: "keep" }]);
});

test("intent notice emits once per session/watermark with required metadata", async () => {
  const sent = [];
  const ctx = { directory: dir, session: { synthetic: async (payload) => sent.push(payload) } };
  const state = { inAuditWindow: true, watermark: "notice-one", windowCount: 1, returnedAgent: "fixer" };
  assert.equal(await maybeEmitIntentAlignNotice(ctx, "ses_notice", state, dir), true);
  assert.equal(await maybeEmitIntentAlignNotice(ctx, "ses_notice", state, dir), false);
  assert.equal(await maybeEmitIntentAlignNotice(ctx, "ses_other", state, dir), true);
  assert.equal(await maybeEmitIntentAlignNotice(ctx, "ses_foreign", state, path.dirname(dir)), false);
  assert.equal(await maybeEmitIntentAlignNotice(ctx, "ses_closed", { ...state, inAuditWindow: false }, dir), false);
  assert.equal(await maybeEmitIntentAlignNotice({}, "ses_missing", state, dir), false);
  assert.equal(await maybeEmitIntentAlignNotice({ session: ctx.session }, "ses_no_mandate", state, "/nonexistent-aligns-test"), false);
  assert.match(sent[0].id, /^msg_omos_aligns_notice_/);
  assert.match(sent[0].text, /<!-- ALIGNS_INTENT_NOTICE -->/);
  assert.equal(sent[0].description, "aligns-gate: 人类意图对齐");
  assert.equal(sent[0].delivery, "steer");
  assert.equal(sent[0].resume, false);
  assert.equal(sent[0].metadata["oh-my-opencode-slim.orchestratorMandateGate"], true);
});

test("context hook emits intent notices after transforming", async () => {
  let hook;
  const sent = [];
  const dispose = await plugin.setup({ directory: dir, session: {
    hook: async (_name, callback) => { hook = callback; },
    synthetic: async (payload) => sent.push(payload)
  } });
  await hook({ sessionID: "ses_hook", messages: [user(), dispatch("ses_hook_child", false)] });
  assert.equal(sent.length, 1);
  await dispose();
});

test("both split reminder headers are recognized without opening a new user turn", () => {
  for (const header of ["巨石文件拆分", "巨石文件拆分第二棒"]) {
    const messages = [user(), completion("ses_split"), { role: "user", content: [{ type: "text", text: `[ALIGNS.md — ${header}]` }] }];
    const state = analyzeAuditWindow(messages);
    assert.equal(state.turnId, "human");
    assert.equal(state.hasSplitInitiatorInTurn, true);
    assert.equal(state.inAuditWindow, false);
  }
});

test("installSyntheticTaskDeduper blocks duplicate cross-instance task wakeups", async () => {
  const delivered = [];
  const ctxA = { session: { synthetic: async (p) => { delivered.push(p); return { ok: true }; } } };
  const ctxB = { session: { synthetic: async (p) => { delivered.push(p); return { ok: true }; } } };
  installSyntheticTaskDeduper(ctxA);
  installSyntheticTaskDeduper(ctxB);
  const payload = { sessionID: "ses_parent_dedupe", id: "msg_1", text: '<task id="ses_child_dedupe" state="completed">Done</task>' };
  await ctxA.session.synthetic(payload);
  const second = await ctxB.session.synthetic({ ...payload, id: "msg_2" });
  assert.equal(delivered.length, 1);
  assert.equal(second.deduplicated, true);
});

test("parseMandateConfig parses HTML comments and YAML frontmatter cleanly", () => {
  const { config, cleanRaw } = parseMandateConfig(
    "<!-- aligns-gate: max_lines=380, max_windows=3, auto_split=false, router_guard=false -->\n# ALIGNS\nKeep it real."
  );
  assert.deepEqual(config, { maxLines: 380, maxWindows: 3, autoSplit: false, routerGuard: false, useAligner: true });
  assert.equal(cleanRaw, "# ALIGNS\nKeep it real.");
});

test("aligner configuration supports aliases, environment default, and inline fallback", () => {
  assert.equal(parseMandateConfig("<!-- aligns-gate: use_aligner=false -->").config.useAligner, false);
  assert.equal(parseMandateConfig("---\nuseAligner: true\n---\nRules").config.useAligner, true);
  const previous = process.env.ALIGNS_GATE_USE_ALIGNER;
  try {
    process.env.ALIGNS_GATE_USE_ALIGNER = "false";
    assert.equal(parseMandateConfig("").config.useAligner, false);
  } finally {
    if (previous === undefined) delete process.env.ALIGNS_GATE_USE_ALIGNER;
    else process.env.ALIGNS_GATE_USE_ALIGNER = previous;
  }
  const inlineDir = path.join(dir, "inline");
  fs.mkdirSync(inlineDir);
  fs.writeFileSync(path.join(inlineDir, "ALIGNS.md"), "<!-- aligns-gate: use_aligner=false -->\nInline red line");
  for (const v1 of [true, false]) {
    const messages = [user(), dispatch("ses_inline", false)];
    assert.equal(v1 ? applyMandateGateToV1Messages(messages, inlineDir)
      : applyMandateGateToV2Event({ messages }, inlineDir), true);
    assert.match((messages.at(-1).parts ?? messages.at(-1).content)[0].text, /审稿窗口期已激活[\s\S]*Inline red line/);
  }
});

test("aligner calls receive the original user, worker report, role mandate, and synchronous execution", () => {
  const scopedDir = path.join(dir, "scoped");
  fs.mkdirSync(scopedDir);
  fs.writeFileSync(path.join(scopedDir, "ALIGNS.md"), "Common rule\n## @fixer\nRun actual tests\n## @designer\nVisual rule");
  const messages = [user(), dispatch("ses_dossier_worker", false)];
  messages[1].content[0].state.output += "\nOriginal worker report";
  messages[0].content.push({ type: "text", synthetic: true, text: "Injected reminder", metadata: { "oh-my-opencode-slim.orchestratorMandateGate": true } });
  assert.equal(applyMandateGateToV2Event({ sessionID: "ses_dossier", messages }, scopedDir), true);
  assert.match(messages.at(-1).content[0].text, /第一棒：派发 @aligner/);
  for (const tool of ["subagent", "task"]) {
    const event = { tool, sessionID: "ses_dossier", input: { agent: "aligner", background: true, prompt: "Run npm test" } };
    assert.equal(enrichAlignerSubagentCall(event), true);
    assert.equal(event.input.background, false);
    assert.doesNotMatch(event.input.prompt, /用户原始原话/);
    assert.match(event.input.prompt, /【2\. Worker 改动声明 · @fixer · sessionID: ses_dossier_worker】/);
    assert.match(event.input.prompt, /Original worker report/);
    assert.match(event.input.prompt, /^### 【1\. ALIGNS\.md 专属验收红线 · @fixer】/);
    assert.match(event.input.prompt, /Run actual tests/);
    assert.match(event.input.prompt, /【3\. 主控提供的环境线索[\s\S]*Run npm test/);
    assert.doesNotMatch(event.input.prompt, /Visual rule|Injected reminder/);
    const prompt = event.input.prompt;
    event.input.background = true;
    assert.equal(enrichAlignerSubagentCall(event), false);
    assert.equal(event.input.background, false);
    assert.equal(event.input.prompt, prompt);
  }
  assert.equal(enrichAlignerSubagentCall({ tool: "read", input: {} }, dir), false);
  assert.equal(enrichAlignerSubagentCall({ tool: "task", input: { agent: "fixer" } }, dir), false);
});

function alignerMessages(verdict, format) {
  const messages = [user(), dispatch("ses_original_worker", false)];
  const input = { agent: "aligner", background: false, sessionID: "ses_reviewer" };
  if (format === "v1") {
    messages.push({ role: "assistant", content: [{ type: "tool", tool: "subagent", state: { status: "completed", input, output: verdict } }] });
  } else {
    messages.push({ role: "assistant", content: [{ type: "tool-call", toolName: "subagent", toolCallId: "audit", args: input }] });
    if (format === "v2") messages.push({ role: "tool", content: [{ type: "tool-result", toolName: "subagent", toolCallId: "audit", output: verdict }] });
    else {
      const notice = completion("ses_reviewer", "reviewer", format);
      notice.content[0].text = notice.content[0].text.replace("Done", verdict);
      messages.push(notice);
    }
  }
  return messages;
}

test("aligner reuses its session within a turn and starts fresh across turns", () => {
  const messages = [user(), dispatch("ses_reuse_worker", false)];
  const event = { sessionID: "ses_reuse_parent", messages };
  let state = analyzeAuditWindow(messages);
  assert.equal(state.windowCount, 1);
  assert.equal(state.alignerSessionID, null);
  assert.equal(applyMandateGateToV2Event(event, dir), true);
  assert.match(messages.at(-1).content[0].text, /1\/2/);
  const first = { tool: "subagent", sessionID: event.sessionID, input: { agent: "aligner" } };
  assert.equal(enrichAlignerSubagentCall(first, dir), true);
  assert.equal(first.input.sessionID, undefined);
  assert.match(first.input.prompt, /【1\. ALIGNS\.md 专属验收红线/);

  stripMandateGate(messages);
  messages.push({ role: "assistant", content: [{ type: "tool-call", toolName: "subagent", toolCallId: "reuse_audit", args: first.input }] });
  messages.push({ role: "tool", content: [{ type: "tool-result", toolName: "subagent", toolCallId: "reuse_audit", output: "sessionID: ses_aligner_r1\n[ALIGN_REJECT] Missing behavior" }] });
  assert.equal(analyzeAuditWindow(messages).alignerRejected, true);
  messages.push(dispatch("ses_reuse_worker", false));
  messages.at(-1).content[0].state.output += "\nReworked implementation";
  state = analyzeAuditWindow(messages);
  assert.equal(state.windowCount, 2);
  assert.equal(state.alignerSessionID, "ses_aligner_r1");
  assert.equal(applyMandateGateToV2Event(event, dir), true);
  assert.match(messages.at(-1).content[0].text, /2\/2/);
  assert.match(messages.at(-1).content[0].text, /sessionID="ses_aligner_r1"/);
  const second = { tool: "subagent", sessionID: event.sessionID, input: { agent: "aligner", prompt: "Run npm test" } };
  assert.equal(enrichAlignerSubagentCall(second, dir), true);
  assert.equal(second.input.sessionID, "ses_aligner_r1");
  assert.match(second.input.prompt, /【1\. Worker 返工交卷报告/);
  assert.match(second.input.prompt, /Reworked implementation/);
  assert.match(second.input.prompt, /Run npm test/);
  assert.doesNotMatch(second.input.prompt, /【1\. ALIGNS\.md|Review the implementation against user intent/);
  const enriched = second.input.prompt;
  assert.equal(enrichAlignerSubagentCall(second, dir), false);
  assert.equal(second.input.prompt, enriched);

  stripMandateGate(messages);
  messages.push({ ...user(), id: "human_next_turn" }, dispatch("ses_next_worker", false));
  state = analyzeAuditWindow(messages);
  assert.equal(state.alignerSessionID, null);
  assert.equal(state.windowCount, 1);
  assert.equal(applyMandateGateToV2Event(event, dir), true);
  const next = { tool: "subagent", sessionID: event.sessionID, input: { agent: "aligner" } };
  assert.equal(enrichAlignerSubagentCall(next, dir), true);
  assert.equal(next.input.sessionID, undefined);
  assert.match(next.input.prompt, /【1\. ALIGNS\.md 专属验收红线/);
  assert.equal(analyzeAuditWindow([]).alignerSessionID, null);
});

test("aligner session tracking supports text returns, input, metadata, and output IDs", () => {
  for (const format of ["v1", "v2", "task", "subagent"]) {
    assert.equal(analyzeAuditWindow(alignerMessages("[ALIGN_PASS]", format)).alignerSessionID, "ses_reviewer");
  }
  for (const output of ['sessionID: "ses_output"', '<task id="ses_output">Done</task>', '<subagent sessionID="ses_output">Done</subagent>']) {
    const messages = alignerMessages(output, "v1");
    assert.equal(analyzeAuditWindow(messages).alignerSessionID, "ses_output");
  }
  const messages = alignerMessages("[ALIGN_PASS]", "v1");
  const toolState = messages.at(-1).content[0].state;
  delete toolState.input.sessionID;
  toolState.metadata = { sessionID: "ses_metadata" };
  assert.equal(analyzeAuditWindow(messages).alignerSessionID, "ses_metadata");
  for (const key of ["sessionID", "task_id"]) {
    const event = { tool: "task", input: { agent: "aligner", [key]: "ses_explicit" } };
    assert.equal(enrichAlignerSubagentCall(event, dir), true);
    assert.equal(event.input[key], "ses_explicit");
    assert.match(event.input.prompt, /【1\. Worker 返工交卷报告/);
    assert.doesNotMatch(event.input.prompt, /【1\. ALIGNS\.md/);
  }
});

test("ALIGN_REJECT reopens rejection reminders for the original hot worker and clears on redispatch", () => {
  for (const format of ["v1", "v2", "task", "subagent"]) {
    const messages = alignerMessages("[ALIGN_REJECT] Missing behavior", format);
    const state = analyzeAuditWindow(messages);
    assert.equal(state.alignerRejected, true, format);
    assert.equal(state.inAuditWindow, false);
    assert.equal(state.windowCount, 1);
    const event = { sessionID: `ses_reject_${format}`, messages };
    assert.equal(applyMandateGateToV2Event(event, dir), true);
    assert.match(messages.at(-1).content[0].text, /\[ALIGNS\.md — @aligner 审稿未通过\]/);
    assert.match(messages.at(-1).content[0].text, /agent="fixer", sessionID="ses_original_worker"/);
    stripMandateGate(messages);
    messages.push(dispatch("ses_original_worker"));
    assert.equal(analyzeAuditWindow(messages).alignerRejected, false);
    assert.equal(applyMandateGateToV2Event(event, dir), false);
  }
});

test("POLISH and REJECT bounce back identically in every round through the configured cap", () => {
  for (const format of ["v1", "v2", "task", "subagent"]) {
    const reminders = [];
    for (const verdict of ["ALIGN_REJECT", "ALIGN_POLISH"]) {
      const messages = [user()];
      for (let round = 1; round <= 3; round++) {
        const audit = alignerMessages(`[${verdict}] Fix remaining issues`, format);
        messages.push(...audit.slice(1));
        const state = analyzeAuditWindow(messages);
        assert.equal(state.windowCount, round);
        assert.equal(state.alignerRejected, round <= 2, `${verdict} ${format} round ${round}`);
        assert.equal(analyzeAuditWindow(messages, 3).alignerRejected, true);
        const injected = applyMandateGateToV2Event({ messages }, dir);
        assert.equal(injected, round <= 2);
        if (injected) {
          const text = messages.at(-1).content[0].text;
          assert.match(text, /审稿未通过/);
          assert.match(text, /agent="fixer", sessionID="ses_original_worker"/);
          reminders.push(text);
        }
        stripMandateGate(messages);
      }
    }
    assert.equal(reminders[0], reminders[2]);
    assert.equal(reminders[1], reminders[3]);
  }
});

test("aligner dossier strips outer subagent/task tags while preserving full worker report", () => {
  for (const tag of ["task", "subagent"]) {
    for (const reaudit of [false, true]) {
      const notice = completion("ses_clean_worker", `clean_${tag}_${reaudit}`, tag);
      notice.content[0].text = notice.content[0].text.replace("Done", "Implemented behavior\n### 验证结果\nRan pnpm test");
      const messages = [user(), dispatch("ses_clean_worker"), notice];
      const parent = `ses_clean_${tag}_${reaudit}`;
      assert.equal(applyMandateGateToV2Event({ sessionID: parent, messages }, dir), true);
      const event = { tool: "subagent", sessionID: parent, input: { agent: "aligner", ...(reaudit ? { sessionID: "ses_clean_aligner" } : {}) } };
      assert.equal(enrichAlignerSubagentCall(event, dir), true);
      assert.match(event.input.prompt, /Implemented behavior\n### 验证结果\nRan pnpm test/);
      assert.doesNotMatch(event.input.prompt, /<\/?(?:task|subagent)\b/);
      if (reaudit) assert.match(event.input.prompt, /未达标项或打磨建议/);
    }
  }
});

test("ALIGN_PASS closes the audit without a rejection or new audit window", () => {
  for (const format of ["v1", "v2", "task", "subagent"]) {
    const messages = alignerMessages("[ALIGN_PASS] Tests passed", format);
    const state = analyzeAuditWindow(messages);
    assert.equal(state.inAuditWindow, false, format);
    assert.equal(state.alignerRejected, false, format);
    assert.equal(state.windowCount, 1);
    assert.equal(applyMandateGateToV2Event({ messages }, dir), false);
  }
});

test("ensureAlignerAgentConfigured preserves existing configuration and is idempotent", () => {
  const configPath = path.join(dir, "agents.json");
  assert.equal(ensureAlignerAgentConfigured(configPath), false);
  fs.writeFileSync(configPath, JSON.stringify({ preset: "custom", agents: { fixer: { model: "custom" } } }));
  assert.equal(ensureAlignerAgentConfigured(configPath), true);
  const raw = fs.readFileSync(configPath, "utf8");
  const data = JSON.parse(raw);
  assert.equal(data.preset, "custom");
  assert.deepEqual(data.agents.fixer, { model: "custom" });
  assert.match(data.agents.aligner.prompt, /ALIGN_PASS/);
  assert.match(data.agents.aligner.prompt, /ALIGN_POLISH/);
  assert.match(data.agents.aligner.prompt, /ALIGN_REJECT/);
  assert.equal(ensureAlignerAgentConfigured(configPath), false);
  assert.equal(fs.readFileSync(configPath, "utf8"), raw);
});

test("enforceOrchestratorRouterGuard intercepts 1st write, allows 2nd retry, and intercepts 3rd write", () => {
  const ev = { agent: "orchestrator", sessionID: "ses_guard_test", tool: "edit", input: { path: "src/app.ts" } };
  assert.throws(() => enforceOrchestratorRouterGuard(ev, dir), /\[审慎写入确认\]/);
  assert.doesNotThrow(() => enforceOrchestratorRouterGuard(ev, dir));
  assert.throws(() => enforceOrchestratorRouterGuard(ev, dir), /\[审慎写入确认\]/);
});
