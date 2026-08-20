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

// 訊息設計：重點前置、條列為主、不重複完整指令。
//
// 舊版把「完整指令」與四行建議放在中間，使用者得捲到最下面才看到該怎麼做——
// 而確認視窗本來就會在下半部顯示完整指令，重複一次只是把重點推遠。
// 對沒有技術背景的人，訊息越長越不會讀，讀不到重點跟沒有警示一樣。
const head = hit.severe ? "🛑" : "⚠️";
const lines = [`${head} ${hit.label}`, ``, `・${describeScope(hit, cmd)}`];
if (hit.severe) lines.push("・沒有復原鍵，做了就回不來");
lines.push("・不確定就按「拒絕」，不會有任何損失");

decide("ask", lines.join("\n"));
