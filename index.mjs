import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";

const OMO_BOARD_KEY = "oh-my-opencode-slim.backgroundJobBoard";
const INTERNAL_INITIATOR_KEY = "oh-my-opencode-slim.internalInitiator";
const MANDATE_GATE_KEY = "oh-my-opencode-slim.orchestratorMandateGate";
const SPLIT_INITIATOR_KEY = "oh-my-opencode-slim.alignsSplitInitiator";
const INTERNAL_SYNTHETIC_PREFIX = "msg_omos_";
const SPLIT_SYNTHETIC_PREFIX = "msg_omos_internal_";
const INTENT_NOTICE_PREFIX = "msg_omos_aligns_notice_";
const INTENT_NOTICE_MARKER = "<!-- ALIGNS_INTENT_NOTICE -->";

const MANDATE_FILENAME = "ALIGNS.md";
const MAX_MANDATE_LINES = 60;
const MAX_MANDATE_CHARS = 3200;
const MAX_WINDOWS_PER_TURN = 2;
const MONOLITH_LINE_LIMIT = 500;
const DEHYDRATED_TEXT = "[Audit result cleared after review]";

const WRITER_AGENTS = new Set(["designer", "fixer"]);
const NON_WRITER_AGENTS = new Set(["explorer", "oracle", "observer", "council", "aligner"]);
const PRESERVED_AUDIT_TOOLS = new Set([
  "subagent",
  "task",
  "task_status",
  "task_reply",
  "task_cancel",
  "task_report",
  "question",
  "skill"
]);

const CODE_FILE_EXT_RE = /\.(?:ts|tsx|js|jsx|mjs|cjs|css|scss|less|html|vue|svelte|go|py|rs|java|kt|c|cc|cpp|h|hpp|sql)$/i;
const ALLOWED_ORCHESTRATOR_EDIT_RE = /(?:^|[\\/])(?:ALIGNS\.md|AGENTS\.md|CLAUDE\.md|README[^\\/]*\.md|CHANGELOG\.md|package\.json|tsconfig[^\\/]*\.json|opencode\.jsonc?|oh-my-opencode-slim\.jsonc?)$/i;
const IGNORED_SCAN_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  "coverage",
  ".data",
  "vendor",
  "static",
  "public",
  "locales",
  "i18n",
  "migrations",
  "__snapshots__"
]);
const IGNORED_SCAN_FILE_RE = /(?:\.d\.ts|\.(?:test|spec)\.[a-z0-9]+|\.min\.[a-z0-9]+)$/i;

const sharedState = (globalThis.__alignsGateSharedState ??= {
  fileCache: new Map(),
  sessionDirCache: new Map(),
  lastSessionState: new Map(),
  splitTriggeredTurns: new Set(),
  inFlightSplitSessions: new Set(),
  notifiedWatermarks: new Set(),
  syntheticTaskDedupe: new Map(),
  routerWritePassTokens: new Map()
});

const {
  fileCache,
  sessionDirCache,
  lastSessionState,
  splitTriggeredTurns,
  inFlightSplitSessions
} = sharedState;
const routerWritePassTokens = (sharedState.routerWritePassTokens ??= new Map());
const notifiedWatermarks = (sharedState.notifiedWatermarks ??= new Set());
const syntheticTaskDedupe = (sharedState.syntheticTaskDedupe ??= new Map());

export function parseMandateConfig(raw) {
  const defaults = {
    maxLines: Number(process.env.ALIGNS_GATE_MAX_LINES) || MONOLITH_LINE_LIMIT,
    maxWindows: Number(process.env.ALIGNS_GATE_MAX_WINDOWS) || MAX_WINDOWS_PER_TURN,
    autoSplit: process.env.ALIGNS_GATE_AUTO_SPLIT !== "false",
    routerGuard: process.env.ALIGNS_GATE_ROUTER_GUARD !== "false",
    useAligner: process.env.ALIGNS_GATE_USE_ALIGNER !== "false"
  };
  const config = { ...defaults };
  let cleanRaw = typeof raw === "string" ? raw : "";
  const keys = { max_lines: "maxLines", maxLines: "maxLines", max_windows: "maxWindows", maxWindows: "maxWindows", auto_split: "autoSplit", autoSplit: "autoSplit", router_guard: "routerGuard", routerGuard: "routerGuard", use_aligner: "useAligner", useAligner: "useAligner" };
  const parseBlock = (_match, block) => {
    for (const entry of block.split(/[,\r\n]+/)) {
      const match = /^\s*(\w+)\s*[:=]\s*(\S+)\s*$/.exec(entry);
      if (!match || !Object.hasOwn(keys, match[1])) continue;
      const key = keys[match[1]];
      const value = match[2];
      if (key === "maxLines" || key === "maxWindows") {
        if (/^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0) config[key] = Number(value);
      } else if (value === "true" || value === "false") {
        config[key] = value === "true";
      }
    }
    return "";
  };
  cleanRaw = cleanRaw.replace(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/, parseBlock);
  cleanRaw = cleanRaw.replace(/<!--\s*aligns-gate:\s*([\s\S]*?)-->/g, parseBlock);
  return { config, cleanRaw: cleanRaw.trim() };
}

function readCachedMandate(filePath) {
  const stat = fs.statSync(filePath);
  const hit = fileCache.get(filePath);
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit.raw;
  const raw = fs.readFileSync(filePath, "utf8");
  fileCache.set(filePath, { mtimeMs: stat.mtimeMs, raw });
  return raw;
}

export function resolveMandateConfig(startDir) {
  const filePath = findMandateFile(startDir);
  let raw = "";
  try {
    if (filePath) raw = readCachedMandate(filePath);
  } catch {}
  return { hasMandate: Boolean(filePath), config: parseMandateConfig(raw).config };
}

function findMandateFile(startDir) {
  if (!startDir || typeof startDir !== "string") return null;
  let current = path.resolve(startDir);
  while (true) {
    const candidate = path.join(current, MANDATE_FILENAME);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
    try {
      if (fs.existsSync(path.join(current, ".git"))) break;
    } catch {}
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

export function extractRoleSection(raw, agent) {
  raw = parseMandateConfig(raw).cleanRaw;
  if (!raw) return "";
  const normalizedAgent = typeof agent === "string" ? agent.toLowerCase().trim() : "";
  if (normalizedAgent !== "designer" && normalizedAgent !== "fixer") {
    return raw;
  }
  const lines = raw.split(/\r?\n/);
  const hasRoleHeadings = lines.some((l) => /^##\s+.*@(?:designer|fixer)\b/i.test(l));
  if (!hasRoleHeadings) return raw;

  const kept = [];
  let mode = "common";
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      if (/@designer\b/i.test(line) && !/@fixer\b/i.test(line)) mode = "designer";
      else if (/@fixer\b/i.test(line) && !/@designer\b/i.test(line)) mode = "fixer";
      else mode = "common";
    }
    if (mode === "common" || mode === normalizedAgent) {
      kept.push(line);
    }
  }
  return kept.join("\n").trim();
}

function readBoundedMandate(startDir, agent) {
  const filePath = findMandateFile(startDir);
  if (!filePath) return "";
  try {
    const raw = readCachedMandate(filePath);
    if (!raw) return "";
    const scoped = extractRoleSection(raw, agent);
    if (!scoped) return "";
    const lines = scoped.split(/\r?\n/);
    if (lines.length > MAX_MANDATE_LINES || scoped.length > MAX_MANDATE_CHARS) {
      const truncated = lines.slice(0, MAX_MANDATE_LINES).join("\n").slice(0, MAX_MANDATE_CHARS);
      return `${truncated}\n[⚠️ Warning: ${MANDATE_FILENAME} section exceeded ${MAX_MANDATE_LINES} lines / ${MAX_MANDATE_CHARS} chars and was truncated. Keep it concise.]`;
    }
    return scoped;
  } catch {
    return "";
  }
}

export function scanMonolithicFiles(workDir, limit = MONOLITH_LINE_LIMIT) {
  if (!workDir || typeof workDir !== "string") return [];
  const mandatePath = findMandateFile(workDir);
  const rootDir = mandatePath ? path.dirname(mandatePath) : path.resolve(workDir);
  const results = [];

  function walk(dir, depth) {
    if (depth > 7) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_SCAN_DIRS.has(entry.name)) continue;
        walk(fullPath, depth + 1);
      } else if (entry.isFile() && CODE_FILE_EXT_RE.test(entry.name) && !IGNORED_SCAN_FILE_RE.test(entry.name)) {
        try {
          const stat = fs.statSync(fullPath);
          if (stat.size < limit * 15 || stat.size > 2 * 1024 * 1024) continue;
          const content = fs.readFileSync(fullPath, "utf8");
          let lineCount = 1;
          for (let i = 0; i < content.length; i++) {
            if (content.charCodeAt(i) === 10) lineCount++;
          }
          if (lineCount > limit) {
            results.push({
              file: path.relative(rootDir, fullPath).replaceAll("\\", "/"),
              lines: lineCount
            });
          }
        } catch {}
      }
    }
  }

  walk(rootDir, 0);
  results.sort((a, b) => b.lines - a.lines);
  return results;
}

async function resolveSessionWorkDir(ctx, sessionID) {
  if (sessionID && sessionDirCache.has(sessionID)) {
    return sessionDirCache.get(sessionID);
  }
  if (sessionID && typeof ctx?.session?.get === "function") {
    try {
      const info = await ctx.session.get({ sessionID });
      const dir = info?.directory ?? info?.data?.directory ?? info?.location?.directory ?? info?.path;
      if (typeof dir === "string" && dir.trim()) {
        if (sessionDirCache.size >= 512) {
          const oldest = sessionDirCache.keys().next().value;
          if (oldest !== undefined) sessionDirCache.delete(oldest);
        }
        sessionDirCache.set(sessionID, dir);
        return dir;
      }
    } catch {}
  }
  return ctx?.location?.directory || ctx?.directory || process.cwd();
}

function getRole(msg) {
  return msg?.info?.role ?? msg?.role;
}

function getMessageId(msg) {
  return msg?.info?.id ?? msg?.id;
}

function getSessionId(msg, fallback) {
  return msg?.info?.sessionID ?? msg?.sessionID ?? fallback;
}

function getParts(msg) {
  if (Array.isArray(msg?.parts)) return msg.parts;
  if (Array.isArray(msg?.content)) return msg.content;
  return [];
}

function setParts(msg, nextParts) {
  if (Array.isArray(msg?.parts)) msg.parts = nextParts;
  else if (Array.isArray(msg?.content)) msg.content = nextParts;
}

function isMandateTaggedPart(part) {
  if (typeof part?.text === "string" && part.text.includes(INTENT_NOTICE_MARKER)) return true;
  return Boolean(part && typeof part === "object" && part.synthetic === true && part.metadata?.[MANDATE_GATE_KEY] === true);
}

function extractMessagePlainText(msg, maxChars = 4000) {
  const parts = getParts(msg);
  const text = parts
    .filter((p) => p?.type === "text" && typeof p.text === "string" && !isMandateTaggedPart(p))
    .map((p) => p.text.trim())
    .filter(Boolean)
    .join("\n");
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n...[truncated]` : text;
}

export function stripMandateGate(messages) {
  if (!Array.isArray(messages)) return;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (String(getMessageId(msg) ?? "").startsWith(INTENT_NOTICE_PREFIX)) {
      messages.splice(i, 1);
      continue;
    }
    const parts = getParts(msg);
    if (parts.length === 0) continue;
    const filtered = parts.filter((p) => !isMandateTaggedPart(p));
    if (filtered.length !== parts.length) {
      if (filtered.length === 0) {
        messages.splice(i, 1);
      } else {
        setParts(msg, filtered);
      }
    }
  }
}

function isSubagentOrTaskReturnText(text) {
  if (typeof text !== "string") return false;
  return (
    /^\s*<subagent\s+sessionID="ses_[A-Za-z0-9_-]+"\s+state="(?:completed|error|cancelled)"/i.test(text) ||
    /^\s*<task\s+id="ses_[A-Za-z0-9_-]+"\s+state="(?:completed|error|cancelled)"/i.test(text) ||
    /^\s*<subagent-update\b/i.test(text)
  );
}

function isCompactionCheckpointText(text) {
  return typeof text === "string" && /^\s*<conversation-checkpoint>/i.test(text);
}

function isInternalSyntheticMessage(msg) {
  if (getRole(msg) !== "user") return false;
  const id = String(getMessageId(msg) ?? "");
  if (id.startsWith(INTENT_NOTICE_PREFIX)) return false;
  if (id.startsWith(INTERNAL_SYNTHETIC_PREFIX)) return true;
  if (msg?.metadata?.[INTERNAL_INITIATOR_KEY] === true || msg?.metadata?.[SPLIT_INITIATOR_KEY] === true) return true;
  const parts = getParts(msg);
  return parts.some(
    (p) =>
      p?.metadata?.[INTERNAL_INITIATOR_KEY] === true ||
      p?.metadata?.[SPLIT_INITIATOR_KEY] === true ||
      (typeof p?.text === "string" &&
        (p.text.includes("<!-- SLIM_INTERNAL_INITIATOR -->") ||
          p.text.includes("[ALIGNS.md — 巨石文件拆分]") ||
          p.text.includes("[ALIGNS.md — 巨石文件拆分第二棒]") ||
          /^\s*<subagent-update\b/i.test(p.text)))
  );
}

function isToolMediaAttachmentMessage(msg) {
  if (getRole(msg) !== "user") return false;
  const parts = getParts(msg);
  return parts.some(
    (p) =>
      p?.type === "text" &&
      typeof p.text === "string" &&
      p.text.startsWith("Attached media from tool result:")
  );
}

function isGenuineUserMessage(msg) {
  if (getRole(msg) !== "user") return false;
  if (isInternalSyntheticMessage(msg)) return false;
  if (isToolMediaAttachmentMessage(msg)) return false;
  if (msg?.metadata?.source === "subagent" || msg?.metadata?.source === "shell") return false;
  const parts = getParts(msg);
  if (parts.length === 0) return false;
  return parts.some((p) => {
    if (!p || typeof p !== "object") return false;
    if (p.synthetic === true) return false;
    if (
      p.metadata?.[OMO_BOARD_KEY] === true ||
      p.metadata?.[INTERNAL_INITIATOR_KEY] === true ||
      p.metadata?.[MANDATE_GATE_KEY] === true ||
      p.metadata?.source === "subagent"
    ) {
      return false;
    }
    if (p.type === "file" || p.type === "image" || p.type === "media") return true;
    if (p.type === "text" && typeof p.text === "string") {
      if (p.text.startsWith("Attached media from tool result:")) return false;
      if (isCompactionCheckpointText(p.text)) return false;
      return !isSubagentOrTaskReturnText(p.text);
    }
    return false;
  });
}

function extractToolCallInfo(part) {
  if (!part || typeof part !== "object") return null;
  if (part.type === "tool") {
    const rawTool = part.tool ?? part.name ?? part.toolName ?? "";
    if (!rawTool) return null;
    const input = part.state?.input ?? part.input ?? part.args ?? {};
    let output = "";
    if (typeof part.state?.output === "string") output = part.state.output;
    else if (typeof part.output === "string") output = part.output;
    else if (Array.isArray(part.state?.content)) {
      output = part.state.content.map((c) => (typeof c?.text === "string" ? c.text : "")).join("\n");
    }
    return {
      kind: "v1-tool",
      tool: String(rawTool).toLowerCase(),
      id: part.id ?? part.callID,
      status: part.state?.status ?? part.status,
      metaSessionID: part.state?.metadata?.sessionID,
      metaStatus: part.state?.metadata?.status,
      input,
      output
    };
  }
  if (part.type === "tool-call") {
    const name = part.toolName ?? part.name ?? part.tool ?? "";
    const input = part.args ?? part.input ?? {};
    return {
      kind: "v2-call",
      tool: String(name).toLowerCase(),
      id: part.toolCallId ?? part.id,
      input
    };
  }
  if (part.type === "tool-result") {
    const name = part.toolName ?? part.name ?? part.tool ?? "";
    let output = "";
    if (typeof part.output === "string") output = part.output;
    else if (typeof part.result === "string") output = part.result;
    else if (typeof part.result?.value === "string") output = part.result.value;
    else if (Array.isArray(part.result?.value)) {
      output = part.result.value.map((c) => (typeof c?.text === "string" ? c.text : "")).join("\n");
    } else if (Array.isArray(part.result?.content)) {
      output = part.result.content.map((c) => (typeof c?.text === "string" ? c.text : "")).join("\n");
    } else if (typeof part.text === "string") output = part.text;
    else if (Array.isArray(part.content)) {
      output = part.content.map((c) => (typeof c?.text === "string" ? c.text : "")).join("\n");
    }
    return {
      kind: "v2-result",
      tool: String(name).toLowerCase(),
      id: part.toolCallId ?? part.id,
      output
    };
  }
  return null;
}

function getSubagentTarget(input) {
  if (!input || typeof input !== "object") return "";
  const raw = input.agent ?? input.subagent_type ?? "";
  return typeof raw === "string" ? raw.toLowerCase().trim() : "";
}

export function analyzeAuditWindow(messages, maxWindows = MAX_WINDOWS_PER_TURN) {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isGenuineUserMessage(messages[i])) {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx === -1) {
    return { inAuditWindow: false, userRawText: "", workerReportText: "", alignerRejected: false, closedWindows: [], pendingBackgroundIds: new Set(), duplicateNotificationIndices: [], returnedSessionsSinceDispatch: [], maxWindows };
  }

  const userRawText = extractMessagePlainText(messages[lastUserIdx], 4000);
  const sessionToAgent = new Map();
  const descToAgent = new Map();
  const callIdToAgent = new Map();
  const callIdToInput = new Map();
  const lastSessionByAgent = { designer: null, fixer: null };
  let lastDispatchedAgent = "";

  for (let i = 0; i < messages.length; i++) {
    for (const part of getParts(messages[i])) {
      const info = extractToolCallInfo(part);
      if (!info) continue;
      if ((info.tool === "subagent" || info.tool === "task") && info.input && Object.keys(info.input).length > 0) {
        if (info.id) callIdToInput.set(info.id, info.input);
        const agent = getSubagentTarget(info.input);
        if (agent) {
          lastDispatchedAgent = agent;
          if (info.id) callIdToAgent.set(info.id, agent);
          if (typeof info.input.sessionID === "string") {
            sessionToAgent.set(info.input.sessionID, agent);
            if (WRITER_AGENTS.has(agent)) lastSessionByAgent[agent] = info.input.sessionID;
          }
          if (typeof info.metaSessionID === "string") {
            sessionToAgent.set(info.metaSessionID, agent);
            if (WRITER_AGENTS.has(agent)) lastSessionByAgent[agent] = info.metaSessionID;
          }
          if (typeof info.input.description === "string") descToAgent.set(info.input.description.trim(), agent);
        }
        if (info.output) {
          const m = /sessionID[:=]\s*"?(ses_[A-Za-z0-9_-]+)"?/.exec(info.output);
          if (m && agent) {
            sessionToAgent.set(m[1], agent);
            if (WRITER_AGENTS.has(agent)) lastSessionByAgent[agent] = m[1];
          }
        }
      } else if (info.kind === "v2-result" && (info.tool === "subagent" || info.tool === "task")) {
        const agent = (info.id && callIdToAgent.get(info.id)) || lastDispatchedAgent;
        const m = /sessionID[:=]\s*"?(ses_[A-Za-z0-9_-]+)"?/.exec(info.output || "");
        if (m && agent) {
          sessionToAgent.set(m[1], agent);
          if (WRITER_AGENTS.has(agent)) lastSessionByAgent[agent] = m[1];
        }
      }
    }
  }

  // Scan ALL messages to find all closed audit windows for dehydration
  const closedWindows = [];
  let openWindowStart = -1;
  let openWindowSessionID = null;
  let hasDispatchSinceWindowOpen = true;
  const windowReturnedSessions = new Set();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const isDuplicateCompletion = !hasDispatchSinceWindowOpen && getParts(msg).some((part) => {
      const match = typeof part?.text === "string" && (
        /^\s*<subagent\s+sessionID="(ses_[A-Za-z0-9_-]+)"\s+state="completed"/i.exec(part.text) ||
        /^\s*<task\s+id="(ses_[A-Za-z0-9_-]+)"\s+state="completed">/i.exec(part.text)
      );
      return match && windowReturnedSessions.has(match[1]);
    });
    if (openWindowStart !== -1 && !isDuplicateCompletion && (isGenuineUserMessage(msg) || isInternalSyntheticMessage(msg))) {
      closedWindows.push({ startIdx: openWindowStart, endIdx: i });
      openWindowStart = -1;
    }
    if (isGenuineUserMessage(msg)) windowReturnedSessions.clear();

    const parts = getParts(msg);
    const msgMetaAgent = typeof msg?.metadata?.agent === "string" ? msg.metadata.agent.toLowerCase() : "";

    for (const part of parts) {
      const partMetaAgent = typeof part?.metadata?.agent === "string" ? part.metadata.agent.toLowerCase() : msgMetaAgent;
      if (part?.type === "text" && typeof part.text === "string") {
        const subMatch =
          /^\s*<subagent\s+sessionID="(ses_[A-Za-z0-9_-]+)"\s+state="completed"(?:\s+description="([^"]*)")?/i.exec(part.text) ||
          /^\s*<task\s+id="(ses_[A-Za-z0-9_-]+)"\s+state="completed">/i.exec(part.text);
        if (subMatch) {
          const sesId = subMatch[1];
          if ((sesId === openWindowSessionID || windowReturnedSessions.has(sesId)) && !hasDispatchSinceWindowOpen) {
            continue;
          }
          const desc = (subMatch[2] ?? "").trim();
          const agent = partMetaAgent || sessionToAgent.get(sesId) || descToAgent.get(desc) || "unknown";
          if (!NON_WRITER_AGENTS.has(agent) && (WRITER_AGENTS.has(agent) || agent === "unknown")) {
            if (openWindowStart !== -1 && openWindowStart < i) {
              closedWindows.push({ startIdx: openWindowStart, endIdx: i });
            }
            openWindowStart = i;
            openWindowSessionID = sesId;
            windowReturnedSessions.add(sesId);
            hasDispatchSinceWindowOpen = false;
          }
        }
      }

      const info = extractToolCallInfo(part);
      if (!info) continue;
      if (info.tool === "subagent" || info.tool === "task") {
        const effectiveInput = (info.id && callIdToInput.get(info.id)) || info.input || {};
        const target = getSubagentTarget(effectiveInput) || (info.id && callIdToAgent.get(info.id)) || "";
        const isBackgroundLaunch = typeof info.output === "string" && info.output.includes("working in the background");
        const isForegroundCompleted =
          effectiveInput?.background === false &&
          ((info.kind === "v1-tool" && info.status === "completed") || info.kind === "v2-result");

        if (info.kind === "v2-call" || info.kind === "v1-tool" || isBackgroundLaunch) {
          windowReturnedSessions.clear();
          hasDispatchSinceWindowOpen = true;
        }

        if (WRITER_AGENTS.has(target) && isForegroundCompleted) {
          const sesMatch = /sessionID[:=]\s*"?(ses_[A-Za-z0-9_-]+)"?/.exec(info.output || "");
          const fgSesId = sesMatch ? sesMatch[1] : effectiveInput?.sessionID ?? null;
          if (openWindowStart !== -1 && openWindowStart < i) {
            closedWindows.push({ startIdx: openWindowStart, endIdx: i });
          }
          openWindowStart = i;
          openWindowSessionID = fgSesId;
          if (fgSesId) windowReturnedSessions.add(fgSesId);
          hasDispatchSinceWindowOpen = false;
        } else if (openWindowStart !== -1 && (info.kind === "v2-call" || info.kind === "v1-tool" || isBackgroundLaunch)) {
          closedWindows.push({ startIdx: openWindowStart, endIdx: i });
          openWindowStart = -1;
        }
      } else if (info.tool === "question" && openWindowStart !== -1) {
        closedWindows.push({ startIdx: openWindowStart, endIdx: i });
        openWindowStart = -1;
      }
    }
  }

  // Analyze the current turn (after lastUserIdx)
  let activeReturnWatermark = null;
  let activeWorkerReportText = "";
  let alignerRejected = false;
  let activeReturnSessionID = null;
  let activeReturnAgent = null;
  let activeReturnIdx = -1;
  let windowClosedByAction = false;
  let completedAuditWindowsInTurn = 0;
  let hasSplitInitiatorInTurn = false;
  let dispatchedSinceLastReturn = true;
  const pendingBackgroundIds = new Set();
  const turnReturnedSessionsSinceDispatch = new Set();
  const duplicateNotificationIndices = [];

  for (let i = lastUserIdx + 1; i < messages.length; i++) {
    const msg = messages[i];
    if (isInternalSyntheticMessage(msg)) {
      const msgParts = getParts(msg);
      if (
        msg?.metadata?.[SPLIT_INITIATOR_KEY] === true ||
        msgParts.some(
          (p) =>
            p?.metadata?.[SPLIT_INITIATOR_KEY] === true ||
            (typeof p?.text === "string" && (p.text.includes("[ALIGNS.md — 巨石文件拆分]") || p.text.includes("[ALIGNS.md — 巨石文件拆分第二棒]")))
        )
      ) {
        hasSplitInitiatorInTurn = true;
        if (activeReturnWatermark) {
          windowClosedByAction = true;
        }
      }
    }

    const parts = getParts(msg);
    const msgMetaAgent = typeof msg?.metadata?.agent === "string" ? msg.metadata.agent.toLowerCase() : "";

    for (let pIdx = 0; pIdx < parts.length; pIdx++) {
      const part = parts[pIdx];
      const partMetaAgent = typeof part?.metadata?.agent === "string" ? part.metadata.agent.toLowerCase() : msgMetaAgent;

      if (part?.type === "text" && typeof part.text === "string") {
        const termMatch =
          /^\s*<subagent\s+sessionID="(ses_[A-Za-z0-9_-]+)"\s+state="(completed|error|cancelled)"(?:\s+description="([^"]*)")?/i.exec(part.text) ||
          /^\s*<task\s+id="(ses_[A-Za-z0-9_-]+)"\s+state="(completed|error|cancelled)">/i.exec(part.text);

        if (termMatch) {
          const sesId = termMatch[1];
          const stateStr = termMatch[2].toLowerCase();
          pendingBackgroundIds.delete(sesId);
          if (stateStr === "completed") {
            if ((sesId === activeReturnSessionID || turnReturnedSessionsSinceDispatch.has(sesId)) && !dispatchedSinceLastReturn) {
              duplicateNotificationIndices.push(i);
              continue;
            }
            const desc = (termMatch[3] ?? "").trim();
            const agent = partMetaAgent || sessionToAgent.get(sesId) || descToAgent.get(desc) || "unknown";
            if (agent === "aligner") {
              if (activeReturnWatermark) windowClosedByAction = true;
              if (/\[ALIGN_REJECT\]/i.test(part.text)) alignerRejected = true;
              if (/\[ALIGN_PASS\]/i.test(part.text)) alignerRejected = false;
            }
            if (!NON_WRITER_AGENTS.has(agent) && (WRITER_AGENTS.has(agent) || agent === "unknown")) {
              activeReturnWatermark = `subagent:${sesId}:${getMessageId(msg) ?? i}`;
              activeWorkerReportText = part.text.trim().slice(0, 6000);
              alignerRejected = false;
              activeReturnSessionID = sesId;
              turnReturnedSessionsSinceDispatch.add(sesId);
              activeReturnAgent = agent === "unknown" ? "designer/fixer" : agent;
              activeReturnIdx = i;
              windowClosedByAction = false;
              dispatchedSinceLastReturn = false;
              completedAuditWindowsInTurn += 1;
            }
          }
        } else if (part.text.includes("<completed-job>") && /(designer|fixer)/i.test(part.text)) {
          const taskMatch = /task:\s*([^\s\r\n]+)/.exec(part.text);
          const sesId = taskMatch ? taskMatch[1] : `job-${i}`;
          pendingBackgroundIds.delete(sesId);
          if (sesId !== activeReturnSessionID || dispatchedSinceLastReturn) {
            activeReturnWatermark = `job:${sesId}:${getMessageId(msg) ?? i}`;
            activeWorkerReportText = part.text.trim().slice(0, 6000);
            alignerRejected = false;
            activeReturnSessionID = sesId;
            activeReturnAgent = "designer/fixer";
            activeReturnIdx = i;
            windowClosedByAction = false;
            dispatchedSinceLastReturn = false;
            completedAuditWindowsInTurn += 1;
          }
        }
      }

      const info = extractToolCallInfo(part);
      if (!info) continue;

      if (info.tool === "subagent" || info.tool === "task") {
        const effectiveInput = (info.id && callIdToInput.get(info.id)) || info.input || {};
        const target = getSubagentTarget(effectiveInput) || (info.id && callIdToAgent.get(info.id)) || "";
        const isBackgroundLaunch = typeof info.output === "string" && info.output.includes("working in the background");
        if (isBackgroundLaunch) {
          const sesMatch = /sessionID[:=]\s*"?(ses_[A-Za-z0-9_-]+)"?/.exec(info.output || "");
          if (sesMatch) pendingBackgroundIds.add(sesMatch[1]);
        }
        if (info.kind === "v2-call" || info.kind === "v1-tool" || isBackgroundLaunch) {
          turnReturnedSessionsSinceDispatch.clear();
          dispatchedSinceLastReturn = true;
          if (WRITER_AGENTS.has(target)) alignerRejected = false;
        }
        if (target === "aligner") {
          if (activeReturnWatermark) windowClosedByAction = true;
          const alignerText = String(info.output || "");
          if (/\[ALIGN_REJECT\]/i.test(alignerText)) alignerRejected = true;
          if (/\[ALIGN_PASS\]/i.test(alignerText)) alignerRejected = false;
        }
        const isForegroundCompleted =
          effectiveInput?.background === false &&
          ((info.kind === "v1-tool" && info.status === "completed") || info.kind === "v2-result");

        if (WRITER_AGENTS.has(target) && isForegroundCompleted) {
          const sesMatch = /sessionID[:=]\s*"?(ses_[A-Za-z0-9_-]+)"?/.exec(info.output || "");
          activeReturnSessionID = sesMatch ? sesMatch[1] : effectiveInput?.sessionID ?? null;
          if (activeReturnSessionID) turnReturnedSessionsSinceDispatch.add(activeReturnSessionID);
          activeReturnAgent = target;
          activeReturnWatermark = `fg:${info.id ?? i}`;
          activeWorkerReportText = String(info.output || "").trim().slice(0, 6000);
          alignerRejected = false;
          activeReturnIdx = i;
          windowClosedByAction = false;
          dispatchedSinceLastReturn = false;
          completedAuditWindowsInTurn += 1;
        } else if (activeReturnWatermark && (info.kind === "v2-call" || info.kind === "v1-tool" || isBackgroundLaunch)) {
          windowClosedByAction = true;
        }
      } else if (info.tool === "question" && activeReturnWatermark) {
        windowClosedByAction = true;
      }
    }
  }

  const withinCap = completedAuditWindowsInTurn > 0 && completedAuditWindowsInTurn <= maxWindows;
  return {
    inAuditWindow: Boolean(activeReturnWatermark) && !windowClosedByAction && withinCap,
    userRawText,
    workerReportText: activeWorkerReportText,
    alignerRejected: Boolean(alignerRejected && activeReturnWatermark),
    watermark: activeReturnWatermark,
    returnedSessionID: activeReturnSessionID,
    returnedAgent: activeReturnAgent,
    windowCount: completedAuditWindowsInTurn,
    maxWindows,
    returnedSessionsSinceDispatch: Array.from(turnReturnedSessionsSinceDispatch),
    turnId: getMessageId(messages[lastUserIdx]) ?? `turn-${lastUserIdx}`,
    closedWindows,
    pendingBackgroundIds,
    duplicateNotificationIndices,
    hasSplitInitiatorInTurn,
    lastSessionByAgent
  };
}

export function neutralizeDuplicateTaskNotifications(messages, duplicateNotificationIndices) {
  if (!Array.isArray(messages) || !Array.isArray(duplicateNotificationIndices) || duplicateNotificationIndices.length === 0) return;
  for (const idx of duplicateNotificationIndices) {
    if (messages[idx]) {
      setParts(messages[idx], [{
        type: "text",
        synthetic: true,
        text: "<system-reminder>[aligns-gate: 重复的子任务完成通知已自动折叠忽略，请勿重复审稿，直接结束当前回复。]</system-reminder>"
      }]);
    }
  }
}

export function dehydrateClosedAuditWindows(messages, closedWindows) {
  if (!Array.isArray(messages) || !Array.isArray(closedWindows) || closedWindows.length === 0) return;

  const isIndexInClosedWindow = (idx) =>
    closedWindows.some((w) => idx > w.startIdx && idx < w.endIdx);

  for (let i = 0; i < messages.length; i++) {
    if (!isIndexInClosedWindow(i)) continue;
    const msg = messages[i];
    const role = getRole(msg);
    const parts = getParts(msg);
    if (parts.length === 0) continue;

    if (role === "user" && !isGenuineUserMessage(msg) && !isSubagentOrTaskReturnText(parts[0]?.text ?? "")) {
      const hasMedia = parts.some(
        (p) =>
          p?.type === "media" ||
          p?.type === "file" ||
          p?.type === "image" ||
          (p?.type === "text" && typeof p.text === "string" && p.text.startsWith("Attached media from tool result:"))
      );
      if (hasMedia) {
        setParts(msg, [{ type: "text", text: DEHYDRATED_TEXT }]);
        continue;
      }
    }

    let mutatedParts = null;
    for (let pIdx = 0; pIdx < parts.length; pIdx++) {
      const part = parts[pIdx];
      if (!part || typeof part !== "object") continue;

      if (part.type === "tool-result") {
        const toolName = String(part.toolName ?? part.name ?? part.tool ?? "").toLowerCase();
        if (PRESERVED_AUDIT_TOOLS.has(toolName)) continue;

        if (part.result && typeof part.result === "object") {
          const val = part.result.value;
          const isLargeText = typeof val === "string" && val.length > 180;
          const isContentArr = Array.isArray(val);
          if (isLargeText || isContentArr) {
            const nextResult = { type: "text", value: DEHYDRATED_TEXT };
            try {
              part.result = nextResult;
            } catch {}
            mutatedParts ??= [...parts];
            mutatedParts[pIdx] = { ...part, result: nextResult };
          }
        } else if (typeof part.output === "string" && part.output.length > 180) {
          try {
            part.output = DEHYDRATED_TEXT;
          } catch {}
          mutatedParts ??= [...parts];
          mutatedParts[pIdx] = { ...part, output: DEHYDRATED_TEXT };
        } else if (typeof part.result === "string" && part.result.length > 180) {
          try {
            part.result = DEHYDRATED_TEXT;
          } catch {}
          mutatedParts ??= [...parts];
          mutatedParts[pIdx] = { ...part, result: DEHYDRATED_TEXT };
        }
      } else if (part.type === "tool" && part.state?.status === "completed") {
        const toolName = String(part.tool ?? part.name ?? part.toolName ?? "").toLowerCase();
        if (PRESERVED_AUDIT_TOOLS.has(toolName)) continue;
        if (typeof part.state.output === "string" && part.state.output.length > 180) {
          part.state.output = DEHYDRATED_TEXT;
        }
        if (Array.isArray(part.state.content)) {
          const totalLen = part.state.content.reduce((acc, c) => acc + (c?.text?.length ?? 500), 0);
          if (totalLen > 180) {
            part.state.content = [{ type: "text", text: DEHYDRATED_TEXT }];
          }
        }
      }
    }
    if (mutatedParts) {
      setParts(msg, mutatedParts);
    }
  }
}

function buildReminderText(mandateContent, state, config = {}) {
  if (state.alignerRejected) {
    const sessionHint = state.returnedSessionID
      ? `, sessionID="${state.returnedSessionID}"`
      : "";
    return `<system-reminder>
[ALIGNS.md — @aligner 审稿未通过]
请立即调用 \`subagent(agent="${state.returnedAgent || "fixer"}"${sessionHint})\`，将 @aligner 指出的缺陷原样打回原会话返工。
</system-reminder>`;
  }
  if (config.useAligner !== false) {
    const targetHint = state.returnedSessionID
      ? `刚交卷: @${state.returnedAgent} · sessionID: \`${state.returnedSessionID}\``
      : `刚交卷: @${state.returnedAgent}`;
    return `<system-reminder>
[ALIGNS.md — 第一棒：派发 @aligner 独立审稿 · ${state.windowCount}/${state.maxWindows ?? MAX_WINDOWS_PER_TURN}]
${targetHint}
请调用 \`subagent(agent="aligner", background=false, description="Audit @${state.returnedAgent}")\` 独立审稿。插件会自动注入用户原话、Worker 报告与 ALIGNS.md 红线；prompt 只需传预览地址或测试命令，勿复述长文或自行截图。
</system-reminder>`;
  }
  const targetHint = state.returnedSessionID
    ? `刚交卷: @${state.returnedAgent} · sessionID: \`${state.returnedSessionID}\`，不达标请直接复用此 sessionID 打回返工`
    : `刚交卷: @${state.returnedAgent}`;

  return `<system-reminder>
[ALIGNS.md — 审稿窗口期已激活 · ${state.windowCount}/${state.maxWindows ?? MAX_WINDOWS_PER_TURN}]
${targetHint}

${mandateContent}
</system-reminder>`;
}

export function applyMandateGateToV1Messages(messages, workDir) {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  stripMandateGate(messages);

  const { config } = resolveMandateConfig(workDir);
  const state = analyzeAuditWindow(messages, config.maxWindows);
  dehydrateClosedAuditWindows(messages, state.closedWindows);
  neutralizeDuplicateTaskNotifications(messages, state.duplicateNotificationIndices);

  if (!state.inAuditWindow && !state.alignerRejected) return false;

  const mandateContent = readBoundedMandate(workDir, state.returnedAgent);
  if (!mandateContent) return false;

  const sessionID = getSessionId(messages[messages.length - 1], "default");
  const text = buildReminderText(mandateContent, state, config);

  messages.push({
    info: {
      id: `mandate-gate-${sessionID}`,
      sessionID,
      role: "user",
      agent: "orchestrator"
    },
    parts: [
      {
        type: "text",
        synthetic: true,
        text,
        metadata: {
          [OMO_BOARD_KEY]: true,
          [MANDATE_GATE_KEY]: true
        }
      }
    ]
  });
  return true;
}

export function applyMandateGateToV2Event(event, workDir) {
  const messages = event?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return false;
  stripMandateGate(messages);

  if (event.agent && event.agent !== "orchestrator") return false;

  const { config } = resolveMandateConfig(workDir);
  const state = analyzeAuditWindow(messages, config.maxWindows);
  if (event.sessionID) {
    lastSessionState.set(event.sessionID, {
      ...state,
      workDir,
      updatedAt: Date.now()
    });
  }

  dehydrateClosedAuditWindows(messages, state.closedWindows);
  neutralizeDuplicateTaskNotifications(messages, state.duplicateNotificationIndices);

  if (!state.inAuditWindow && !state.alignerRejected) return false;

  const mandateContent = readBoundedMandate(workDir, state.returnedAgent);
  if (!mandateContent) return false;

  const text = buildReminderText(mandateContent, state, config);

  messages.push({
    id: `mandate-gate-${event.sessionID ?? "default"}`,
    sessionID: event.sessionID,
    role: "user",
    agent: "orchestrator",
    content: [
      {
        type: "text",
        synthetic: true,
        text,
        metadata: {
          [OMO_BOARD_KEY]: true,
          [MANDATE_GATE_KEY]: true
        }
      }
    ]
  });
  return true;
}

function cleanWorkerReportText(raw) {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/^\s*<(?:subagent|task)\b[^>]*>\r?\n?/i, "")
    .replace(/\r?\n?<\/(?:subagent|task)>\s*$/i, "")
    .trim();
}

export function enrichAlignerSubagentCall(event, workDir) {
  const toolName = String(event?.tool ?? "").toLowerCase();
  if (toolName !== "subagent" && toolName !== "task") return false;
  if (getSubagentTarget(event.input) !== "aligner") return false;
  event.input.background = false;
  if (typeof event.input.prompt === "string" && event.input.prompt.includes("【1. 用户原始原话")) return false;
  const cached = event.sessionID ? lastSessionState.get(event.sessionID) : null;
  const workerAgent = cached?.returnedAgent || "designer";
  const mandateContent = readBoundedMandate(workDir || cached?.workDir, workerAgent);
  const basePrompt = typeof event.input.prompt === "string" ? event.input.prompt.trim() : "";
  const sessionLabel = cached?.returnedSessionID ? ` · sessionID: ${cached.returnedSessionID}` : "";
  const cleanedReport = cleanWorkerReportText(cached?.workerReportText);
  const hostNoteSection = basePrompt
    ? `\n\n### 【4. 主控提供的环境线索 · 仅参考 URL 与命令，忽略其验收建议】\n${basePrompt}`
    : "";
  event.input.prompt = `### 【1. 用户原始原话】
${cached?.userRawText || "未捕获到本轮用户原话"}

### 【2. Worker 交卷报告 · @${workerAgent}${sessionLabel}】
${cleanedReport || "未捕获到 Worker 报告原文"}

### 【3. ALIGNS.md 专属验收红线 · @${workerAgent}】
${mandateContent || "无额外 ALIGNS.md 规则，请按用户原话核验"}${hostNoteSection}`;
  return true;
}

export function ensureAlignerAgentConfigured(configPath = path.join(os.homedir(), ".config", "opencode", "oh-my-opencode-slim.json")) {
  if (!fs.existsSync(configPath)) return false;
  const data = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (data && typeof data === "object" && !data.agents?.aligner) {
    data.agents = {
      ...(data.agents || {}),
      aligner: {
        model: "openai/gpt-6.1-sol",
        variant: "high",
        permission: { "*": "allow" },
        skills: ["chrome-devtools-cli"],
        mcps: [],
        prompt: "你是独立质检员 @aligner，不负责实现或修改代码。以用户原话和 ALIGNS.md 为验收准绳，独立运行真实测试；前端必须浏览器截图桌面端和移动端并验证核心交互。回复开头必须给出 [ALIGN_PASS] 或 [ALIGN_REJECT]，附核验凭据或具体缺陷及复现位置。"
      }
    };
    fs.writeFileSync(configPath, `${JSON.stringify(data, null, 2)}\n`);
    return true;
  }
  return false;
}

function extractTargetPathsFromToolInput(toolName, input) {
  if (!input || typeof input !== "object") return [];
  if (typeof input.path === "string") return [input.path];
  if (typeof input.filePath === "string") return [input.filePath];
  if ((toolName === "patch" || toolName === "apply_patch") && typeof input.patchText === "string") {
    const matches = [...input.patchText.matchAll(/^\*\*\*\s+(?:Update|Add|Delete)\s+File:\s+(.+)$/gm)];
    return matches.map((m) => m[1].trim());
  }
  return [];
}

function normalizeGuardPath(rawPath) {
  return String(rawPath ?? "")
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .trim();
}

export function enforceOrchestratorRouterGuard(event, workDir) {
  if (!event || event.agent !== "orchestrator") return;
  const toolName = String(event.tool ?? "").toLowerCase();
  if (toolName !== "edit" && toolName !== "write" && toolName !== "patch" && toolName !== "apply_patch") {
    return;
  }
  const paths = extractTargetPathsFromToolInput(toolName, event.input);
  const codePaths = paths.filter((p) => !ALLOWED_ORCHESTRATOR_EDIT_RE.test(p) && CODE_FILE_EXT_RE.test(p));
  if (codePaths.length === 0) return;
  const directory = workDir ?? lastSessionState.get(event.sessionID)?.workDir ?? event.directory ?? process.cwd();
  if (!resolveMandateConfig(directory).config.routerGuard) return;

  const sessionKey = event.sessionID ?? "default";
  const keys = codePaths.map((p) => `${sessionKey}::${normalizeGuardPath(p)}`);
  const allArmed = keys.every((k) => routerWritePassTokens.has(k));

  if (allArmed) {
    // 2nd attempt: consume the one-time pass and immediately reset so the 3rd attempt will intercept again
    for (const k of keys) {
      routerWritePassTokens.delete(k);
    }
    return;
  }

  // 1st attempt (or 3rd attempt after reset): arm one-time pass for the next retry on this file and throw warning
  for (const k of keys) {
    if (routerWritePassTokens.size >= 512) {
      const oldest = routerWritePassTokens.keys().next().value;
      if (oldest !== undefined) routerWritePassTokens.delete(oldest);
    }
    routerWritePassTokens.set(k, Date.now());
  }

  const prev = event.sessionID ? lastSessionState.get(event.sessionID)?.lastSessionByAgent : null;
  const hintParts = [];
  if (prev?.designer) hintParts.push(`@designer · sessionID: \`${prev.designer}\``);
  if (prev?.fixer) hintParts.push(`@fixer · sessionID: \`${prev.fixer}\``);
  const reuseHint = hintParts.length > 0 ? ` 请优先复用会话：${hintParts.join(" 或 ")}。` : "";
  const targetLabel = codePaths.join(", ");

  throw new Error(
    `[审慎写入确认] 主控不应直接修改业务源码 ${targetLabel}，常规功能与 UI 改动请调用 subagent 派发给 @fixer 或 @designer。${reuseHint}\n若确属几行内的极小修补，再次对该文件调用 ${toolName} 即可放行一次，放行后立即恢复拦截。`
  );
}

export async function maybeEmitIntentAlignNotice(ctx, sessionID, state, workDir) {
  if (!sessionID || !state?.inAuditWindow || !state?.watermark) return false;
  if (typeof ctx?.session?.synthetic !== "function") return false;
  const instanceDir = ctx?.location?.directory || ctx?.directory;
  if (instanceDir && workDir && path.resolve(instanceDir) !== path.resolve(workDir)) return false;
  if (!findMandateFile(workDir)) return false;
  const key = `${sessionID}::${state.watermark}`;
  if (notifiedWatermarks.has(key)) return false;
  if (notifiedWatermarks.size >= 512) {
    const oldest = notifiedWatermarks.values().next().value;
    if (oldest !== undefined) notifiedWatermarks.delete(oldest);
  }
  notifiedWatermarks.add(key);
  const messageID = `${INTENT_NOTICE_PREFIX}${crypto.randomUUID().replace(/-/g, "")}`;
  await ctx.session.synthetic({
    sessionID,
    id: messageID,
    text: `${INTENT_NOTICE_MARKER}\n[ALIGNS.md — 人类意图对齐审稿窗口 · ${state.windowCount}/${state.maxWindows ?? MAX_WINDOWS_PER_TURN} · @${state.returnedAgent}]`,
    description: "aligns-gate: 人类意图对齐",
    metadata: { [OMO_BOARD_KEY]: true, [MANDATE_GATE_KEY]: true },
    delivery: "steer",
    resume: false
  });
  return true;
}

async function maybeSendPostAuditSplitBaton(ctx, sessionID) {
  if (!sessionID || typeof ctx?.session?.synthetic !== "function") return false;
  if (inFlightSplitSessions.has(sessionID)) return false;

  const cached = lastSessionState.get(sessionID);
  if (!cached) return false;
  const { hasMandate, config } = resolveMandateConfig(cached.workDir);
  if (!config.autoSplit) return false;

  const instanceDir = ctx?.location?.directory || ctx?.directory;
  if (instanceDir && cached.workDir && path.resolve(instanceDir) !== path.resolve(cached.workDir)) {
    return false;
  }

  if (
    !hasMandate ||
    cached.windowCount === 0 ||
    cached.hasSplitInitiatorInTurn ||
    splitTriggeredTurns.has(cached.turnId) ||
    (cached.pendingBackgroundIds && cached.pendingBackgroundIds.size > 0)
  ) {
    return false;
  }

  inFlightSplitSessions.add(sessionID);
  try {
    if (typeof ctx?.session?.context === "function") {
      try {
        const history = await ctx.session.context({ sessionID });
        if (Array.isArray(history) && history.length > 0) {
          let lastEntry = null;
          for (let i = history.length - 1; i >= 0; i--) {
            if (history[i]?.type !== "idle") {
              lastEntry = history[i];
              break;
            }
          }
          if (!lastEntry || lastEntry.type !== "assistant") return false;
          const hasPendingTool =
            Array.isArray(lastEntry.content) &&
            lastEntry.content.some((c) => c?.type === "tool" && c?.state?.status === "running");
          if (hasPendingTool) return false;

          for (let i = history.length - 1; i >= 0; i--) {
            const entry = history[i];
            if (entry?.type === "user") break;
            if (
              entry?.type === "synthetic" &&
              (entry?.metadata?.[SPLIT_INITIATOR_KEY] === true ||
                (typeof entry?.text === "string" && (entry.text.includes("[ALIGNS.md — 巨石文件拆分]") || entry.text.includes("[ALIGNS.md — 巨石文件拆分第二棒]"))))
            ) {
              splitTriggeredTurns.add(cached.turnId);
              return false;
            }
          }
        }
      } catch {}
    }

    if (splitTriggeredTurns.has(cached.turnId)) return false;

    const monoliths = scanMonolithicFiles(cached.workDir, config.maxLines);
    if (monoliths.length === 0) return false;

    splitTriggeredTurns.add(cached.turnId);
    if (splitTriggeredTurns.size > 512) {
      const oldest = splitTriggeredTurns.values().next().value;
      if (oldest !== undefined) splitTriggeredTurns.delete(oldest);
    }

    const topList = monoliths
      .slice(0, 5)
      .map((m, idx) => `${idx + 1}. \`${m.file}\` · ${m.lines} 行`)
      .join("\n");
    const topTarget = monoliths[0];
    const fixerHint = cached.lastSessionByAgent?.fixer
      ? `，可复用 @fixer sessionID \`${cached.lastSessionByAgent.fixer}\` 或新建会话`
      : "";

    const text = `<system-reminder>
[ALIGNS.md — 巨石文件拆分]
上一棒审稿已结束，审稿期的截图与工具长输出已自动清理。
扫描发现以下源码文件超过 ${config.maxLines} 行红线：
${topList}

请派发 \`subagent(agent="fixer")\`${fixerHint}，在保持现有行为与测试不变的前提下，将 \`${topTarget.file}\` 按高内聚职责拆分为多个小于 ${config.maxLines} 行的模块并跑通验证。
</system-reminder>
<!-- SLIM_INTERNAL_INITIATOR -->`;

    const messageID = `${SPLIT_SYNTHETIC_PREFIX}${crypto.randomUUID().replace(/-/g, "")}`;
    await ctx.session.synthetic({
      sessionID,
      id: messageID,
      text,
      description: "aligns-gate: 巨石文件拆分",
      metadata: {
        [INTERNAL_INITIATOR_KEY]: true,
        [SPLIT_INITIATOR_KEY]: true
      },
      delivery: "queue",
      resume: true
    });
    return true;
  } finally {
    inFlightSplitSessions.delete(sessionID);
  }
}

export function installSyntheticTaskDeduper(ctx) {
  if (!ctx?.session || typeof ctx.session.synthetic !== "function") return;
  if (ctx.session.synthetic.__alignsGateWrapped) return;
  const origSynthetic = ctx.session.synthetic.bind(ctx.session);
  ctx.session.synthetic = async function alignsGateSyntheticWrapper(payload) {
    if (typeof payload?.text === "string") {
      const match = /^\s*<(?:task\s+id|subagent\s+sessionID)="(ses_[A-Za-z0-9_-]+)"\s+state="(completed|error|cancelled)"/i.exec(payload.text);
      if (match) {
        const parentId = payload.sessionID ?? "default";
        const childId = match[1];
        const stateStr = match[2].toLowerCase();
        const dedupeKey = `${parentId}::${childId}::${stateStr}`;
        const now = Date.now();
        const lastTs = syntheticTaskDedupe.get(dedupeKey);
        const cached = lastSessionState.get(parentId);
        const alreadyReturnedInTurn = stateStr === "completed" && cached && Array.isArray(cached.returnedSessionsSinceDispatch) && cached.returnedSessionsSinceDispatch.includes(childId);
        if ((lastTs !== undefined && now - lastTs < 30000) || alreadyReturnedInTurn) {
          return { deduplicated: true, id: payload.id };
        }
        if (syntheticTaskDedupe.size >= 512) {
          const oldest = syntheticTaskDedupe.keys().next().value;
          if (oldest !== undefined) syntheticTaskDedupe.delete(oldest);
        }
        syntheticTaskDedupe.set(dedupeKey, now);
      }
    }
    return await origSynthetic(payload);
  };
  ctx.session.synthetic.__alignsGateWrapped = true;
}

export default {
  id: "aligns-gate",
  server: async (ctx) => ({
    "experimental.chat.messages.transform": async (_input, output) => {
      applyMandateGateToV1Messages(output?.messages, ctx?.directory || process.cwd());
    }
  }),
  setup: async (ctx) => {
    try { ensureAlignerAgentConfigured(); } catch {}
    installSyntheticTaskDeduper(ctx);
    const disposers = [];

    if (ctx?.tool?.hook) {
      try {
        const beforeReg = await ctx.tool.hook("execute.before", async (event) => {
          const toolName = String(event.tool ?? "").toLowerCase();
          if (toolName === "subagent" || toolName === "task") {
            enrichAlignerSubagentCall(event, await resolveSessionWorkDir(ctx, event.sessionID));
          }
          if ((toolName === "subagent" || toolName === "task") && event.input?.sessionID) {
            const parentId = event.sessionID ?? "default";
            const childId = event.input.sessionID;
            syntheticTaskDedupe.delete(`${parentId}::${childId}::completed`);
            const cached = lastSessionState.get(parentId);
            if (Array.isArray(cached?.returnedSessionsSinceDispatch)) {
              cached.returnedSessionsSinceDispatch = cached.returnedSessionsSinceDispatch.filter((id) => id !== childId);
            }
          }
          if (event.agent === "orchestrator" && ["edit", "write", "patch", "apply_patch"].includes(toolName)) {
            enforceOrchestratorRouterGuard(event, await resolveSessionWorkDir(ctx, event.sessionID));
          }
        });
        if (beforeReg?.dispose) disposers.push(() => beforeReg.dispose());
      } catch {}
    }

    if (ctx?.session?.hook) {
      const ctxReg = await ctx.session.hook("context", async (event) => {
        const workDir = await resolveSessionWorkDir(ctx, event?.sessionID);
        applyMandateGateToV2Event(event, workDir);
        const cached = event?.sessionID ? lastSessionState.get(event.sessionID) : null;
        if (cached?.inAuditWindow) {
          await maybeEmitIntentAlignNotice(ctx, event.sessionID, cached, workDir).catch(() => {});
        }
      });
      if (ctxReg?.dispose) disposers.push(() => ctxReg.dispose());
    }

    if (ctx?.event?.subscribe) {
      try {
        const iter = ctx.event.subscribe({
          types: ["session.execution.succeeded"]
        });
        const iterator = iter?.[Symbol.asyncIterator]?.();
        if (iterator) {
          let stopped = false;
          disposers.push(() => {
            stopped = true;
            try {
              iterator.return?.();
            } catch {}
          });
          (async () => {
            while (!stopped) {
              const next = await iterator.next().catch(() => ({ done: true }));
              if (next.done) break;
              const ev = next.value;
              const props = ev?.data ?? ev?.properties ?? {};
              const sessionID = props.sessionID ?? props.id;
              if (typeof sessionID === "string") {
                await maybeSendPostAuditSplitBaton(ctx, sessionID).catch(() => {});
              }
            }
          })();
        }
      } catch {}
    }

    return async () => {
      for (const dispose of disposers) {
        try {
          await dispose();
        } catch {}
      }
    };
  }
};
