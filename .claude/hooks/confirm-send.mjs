#!/usr/bin/env node
/**
 * ⚠️ 生效條件（2026-08-05 實測）：
 *    ✅ 使用者層級 ~/.claude/settings.json 註冊 → 桌面 App 與 CLI 都會執行。
 *    ❌ 專案層級 .claude/settings.json 註冊 → 桌面 App 不執行（host 用 --setting-sources user）。
 *    → 桌面 App 使用者請執行 install.mjs（階段二）把本 hook 裝到使用者層級，才會真正生效。
 *
 * confirm-send —— 任何「對外送出」動作，送出前一律人工確認。
 * 觸發：PreToolUse, matcher = Bash|WebFetch|mcp__.*
 */
import {
  readHookInput,
  decide,
  passThrough,
  OUTBOUND_CMD_PATTERNS,
  OUTBOUND_TOOL_PATTERNS,
} from "./_config.mjs";

const input = await readHookInput();
const toolName = input?.tool_name ?? "";
const ti = input?.tool_input ?? {};

// 1) Bash 指令類
const cmd = ti.command ?? "";
if (cmd.trim()) {
  const hit = OUTBOUND_CMD_PATTERNS.find((d) => d.re.test(cmd));
  if (hit) {
    decide(
      "ask",
      [
        `📤 這個動作會把東西送出去：${hit.label}`,
        ``,
        `・對方會真的收到，送出去就收不回來`,
        `・不確定就按「拒絕」，我可以先把要送出的內容列給你看`,
      ].join("\n")
    );
  }
}

// 2) MCP 工具類（Slack／Email／發佈…）
if (/^mcp__/.test(toolName)) {
  const hit = OUTBOUND_TOOL_PATTERNS.find((d) => d.re.test(toolName));
  if (hit) {
    decide(
      "ask",
      [
        `📤 這個動作會把東西送出去：${hit.label}`,
        ``,
        `・對方會真的收到，送出去就收不回來`,
        `・不確定就按「拒絕」，我可以先把要送出的內容列給你看`,
      ].join("\n")
    );
  }
}

passThrough();
