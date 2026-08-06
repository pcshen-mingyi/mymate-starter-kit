/**
 * ⚠️ 生效條件（2026-08-05 實測）：
 *    ✅ 使用者層級 ~/.claude/settings.json 註冊 → 桌面 App 與 CLI 都會執行。
 *    ❌ 專案層級 .claude/settings.json 註冊 → 桌面 App 不執行（host 用 --setting-sources user）。
 *    → 桌面 App 使用者請執行 install.mjs（階段二）把本 hook 裝到使用者層級，才會真正生效。
 *
 * 共用設定與工具 —— 要調整護欄範圍，改這個檔案就好。
 * 跨平台：純 Node，不依賴 shell；路徑一律用 path 模組處理。
 */

/**
 * 受保護的資料夾名稱（出現在路徑任一層就算命中）。
 * 註：settings.json 的 deny 規則寫成相對路徑（如 Read(./_private/**)），
 *     裝到使用者層級後語意是「相對於每個專案的工作目錄」——
 *     也就是每個專案自己的 _private 都會被擋，這正是預期效果，不是指家目錄。
 */
export const PROTECTED_DIRS = ["_private", "_raw", "raw_data"];

/**
 * 受保護的「密鑰／憑證」檔名樣式 —— 精準匹配，避免誤擋普通原始碼。
 *
 * 設計說明（2026-08-05 修正）：
 * 舊版用 /credential/、/secret/、/password/、/token/ 這類**子字串**比對，
 * 裝到使用者層級後會在所有專案誤擋 token.py、secrets.py、credentials.py、
 * get_token.js 這類再普通不過的原始碼。改為只匹配「看起來真的是密鑰檔」。
 */
export const SECRET_FILE_PATTERNS = [
  /(^|[/\\])\.env(\.|$)/i,                                  // .env / .env.local
  /(^|[/\\])credentials?\.(json|ya?ml|toml|ini|txt)$/i,       // credentials.json
  /(^|[/\\])secrets?\.(ya?ml|json|toml|env|ini)$/i,           // secrets.yaml
  /\.(pem|key|p12|pfx|keystore|jks)$/i,                       // 憑證與金鑰檔
  /(^|[/\\])id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,            // SSH 金鑰
  /(^|[/\\])[^/\\]*token[^/\\]*\.json$/i,                   // xxx-token.json
  /(^|[/\\])\.npmrc$|(^|[/\\])\.pypirc$/i,                   // 含 token 的設定檔
];

/**
 * 受保護的「個資」檔名關鍵字 —— NPO 情境，維持較寬的中文比對。
 * 這類命中會要求人工確認（ask），不會直接封殺，避免誤判時完全無法工作。
 */
export const PII_FILE_PATTERNS = [/個資/, /捐款/, /名冊/, /個人資料/];

/** 兩者合起來就是「檔名層級的受保護樣式」 */
export const PROTECTED_FILE_PATTERNS = [...SECRET_FILE_PATTERNS, ...PII_FILE_PATTERNS];

/** 對外送出的指令樣式（Bash） */
export const OUTBOUND_CMD_PATTERNS = [
  { re: /\bcurl\b[^|]*\s(-X\s*(POST|PUT|PATCH)|--data|-d\b)/i, label: "用 curl 送出資料到外部網址" },
  { re: /\bwget\b.*--post/i, label: "用 wget 送出資料" },
  { re: /\bgit\s+push\b/, label: "推送程式碼到遠端 repo" },
  { re: /\b(mail|sendmail|mutt)\b/, label: "寄送 Email" },
  { re: /\bosascript\b.*[Mm]ail/, label: "透過 Mail App 寄信" },
  { re: /\bSend-MailMessage\b/i, label: "寄送 Email（PowerShell）" },
];

/** 對外送出的 MCP 工具名稱樣式 */
export const OUTBOUND_TOOL_PATTERNS = [
  { re: /slack/i, label: "在 Slack 發訊息" },
  { re: /gmail|mail|email/i, label: "寄送 Email" },
  { re: /(send|post|create).*message/i, label: "發送訊息" },
  { re: /tweet|linkedin|facebook/i, label: "發佈到社群平台" },
  { re: /publish|deploy/i, label: "發佈／部署到外部" },
];

/** 讀取 Claude Code 由 stdin 傳入的 hook payload */
export async function readHookInput() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** 回傳決定給 Claude Code；reason 會顯示給使用者看 */
export function decide(permissionDecision, permissionDecisionReason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision,
        permissionDecisionReason,
      },
    })
  );
  process.exit(0);
}

/** 不干預，交回 Claude Code 原本的權限流程 */
export function passThrough() {
  process.exit(0);
}

/** 路徑是否落在受保護資料夾內（跨平台：同時處理 / 與 \） */
export function inProtectedDir(p = "") {
  const parts = String(p).split(/[/\\]+/).filter(Boolean);
  return PROTECTED_DIRS.find((d) => parts.includes(d)) ?? null;
}

/** 檔名／路徑是否命中受保護樣式 */
export function matchProtectedFile(p = "") {
  return PROTECTED_FILE_PATTERNS.find((re) => re.test(String(p))) ?? null;
}
