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

test("mid-flight user updates defer background audits without consuming a redispatch window", async () => {
  assert.equal(analyzeAuditWindow([]).launchedBeforeLatestUser, false);
  for (const tag of ["task", "subagent"]) {
    for (const foreground of [false, true]) {
      const launch = dispatch("ses_bg_pre");
      launch.content[0].state.input.agent = "designer";
      const messages = [user(), launch, {
        ...user(), id: "human_midflight",
        content: [{ type: "text", text: "Also update the layout" }]
      }, completion("ses_bg_pre", `pre_${tag}_${foreground}`, tag)];
      const state = analyzeAuditWindow(messages);
      assert.equal(state.inAuditWindow, true);
      assert.equal(state.launchedBeforeLatestUser, true);
      assert.equal(state.windowCount, 1);
      const sent = [];
      const ctx = { directory: dir, session: { synthetic: async (payload) => sent.push(payload) } };
      assert.equal(await maybeEmitIntentAlignNotice(ctx, "ses_midflight", state, dir), false);
      assert.equal(sent.length, 0);
      assert.equal(applyMandateGateToV2Event({ messages }, dir), true);
      const reminder = messages.at(-1).content[0].text;
      assert.match(reminder, /\[ALIGNS\.md — 派发 @aligner 独立审稿 · 1\/5\]/);
      assert.ok(reminder.includes('- 若用户最新消息有待补发的改动需求：请直接调用 `subagent(agent="designer", sessionID="ses_bg_pre")` 补发新需求继续执行，暂不调 @aligner，等新需求跑完再统一审稿。'));
      assert.ok(reminder.includes('- 若无需补发改动：请调用 `subagent(agent="aligner", background=false, description="Audit @designer g_pre-1")` 独立审稿。'));
      assert.doesNotMatch(reminder, /检测到后台运行期间有用户新消息/);

      stripMandateGate(messages);
      const redispatch = dispatch("ses_bg_pre", !foreground);
      redispatch.content[0].state.input.agent = "designer";
      messages.push(redispatch);
      if (!foreground) messages.push(completion("ses_bg_pre", `post_${tag}`, tag));
      const updated = analyzeAuditWindow(messages);
      assert.equal(updated.inAuditWindow, true);
      assert.equal(updated.launchedBeforeLatestUser, false);
      assert.equal(updated.windowCount, 1);
    }
  }
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
  for (const header of ["巨石文件拆分", "巨石文件拆分后续轮次"]) {
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
  assert.match(messages.at(-1).content[0].text, /派发 @aligner 独立审稿/);
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

test("aligner descriptions containing the worker tag still receive one unique suffix", () => {
  const messages = [user(), dispatch("ses_worker_SbdHY", false)];
  const sessionID = "ses_description_suffix_parent";
  assert.equal(applyMandateGateToV2Event({ sessionID, messages }, dir), true);
  assert.match(messages.at(-1).content[0].text, /description="Audit @fixer SbdHY-1"/);
  for (const tool of ["subagent", "task"]) {
    const event = { tool, sessionID, input: { agent: "aligner", description: "Audit @fixer SbdHY-1" } };
    assert.equal(enrichAlignerSubagentCall(event, dir), true);
    assert.match(event.input.description, /^Audit @fixer SbdHY-1 #SbdHY-[a-z0-9]+$/i);
    const description = event.input.description;
    // Exercise the suffix check again without the enriched-prompt early return.
    event.input.prompt = "Run tests";
    assert.equal(enrichAlignerSubagentCall(event, dir), true);
    assert.equal(event.input.description, description);
  }
});

test("failed aligner calls preserve the first audit window without stale reviewer sessions", () => {
  const failures = [
    { status: "error" },
    { state: { status: "error" } },
    { isError: true },
    { state: { error: "Dispatch failed" } },
    { error: "Dispatch failed" }
  ];
  for (const tool of ["subagent", "task"]) {
    for (const type of ["tool", "tool-call", "tool-result"]) {
      for (const failure of failures) {
        const input = { agent: "aligner", background: false, sessionID: "ses_oldAligner" };
        const failedPart = {
          type, tool, toolName: tool, id: "failed_audit", toolCallId: "failed_audit",
          input, args: input, output: "Dispatch failed", ...failure,
          state: { input, ...failure.state }
        };
        const messages = [user(), dispatch("ses_failed_audit_worker"), completion("ses_failed_audit_worker")];
        const original = analyzeAuditWindow(messages);
        messages.push({ role: "assistant", content: [failedPart] });
        const state = analyzeAuditWindow(messages);
        assert.equal(state.inAuditWindow, true);
        assert.equal(state.auditRound, 1);
        assert.equal(state.alignerAuditCount, 0);
        assert.equal(state.alignerSessionID, null);
        assert.deepEqual(state.closedWindows, original.closedWindows);
        assert.deepEqual(state.returnedSessionsSinceDispatch, original.returnedSessionsSinceDispatch);
        messages.push(completion("ses_failed_audit_worker", "duplicate_after_error"));
        assert.deepEqual(analyzeAuditWindow(messages).duplicateNotificationIndices, [4]);
      }
    }
  }
});

test("failed worker dispatches do not overwrite launch or agent tracking", () => {
  const messages = [user(), dispatch("ses_failed_launch_worker"), completion("ses_failed_launch_worker")];
  const failed = dispatch("ses_failed_launch_worker");
  failed.content[0].state.status = "error";
  failed.content[0].state.input.agent = "designer";
  messages.push(failed);
  const state = analyzeAuditWindow(messages);
  assert.equal(state.returnedAgent, "fixer");
  assert.equal(state.lastSessionByAgent.designer, null);
  assert.equal(state.lastSessionByAgent.fixer, "ses_failed_launch_worker");
  assert.equal(state.inAuditWindow, true);
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
  assert.match(messages.at(-1).content[0].text, /1\/5/);
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
  assert.match(messages.at(-1).content[0].text, /2\/5/);
  assert.match(messages.at(-1).content[0].text, /sessionID="ses_aligner_r1"/);
  const second = { tool: "subagent", sessionID: event.sessionID, input: { agent: "aligner", sessionID: "ses_wrong", task_id: "ses_wrong", prompt: "Run npm test" } };
  assert.equal(enrichAlignerSubagentCall(second, dir), true);
  assert.equal(second.input.sessionID, "ses_aligner_r1");
  assert.equal(second.input.task_id, "ses_aligner_r1");
  assert.match(second.input.prompt, /【1\. Worker 返工交卷报告/);
  assert.match(second.input.prompt, /Reworked implementation/);
  assert.match(second.input.prompt, /### 【2\. 主控提供的环境线索[\s\S]*Run npm test/);
  assert.doesNotMatch(second.input.prompt, /### 【3\. 主控提供的环境线索|【1\. ALIGNS\.md|Review the implementation against user intent/);
  const enriched = second.input.prompt;
  assert.equal(enrichAlignerSubagentCall(second, dir), false);
  assert.equal(second.input.prompt, enriched);

  stripMandateGate(messages);
  messages.push({ ...user(), id: "human_next_turn" }, dispatch("ses_next_worker", false));
  state = analyzeAuditWindow(messages);
  assert.equal(state.alignerSessionID, null);
  assert.equal(state.windowCount, 1);
  assert.equal(state.auditRound, 1);
  assert.equal(applyMandateGateToV2Event(event, dir), true);
  const next = { tool: "subagent", sessionID: event.sessionID, input: { agent: "aligner", sessionID: "ses_aligner_r1", task_id: "ses_aligner_r1", prompt: enriched } };
  assert.equal(enrichAlignerSubagentCall(next, dir), true);
  assert.equal(next.input.sessionID, undefined);
  assert.equal(next.input.task_id, undefined);
  assert.match(next.input.prompt, /【1\. ALIGNS\.md 专属验收红线/);
  assert.match(next.input.prompt, /### 【2\. Worker 改动声明/);
  assert.match(next.input.prompt, /### 【3\. 主控提供的环境线索[\s\S]*Run npm test/);
  assert.doesNotMatch(next.input.prompt, /【1\. Worker 返工交卷报告|### 【2\. 主控提供的环境线索/);

  stripMandateGate(messages);
  messages.push({ role: "assistant", content: [{ type: "tool-call", toolName: "subagent", toolCallId: "pass_audit", args: { agent: "aligner" } }] });
  messages.push({ role: "tool", content: [{ type: "tool-result", toolName: "subagent", toolCallId: "pass_audit", output: "sessionID: ses_aligner_pass\n[ALIGN_PASS] All good" }] });
  messages.push(dispatch("ses_followup_worker", false));
  state = analyzeAuditWindow(messages);
  assert.equal(state.alignerSessionID, null);
  assert.equal(state.auditRound, 1);
  assert.equal(applyMandateGateToV2Event(event, dir), true);
  const afterPass = { tool: "subagent", sessionID: event.sessionID, input: { agent: "aligner", sessionID: "ses_aligner_pass" } };
  assert.equal(enrichAlignerSubagentCall(afterPass, dir), true);
  assert.equal(afterPass.input.sessionID, undefined);
  assert.match(afterPass.input.prompt, /【1\. ALIGNS\.md 专属验收红线/);
  assert.equal(analyzeAuditWindow([]).alignerSessionID, null);
});

test("parallel workers keep independent audit sessions, rounds, reports, and rework loops", () => {
  const scopedDir = path.join(dir, "parallel-workers");
  fs.mkdirSync(scopedDir);
  fs.writeFileSync(path.join(scopedDir, "ALIGNS.md"), "## @fixer\nFixer-only rule\n## @designer\nDesigner-only rule");
  const scenarios = ["foreground", "notification", "completed-job"].flatMap((format) =>
    ["v1", "v2", "notification"].map((auditFormat) => ({ format, auditFormat })));
  for (const { format, auditFormat } of scenarios) {
    const sessionID = `ses_parallel_${format}_${auditFormat}`;
    const messages = [user()];
    const launch = (agent) => {
      const msg = dispatch(`ses_parallel_${agent}`);
      msg.content[0].state.input.agent = agent;
      messages.push(msg);
    };
    const finish = (agent, round) => {
      const workerID = `ses_parallel_${agent}`;
      const report = `${agent} report round ${round}`;
      if (format === "foreground") {
        const msg = dispatch(workerID, false);
        msg.content[0].id = `${agent}_${round}`;
        msg.content[0].state.input.agent = agent;
        msg.content[0].state.output += `\n${report}`;
        messages.push(msg);
      } else if (format === "notification") {
        const msg = completion(workerID, `${agent}_${round}`);
        msg.content[0].text = msg.content[0].text.replace("Done", report);
        messages.push(msg);
      } else {
        messages.push({ role: "user", metadata: { source: "subagent" }, content: [{
          type: "text", text: `<completed-job> @${agent}\ntask: ${workerID}\n${report}\n</completed-job>`
        }] });
      }
    };
    const enrich = (agent) => {
      // Transform a copy: dehydration must not remove history from this fixture.
      applyMandateGateToV2Event({ sessionID, messages: structuredClone(messages) }, scopedDir);
      const event = { tool: "subagent", sessionID, input: {
        agent: "aligner", description: `Audit @${agent}`, sessionID: "ses_stale_reviewer"
      } };
      assert.equal(enrichAlignerSubagentCall(event, scopedDir), true);
      return event;
    };
    const audit = (agent, round, verdict) => {
      const event = enrich(agent);
      const expectedSession = `ses_aligner_${agent}`;
      if (round === 1) {
        assert.equal(event.input.sessionID, undefined);
        assert.match(event.input.prompt, new RegExp(`【1\\. ALIGNS\\.md 专属验收红线 · @${agent}】`));
        assert.ok(event.input.prompt.includes(agent === "fixer" ? "Fixer-only rule" : "Designer-only rule"));
        assert.ok(!event.input.prompt.includes(agent === "fixer" ? "Designer-only rule" : "Fixer-only rule"));
      } else {
        assert.equal(event.input.sessionID, expectedSession);
        assert.match(event.input.prompt, new RegExp(`【1\\. Worker 返工交卷报告 · @${agent}`));
      }
      assert.ok(event.input.prompt.includes(`${agent} report round ${round}`));
      assert.ok(!event.input.prompt.includes(`${agent === "fixer" ? "designer" : "fixer"} report`));
      const callID = `audit_${agent}_${round}`;
      if (auditFormat === "v1") {
        messages.push({ role: "assistant", content: [{ type: "tool", tool: "subagent", id: callID,
          state: { status: "completed", input: event.input, output: `sessionID: ${expectedSession}\n${verdict}` } }] });
      } else {
        messages.push({ role: "assistant", content: [{ type: "tool-call", toolName: "subagent", toolCallId: callID, args: event.input }] });
        if (auditFormat === "v2") {
          messages.push({ role: "tool", content: [{ type: "tool-result", toolName: "subagent", toolCallId: callID, output: `sessionID: ${expectedSession}\n${verdict}` }] });
        } else {
          const notice = completion(expectedSession, callID, "subagent");
          notice.metadata = { agent: "aligner" };
          notice.content[0].text = notice.content[0].text.replace("Done", `Audit @${agent}\n${verdict}`);
          messages.push(notice);
        }
      }
    };

    launch("fixer");
    launch("designer");
    finish("fixer", 1);
    audit("fixer", 1, "[ALIGN_POLISH]");
    launch("fixer");
    finish("designer", 1);
    let state = analyzeAuditWindow(messages);
    assert.equal(state.returnedAgent, "designer");
    assert.equal(state.auditRound, 1);
    assert.equal(state.alignerSessionID, null);
    assert.equal(state.workerBuckets.fixer.inReworkLoop, true);
    audit("designer", 1, "[ALIGN_POLISH]");
    finish("fixer", 2);
    state = analyzeAuditWindow(messages);
    assert.equal(state.inAuditWindow, true);
    assert.equal(state.auditRound, 2);
    // Rework for a different worker must not close fixer's pending audit.
    const originalClosedWindows = state.closedWindows;
    launch("designer");
    state = analyzeAuditWindow(messages);
    assert.equal(state.inAuditWindow, true);
    assert.equal(state.returnedAgent, "fixer");
    assert.deepEqual(state.closedWindows, originalClosedWindows);
    audit("fixer", 2, "[ALIGN_PASS]");
    state = analyzeAuditWindow(messages);
    assert.equal(state.workerBuckets.fixer.inReworkLoop, false);
    assert.equal(state.workerBuckets.designer.inReworkLoop, true);
    finish("designer", 2);
    state = analyzeAuditWindow(messages);
    assert.equal(state.returnedAgent, "designer");
    assert.equal(state.auditRound, 2);
    assert.equal(state.alignerSessionID, "ses_aligner_designer");
    assert.equal(state.alignerAuditCount, 1);
    // An explicit non-active target still receives its own bucket's dossier.
    const fixerAudit = enrich("fixer");
    assert.equal(fixerAudit.input.sessionID, "ses_aligner_fixer");
    assert.match(fixerAudit.input.prompt, /fixer report round 2/);
    assert.doesNotMatch(fixerAudit.input.prompt, /designer report/);
    audit("designer", 2, "[ALIGN_PASS]");
  }
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
      for (let round = 1; round <= 6; round++) {
        const audit = alignerMessages(`[${verdict}] Fix remaining issues`, format);
        messages.push(...audit.slice(1));
        const state = analyzeAuditWindow(messages);
        assert.equal(state.windowCount, round);
        assert.equal(state.alignerRejected, round <= 5, `${verdict} ${format} round ${round}`);
        assert.equal(analyzeAuditWindow(messages, 6).alignerRejected, true);
        const injected = applyMandateGateToV2Event({ messages }, dir);
        assert.equal(injected, round <= 5);
        if (injected) {
          const text = messages.at(-1).content[0].text;
          assert.match(text, /审稿未通过/);
          assert.match(text, /agent="fixer", sessionID="ses_original_worker"/);
          reminders.push(text);
        }
        stripMandateGate(messages);
      }
    }
    assert.equal(reminders[0], reminders[5]);
    assert.equal(reminders[1], reminders[6]);
  }
});

test("aligner dossier strips outer subagent/task tags while preserving full worker report", () => {
  for (const tag of ["task", "subagent"]) {
    for (const reaudit of [false, true]) {
      const notice = completion("ses_clean_worker", `clean_${tag}_${reaudit}`, tag);
      notice.content[0].text = notice.content[0].text.replace("Done", "Implemented behavior\n### 验证结果\nRan pnpm test");
      const messages = [user()];
      if (reaudit) {
        messages.push(...alignerMessages("sessionID: ses_clean_aligner\n[ALIGN_REJECT] Fix it", "v1").slice(1));
      }
      messages.push(dispatch("ses_clean_worker"), notice);
      const parent = `ses_clean_${tag}_${reaudit}`;
      assert.equal(applyMandateGateToV2Event({ sessionID: parent, messages }, dir), true);
      const event = { tool: "subagent", sessionID: parent, input: { agent: "aligner" } };
      assert.equal(enrichAlignerSubagentCall(event, dir), true);
      assert.match(event.input.prompt, /Implemented behavior\n### 验证结果\nRan pnpm test/);
      assert.doesNotMatch(event.input.prompt, /<\/?(?:task|subagent)\b/);
      if (reaudit) {
        assert.equal(event.input.sessionID, "ses_clean_aligner");
        assert.match(event.input.prompt, /未达标项或打磨建议/);
      }
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
