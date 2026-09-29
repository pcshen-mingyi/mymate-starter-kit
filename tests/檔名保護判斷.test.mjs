/**
 * 檔名層級保護判斷的回歸測試。
 *
 *   node tests/檔名保護判斷.test.mjs
 *
 * 這裡守的是兩條方向相反的線，跟「危險動作判斷」同一個道理：
 *   1. 真的可能裝著名單的檔案**必須**被攔（漏報 → 個資進到對話裡）
 *   2. 普通的程式碼與文件**絕對不能**被誤攔（假警報 → 使用者學會無腦按允許）
 *
 * 第 2 條是這個檔案存在的原因。這個包踩過一次：舊版用英文子字串比對
 * （/credential/、/secret/、/token/），裝到使用者層級後在所有專案誤擋
 * `token.py`、`secrets.py`、`get_token.js` 這類再普通不過的原始碼。
 * 2026-09-29 加入英文個資比對時，同一個坑必須被測試擋住。
 */
import {
  matchProtectedFile,
  inProtectedDir,
  SECRET_FILE_PATTERNS,
} from "../.claude/hooks/_config.mjs";

let pass = 0, fail = 0;
const ck = (name, ok, detail) => {
  if (ok) { pass++; console.log("✓ " + name); }
  else { fail++; console.log("✗ " + name + (detail ? "\n    " + detail : "")); }
};

console.log("── 受保護資料夾：直接拒絕，不問 ──");
for (const p of [
  "_private/名單.xlsx",
  "專案/_raw/原始資料.csv",
  "/Users/x/work/raw_data/dump.json",
]) ck(`攔下 ${p}`, inProtectedDir(p) !== null, "沒攔到");
for (const p of ["docs/private-notes.md", "src/raw.ts", "rawdata.csv"]) {
  ck(`不誤攔 ${p}`, inProtectedDir(p) === null, "被誤攔了");
}

console.log("\n── 中文個資檔名：要攔（先問，不是封殺）──");
for (const f of [
  "名冊2026.xlsx", "2026捐款明細.xlsx", "個資清單.docx",
  "個人資料表.pdf", "通訊錄.csv", "身分證影本.pdf",
]) ck(`攔下 ${f}`, matchProtectedFile(f) !== null, "沒攔到");

console.log("\n── 英文個資檔名：要攔（2026-09-29 新增）──");
for (const f of [
  "donor_list.xlsx", "Donors.csv", "member_roster.csv",
  "beneficiary_data.xlsx", "personal_info.docx", "personal-details.pdf",
  "contact-list.csv", "attendees.xlsx", "volunteer list.docx",
  "pii-export.csv", "/Users/x/Desktop/Membership.xls", "student_list.pdf",
]) ck(`攔下 ${f}`, matchProtectedFile(f) !== null, "沒攔到");

console.log("\n── 絕對不能誤攔：英文單字出現在程式碼檔名裡 ──");
for (const f of [
  "members.ts", "member.py", "contact-form.jsx", "personal-settings.json",
  "remember.js", "donor.tsx", "src/components/MemberCard.tsx",
  "test/donors.spec.ts", "node_modules/member/index.js",
  // 這四個是當年真的被誤擋過的檔名
  "token.py", "secrets.py", "credentials.py", "get_token.js",
]) ck(`放行 ${f}`, matchProtectedFile(f) === null, "被誤攔了");

console.log("\n── 也不能誤攔：一般文件與資料檔 ──");
for (const f of ["README.md", "package.json", "index.html", "data.csv", "report.pdf", "sepia.csv"]) {
  ck(`放行 ${f}`, matchProtectedFile(f) === null, "被誤攔了");
}

console.log("\n── 密鑰檔：要攔，而且要被判定成「密鑰」而非「個資」──");
for (const f of [".env", ".env.local", "credentials.json", "id_rsa", "server.pem", "auth-token.json"]) {
  const hit = matchProtectedFile(f);
  const isSecret = SECRET_FILE_PATTERNS.some((re) => re.test(f));
  ck(`攔下並判定為密鑰 ${f}`, hit !== null && isSecret, hit === null ? "沒攔到" : "被當成個資檔");
}

console.log("\n── 英文比對只在資料檔副檔名上生效（刻意的取捨）──");
ck("donors.json 目前不攔（json 多半是程式設定，不是匯出的名單）",
  matchProtectedFile("donors.json") === null);
ck("donors.xlsx 會攔", matchProtectedFile("donors.xlsx") !== null);
ck("關鍵字要在檔名本身，不是路徑任一層：donors/summary.pdf 不攔",
  matchProtectedFile("donors/summary.pdf") === null);

console.log(`\n結果：${pass} 通過、${fail} 失敗`);
process.exit(fail === 0 ? 0 : 1);
