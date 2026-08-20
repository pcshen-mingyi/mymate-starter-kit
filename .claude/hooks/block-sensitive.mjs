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
      `🛑 已擋下：這個檔案在受保護資料夾「${dirHit}/」裡`,
      ``,
      `・原始資料、個資、捐款名單只留在本機，不進對話也不外送`,
      `・需要處理的話，先把去識別化的版本另存到其他資料夾`,
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
          `🔑 這看起來是密鑰或憑證檔：${target}`,
          ``,
          `・裡面通常有密碼或存取金鑰，讀了就會進入對話`,
          `・除非你確定需要，建議按「拒絕」`,
        ].join("\n")
      : [
          `⚠️ 這個檔名看起來可能含個人資料：${target}`,
          ``,
          `・裡面真的有個資（姓名、電話、捐款紀錄）→ 按「拒絕」，先去識別化`,
          `・只是檔名剛好有這些字、內容沒有個資 → 可以按「允許」`,
        ].join("\n")
  );
}

passThrough();
