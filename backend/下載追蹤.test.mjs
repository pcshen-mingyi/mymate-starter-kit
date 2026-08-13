/**
 * planDownloadWrites 的本機測試。
 *
 *   node backend/下載追蹤.test.mjs
 *
 * Apps Script 不能在本機執行，所以把「寫哪一列、較上次新增算多少」的判斷
 * 抽成純函式。這個檔案直接載入 程式碼.js（只 eval 定義、不呼叫 Google 服務），
 * 驗證兩條最容易做錯、而且錯了會累積的規則：
 *
 *   1. 同一天重複執行要更新那一列，不能新增重複列。
 *   2. 「沒有資料」與「0」必須嚴格區分——沒有前一天可比就留空，不能填 0。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "程式碼.js");

// Google 服務的空殼，只為了讓檔案能被 eval
const stubs = [
  "SpreadsheetApp", "ContentService", "UrlFetchApp",
  "Logger", "Charts", "ScriptApp", "Utilities", "Session",
];
const fn = new Function(
  ...stubs,
  readFileSync(SRC, "utf8") + "\n;return { planDownloadWrites, countPlan };"
);
const { planDownloadWrites, countPlan } = fn(...stubs.map(() => ({})));

const TODAY = "2026-08-12";
const YESTERDAY = "2026-08-11";
const ASSET = "MYmate-starter-kit.zip";
const api = (v20, v01) => [
  { tag_name: "v2.0", assets: [{ name: ASSET, download_count: v20 }] },
  { tag_name: "v0.1", assets: [{ name: ASSET, download_count: v01 }] },
];

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("✓ " + name); }
  else { fail++; console.log("✗ " + name + (detail ? "\n    " + detail : "")); }
}

console.log("── 第一次抓取：較上次新增必須是空值而非 0 ──");
{
  const plan = planDownloadWrites([], api(5, 2), TODAY);
  check("寫入 2 列（兩個 release 各一個資產）", plan.length === 2);
  check("列號從第 2 列開始", plan[0].row === 2 && plan[1].row === 3);
  check("都是新增，不是更新", plan.every((p) => p.isUpdate === false));
  check("較上次新增為 null（→ 寫空白）", plan.every((p) => p.delta === null));
  check("不是 0", plan.every((p) => p.delta !== 0));
}

console.log("\n── 同一天重複執行：必須更新該列，不得新增 ──");
{
  const existing = [
    { dateStr: TODAY, tag: "v2.0", asset: ASSET, total: 5 },
    { dateStr: TODAY, tag: "v0.1", asset: ASSET, total: 2 },
  ];
  const plan = planDownloadWrites(existing, api(7, 2), TODAY);
  check("仍然只有 2 列", plan.length === 2);
  check("兩列都是更新", plan.every((p) => p.isUpdate === true));
  check("更新的是原來那兩列", plan[0].row === 2 && plan[1].row === 3);
  check("沒有任何新增", countPlan(plan, false) === 0);
}

console.log("\n── 重跑時較上次新增要跟前一天比，不能跟今天早先那次比 ──");
{
  const existing = [
    { dateStr: YESTERDAY, tag: "v2.0", asset: ASSET, total: 5 },
    { dateStr: TODAY, tag: "v2.0", asset: ASSET, total: 8 },
  ];
  const plan = planDownloadWrites(existing, api(9, 0).slice(0, 1), TODAY);
  check("更新今天那一列", plan[0].row === 3 && plan[0].isUpdate === true);
  check("較上次新增 = 9 − 5 = 4（跟昨天比，不是 9 − 8 = 1）", plan[0].delta === 4,
    "實際: " + plan[0].delta);
}

console.log("\n── 第二天抓取：較上次新增等於差值 ──");
{
  const existing = [
    { dateStr: YESTERDAY, tag: "v2.0", asset: ASSET, total: 5 },
    { dateStr: YESTERDAY, tag: "v0.1", asset: ASSET, total: 2 },
  ];
  const plan = planDownloadWrites(existing, api(12, 2), TODAY);
  check("新增到第 4、5 列", plan[0].row === 4 && plan[1].row === 5);
  check("v2.0 較上次新增 = 12 − 5 = 7", plan[0].delta === 7);
  check("v0.1 沒增加 → 0（這個 0 是真的 0，不是空值）", plan[1].delta === 0);
}

console.log("\n── 多天累積：只跟最近一天比 ──");
{
  const existing = [
    { dateStr: "2026-08-09", tag: "v2.0", asset: ASSET, total: 1 },
    { dateStr: "2026-08-10", tag: "v2.0", asset: ASSET, total: 3 },
    { dateStr: YESTERDAY, tag: "v2.0", asset: ASSET, total: 10 },
  ];
  const plan = planDownloadWrites(existing, api(11, 0).slice(0, 1), TODAY);
  check("較上次新增 = 11 − 10 = 1", plan[0].delta === 1);
}

console.log("\n── 新資產首次出現：舊的有差值，新的仍須留空 ──");
{
  const existing = [{ dateStr: YESTERDAY, tag: "v2.0", asset: ASSET, total: 10 }];
  const plan = planDownloadWrites(existing, [
    { tag_name: "v2.0", assets: [{ name: ASSET, download_count: 12 }] },
    { tag_name: "v2.1", assets: [{ name: ASSET, download_count: 4 }] },
  ], TODAY);
  check("舊資產差值 2", plan[0].delta === 2);
  check("新資產留空，不是 4 也不是 0", plan[1].delta === null);
}

console.log("\n── 邊界 ──");
{
  check("Release 沒有資產 → 不產生列",
    planDownloadWrites([], [{ tag_name: "v3.0", assets: [] }], TODAY).length === 0);
  check("assets 欄位缺失也不會爆",
    planDownloadWrites([], [{ tag_name: "v3.0" }], TODAY).length === 0);
  const existing = [{ dateStr: YESTERDAY, tag: "v2.0", asset: ASSET, total: 10 }];
  check("資產重新上傳導致計數歸零 → 差值為負，刻意不遮蓋",
    planDownloadWrites(existing, api(0, 0).slice(0, 1), TODAY)[0].delta === -10);
}

console.log(`\n結果：${pass} 通過、${fail} 失敗`);
process.exit(fail === 0 ? 0 : 1);
