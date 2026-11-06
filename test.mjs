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
  installSyntheticTaskDeduper,
  maybeEmitIntentAlignNotice,
  neutralizeDuplicateTaskNotifications,
  parseMandateConfig,
  stripMandateGate
} from "./index.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aligns-gate-test-"));
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
  assert.deepEqual(config, { maxLines: 380, maxWindows: 3, autoSplit: false, routerGuard: false });
  assert.equal(cleanRaw, "# ALIGNS\nKeep it real.");
});

test("enforceOrchestratorRouterGuard intercepts 1st write, allows 2nd retry, and intercepts 3rd write", () => {
  const ev = { agent: "orchestrator", sessionID: "ses_guard_test", tool: "edit", input: { path: "src/app.ts" } };
  assert.throws(() => enforceOrchestratorRouterGuard(ev, dir), /\[审慎写入确认\]/);
  assert.doesNotThrow(() => enforceOrchestratorRouterGuard(ev, dir));
  assert.throws(() => enforceOrchestratorRouterGuard(ev, dir), /\[审慎写入确认\]/);
});
