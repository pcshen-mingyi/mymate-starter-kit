/**
 * _stats.mjs —— 匿名安裝計數（install +1 / uninstall +1）
 *
 * ── 設計原則（請一併閱讀 README 的「匿名計數」章節）──
 *
 * 只送三個欄位，全部不含任何可識別個人的資訊：
 *   event    "install" 或 "uninstall"
 *   version  本包版本（知道大家停在哪一版）
 *   platform "darwin" 或 "win32"（知道 Mac／Windows 比例）
 *
 * **不會送**：使用者名稱、機器 ID、檔案名稱、檔案內容、資料夾路徑、
 *             對話內容——一項都沒有。
 *             （和所有網路請求一樣，伺服器端看得到 IP，但後端不記錄它。）
 * **沒有識別碼**，所以無法追蹤個別使用者，也無法把安裝與卸載配對。
 *             得到的是「次數」不是「人數」——這是刻意的取捨。
 *
 * 隨時可以關閉：設環境變數 MYMATE_NO_STATS=1
 * 失敗一律靜默忽略，逾時 2 秒，**永遠不會影響安裝或還原本身**。
 * `--dry-run` 不會送出任何東西。
 */

/** 統計端點。留空＝完全不送出。維護者部署後填入（設定方式見 docs/統計設定-給維護者.md）。 */
export const STATS_ENDPOINT =
  "https://script.google.com/macros/s/AKfycbwhadKhFTzavWrP3rCu9pW2qLy_D9TjS0Jk_mqvqjwlLGRJh4lujOGCusDzVzgMiuez/exec";

export const BUNDLE_VERSION = "2.1";

/** 是否會送出（給安裝訊息顯示用） */
export function statsEnabled() {
  return Boolean(STATS_ENDPOINT) && process.env.MYMATE_NO_STATS !== "1";
}

/**
 * 送出一筆計數。永不拋錯、永不阻塞。
 * @param {"install"|"uninstall"} event
 * @param {boolean} dry  試跑時不送
 */
export async function sendStat(event, dry = false) {
  if (dry || !statsEnabled()) return false;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    await fetch(STATS_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event,
        version: BUNDLE_VERSION,
        platform: process.platform,
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    return true;
  } catch {
    return false; // 網路不通、端點掛掉、被防火牆擋——一律當作沒發生
  }
}

/** 給使用者看的一句話說明（安裝／還原時顯示） */
export function statsNotice() {
  if (!STATS_ENDPOINT) return null;
  if (process.env.MYMATE_NO_STATS === "1") return "（你已設定不回報使用計數）";
  return "註：會回報一筆匿名計數（只有「安裝／還原」、版本、作業系統），不含任何個人資料或檔案內容。\n    不想回報請設定環境變數 MYMATE_NO_STATS=1。";
}
