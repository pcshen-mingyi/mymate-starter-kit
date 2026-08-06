#!/usr/bin/env node
/**
 * ⚠️ 生效條件（2026-08-05 實測）：
 *    ✅ 使用者層級 ~/.claude/settings.json 註冊 → 桌面 App 與 CLI 都會執行。
 *    ❌ 專案層級 .claude/settings.json 註冊 → 桌面 App 不執行（host 用 --setting-sources user）。
 *    → 桌面 App 使用者請執行 install.mjs（階段二）把本 hook 裝到使用者層級，才會真正生效。
 *
 * block-sensitive —— 敏感檔／個資的讀寫，直接擋下（不給選）。
 * 觸發：PreToolUse, matcher = Read|Write|Edit|NotebookEdit
 * 設計：raw data 永遠留本地，不進入對話與雲端。
 */
import { readHookInput, decide, passThrough, inProtectedDir, matchProtectedFile, SECRET_FILE_PATTERNS } from "./_config.mjs";

const input = await readHookInput();
const ti = input?.tool_input ?? {};
const target = ti.file_path ?? ti.path ?? ti.notebook_path ?? "";
if (!String(target).trim()) passThrough();

const dirHit = inProtectedDir(target);
if (dirHit) {
  decide(
    "deny",
    [
      `🛑 已擋下：這個檔案在受保護資料夾「${dirHit}/」裡。`,
      ``,
      `這類資料（原始資料、個資、捐款人名單）依規定只留在本機，`,
      `不讓它進入對話內容或被送到外部。`,
      ``,
      `如果你確定需要處理這份資料，請先把「去識別化後」的版本另存到其他資料夾。`,
    ].join("\n")
  );
}

const fileHit = matchProtectedFile(target);
if (fileHit) {
  const isSecret = SECRET_FILE_PATTERNS.some((re) => re.test(String(target)));
  decide(
    "ask",
    isSecret
      ? [
          `🔑 這看起來是密鑰／憑證檔：${target}`,
          ``,
          `這類檔案通常含有密碼或存取金鑰，讀取後內容會進入對話。`,
          `除非你確定需要，建議選「拒絕」。`,
        ].join("\n")
      : [
          `⚠️ 這個檔名看起來可能含個人資料：${target}`,
          ``,
          `如果裡面真的有個資（姓名、電話、捐款紀錄），建議選「拒絕」，`,
          `先做去識別化再讓我看。`,
          `如果只是檔名剛好有這些字、內容沒有個資，可以選「允許」。`,
        ].join("\n")
  );
}

passThrough();
