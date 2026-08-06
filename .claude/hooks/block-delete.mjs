#!/usr/bin/env node
/**
 * ⚠️ 生效條件（2026-08-05 實測）：
 *    ✅ 使用者層級 ~/.claude/settings.json 註冊 → 桌面 App 與 CLI 都會執行。
 *    ❌ 專案層級 .claude/settings.json 註冊 → 桌面 App 不執行（host 用 --setting-sources user）。
 *    → 桌面 App 使用者請執行 install.mjs（階段二）把本 hook 裝到使用者層級，才會真正生效。
 *
 * block-delete —— 刪除／覆寫類動作，動作前用白話說明並要求確認。
 * 觸發：PreToolUse, matcher = Bash
 */
import { readHookInput, decide, passThrough } from "./_config.mjs";

const DESTRUCTIVE = [
  { re: /\brm\s+(-\S+\s+)*-\S*r\S*f/i, label: "強制遞迴刪除整個資料夾（rm -rf）", severe: true },
  { re: /\brm\b/, label: "刪除檔案（rm）" },
  { re: /\bRemove-Item\b/i, label: "刪除檔案（Remove-Item）" },
  { re: /\bgit\s+reset\s+--hard/, label: "捨棄所有未提交的修改（git reset --hard）", severe: true },
  { re: /\bgit\s+clean\s+-\S*f/, label: "刪除所有未追蹤的檔案（git clean -f）", severe: true },
  { re: /\btruncate\b/, label: "把檔案內容清空" },
  { re: /\bdd\b[^|]*\bof=/, label: "用 dd 直接覆寫檔案／磁碟", severe: true },
  { re: /(^|[^>])>(?!>)\s*[^\s>|&;]+/, label: "覆寫檔案內容（> 重導向）" },
];

const input = await readHookInput();
const cmd = input?.tool_input?.command ?? "";
if (!cmd.trim()) passThrough();

const hit = DESTRUCTIVE.find((d) => d.re.test(cmd));
if (!hit) passThrough();

// 粗估影響目標（僅供提示，不保證精確）
const targets = cmd
  .split(/\s+/)
  .slice(1)
  .filter((t) => !t.startsWith("-") && /[\w./\\]/.test(t) && !/^[|&;><]/.test(t));
const scope =
  targets.length > 1 ? `約 ${targets.length} 個目標` : targets[0] ? `目標：${targets[0]}` : "目標未能判斷";

const head = hit.severe ? "🛑 高風險動作" : "⚠️ 這個動作可能無法復原";

decide(
  "ask",
  [
    `${head}：${hit.label}`,
    ``,
    `${scope}`,
    `完整指令：${cmd}`,
    ``,
    `建議：如果你不確定這些檔案是不是還需要，請先選「拒絕」，`,
    `然後直接問 Claude「這個指令會刪掉什麼？」再決定。`,
  ].join("\n")
);
