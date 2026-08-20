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
import { matchDestructive, describeScope } from "./_destructive.mjs";

// 危險動作的判斷規則已移到 _destructive.mjs（純函式，可單獨測試）

const input = await readHookInput();
const cmd = input?.tool_input?.command ?? "";
if (!cmd.trim()) passThrough();

const hit = matchDestructive(cmd);
if (!hit) passThrough();

const head = hit.severe ? "🛑 高風險動作" : "⚠️ 這個動作可能無法復原";

decide(
  "ask",
  [
    `${head}：${hit.label}`,
    ``,
    describeScope(hit, cmd),
    ``,
    `完整指令：${cmd}`,
    ``,
    `按「拒絕」不會有任何損失，也不會把事情弄壞——我會停下來，可以再問我`,
    `「這個指令會動到哪些檔案？」看清楚再決定。`,
    `按「允許一次」只放行這一個指令，下次遇到同樣的動作還是會再問你。`,
  ].join("\n")
);
