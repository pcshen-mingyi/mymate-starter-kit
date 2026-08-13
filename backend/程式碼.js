/**
 * MYmate 小白包 —— 匿名安裝計數接收端
 *
 * 只接受並寫入三個欄位：event（install／uninstall）、version、platform。
 * 不寫入 IP、User-Agent，也不寫入請求裡的任何其他欄位。
 * 任何異常一律回 200 且不寫入——不向外洩漏內部狀態。
 *
 * 對應小白包的 _stats.mjs；送出內容的說明必須與 README、安裝訊息一致。
 */

var HEADERS = ["時間", "事件", "版本", "平台"];

function doPost(e) {
  try {
    var body = (e && e.postData && e.postData.contents) || "{}";
    var d = JSON.parse(body);

    // 只接受預期的值，其餘一律丟棄（公開端點會有爬蟲與雜訊）
    var event = d.event === "install" || d.event === "uninstall" ? d.event : null;
    if (!event) return ok();

    var version = String(d.version || "").slice(0, 20);
    var platform = String(d.platform || "").slice(0, 20);

    writeRow(sheet(), event, version, platform);
    return ok();
  } catch (err) {
    return ok(); // 解析失敗、寫入失敗——一律當作沒發生，仍回 200
  }
}

/** 用瀏覽器打開就能確認端點活著 */
function doGet() {
  return ContentService.createTextOutput(
    "MYmate starter kit stats endpoint (alive). POST {event, version, platform}."
  );
}

/** 資料分頁＝第一個分頁（不寫死名稱）。標題列不存在時補上。 */
function sheet() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  if (sh.getLastRow() === 0) {
    sh.appendRow(HEADERS);
    sh.getRange(1, 1, 1, HEADERS.length).setFontWeight("bold");
    sh.setFrozenRows(1);
  }
  return sh;
}

/**
 * 寫一列。版本與平台一律以「文字」存。
 * 不這樣做的話，試算表會把 "2.0" 自動判成數字 2，
 * 之後 "2.10" 與 "2.1" 也會撞成同一個值，版本分布就不能用了。
 */
function writeRow(sh, event, version, platform) {
  var r = sh.getLastRow() + 1;
  var range = sh.getRange(r, 1, 1, 4);
  range.setNumberFormats([["yyyy/mm/dd hh:mm:ss", "@", "@", "@"]]);
  range.setValues([[new Date(), event, version, platform]]);
}

function ok() {
  return ContentService.createTextOutput("ok");
}

// ───────────────────────────────────────────────────────────────
// 以下是維護用函式，不會被端點呼叫。在編輯器按 ▷ 執行。
// ───────────────────────────────────────────────────────────────

var DAILY_DAYS = 60; // 每日趨勢的天數
var FUNNEL_ROW = 11; // 漏斗第一列（在即時快照下方）
var DAILY_ROW = 21; // 每日表格第一列（在漏斗與判讀說明下方）
var WEEKLY_WEEKS = 12; // 每週彙總的週數
var WEEKLY_ROW = 27; // 每週表格第一列（在圖表下方）

/**
 * setup()：建立（或重建）「統計」分頁。可以重複執行，不會壞。
 *
 * 設計重點——趨勢優先：
 *  1. 折線圖放最上面，一眼看走勢。
 *  2. 每日表格的日期軸「連續」，沒有事件的日子補 0。
 *     用 QUERY group by 只會列出有資料的日子，中間空白被跳過，曲線會騙人。
 *  3. 累計欄位算的是「全部歷史」，不是視窗內累加，換窗不會讓數字跳動。
 *  4. 事件少時每日會很稀疏，所以另外給每週彙總來平滑。
 *
 * 資料分頁的名稱不寫死——公式都依實際名稱組出來。
 */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var data = sheet(); // 順便確保標題列存在
  var q = "'" + data.getName().replace(/'/g, "''") + "'!"; // 公式用的分頁前綴
  // 漏斗與「當日下載」都要引用「下載」分頁。先確保它存在，
  // 否則 fetchDownloads() 還沒跑過時，那些公式會變成 #REF!。
  downloadSheet();
  var dl = "'" + DOWNLOAD_SHEET.replace(/'/g, "''") + "'!";

  // 資料分頁的版本與平台欄一律文字格式（writeRow 已逐列設定，這裡是雙重保險）
  data.getRange(1, 3, data.getMaxRows(), 2).setNumberFormat("@");

  var st = ss.getSheetByName("統計");
  if (st) {
    st.clear();
    // clear() 不會移除圖表，重跑前必須自己拆掉，否則會愈疊愈多
    var old = st.getCharts();
    for (var i = 0; i < old.length; i++) st.removeChart(old[i]);
  } else {
    st = ss.insertSheet("統計");
  }

  // ── 說明（兩行，永遠放最上面）──────────────────────────────
  st.getRange("A1:F1").merge().setValue(
    "這是「次數」不是「人數」。無識別碼，同一人重裝會重複計算，安裝與卸載無法配對。"
  );
  st.getRange("A2:F2").merge().setValue(
    "數字只是訊號——它能告訴你「該去問了」，不能告訴你「為什麼」。要知道原因得靠訪談與課後回饋。"
  );
  st.getRange("A1:A2").setWrap(true).setFontColor("#8a6d1b").setBackground("#fff8e1");

  // ── 即時快照（壓成三列，不佔版面）──────────────────────────
  st.getRange("A4").setValue("即時快照").setFontWeight("bold");
  st.getRange("A5").setValue("安裝累計");
  st.getRange("B5").setFormula('=COUNTIF(' + q + 'B:B,"install")');
  st.getRange("C5").setValue("卸載累計");
  st.getRange("D5").setFormula('=COUNTIF(' + q + 'B:B,"uninstall")');
  st.getRange("E5").setValue("淨留存（次數）");
  st.getRange("F5").setFormula("=B5-D5");

  st.getRange("A6").setValue("Mac（darwin）");
  st.getRange("B6").setFormula('=COUNTIF(' + q + 'D:D,"darwin")');
  st.getRange("C6").setValue("Windows（win32）");
  st.getRange("D6").setFormula('=COUNTIF(' + q + 'D:D,"win32")');
  st.getRange("E6").setValue("其他／不明");
  st.getRange("F6").setFormula("=COUNTA(" + q + "B2:B)-B6-D6");

  // 空狀態一定要先用 COUNTA 判斷有沒有資料，不能靠 IFERROR。
  // MIN／MAX 對空範圍回傳 0（不是錯誤），IFERROR 接不到；
  // 0 又會被日期格式渲染成 1899-12-30，「距今」則變成 46245 天，看起來像壞掉。
  var hasData = "COUNTA(" + q + "A2:A)=0";
  st.getRange("A7").setValue("首筆事件");
  st.getRange("B7").setFormula(
    "=IF(" + hasData + ',"—",TEXT(MIN(' + q + 'A2:A),"yyyy-mm-dd hh:mm"))'
  );
  st.getRange("C7").setValue("最近事件");
  st.getRange("D7").setFormula(
    "=IF(" + hasData + ',"—",TEXT(MAX(' + q + 'A2:A),"yyyy-mm-dd hh:mm"))'
  );
  st.getRange("E7").setValue("最近事件距今");
  st.getRange("F7").setFormula(
    "=IF(" + hasData + ',"—",TODAY()-INT(MAX(' + q + 'A2:A))&" 天")'
  );

  // 近 60 天每日安裝的迷你走勢，放在快照裡（一眼看一格就好）
  var lastDaily = DAILY_ROW + DAILY_DAYS - 1;
  st.getRange("A8").setValue("近 " + DAILY_DAYS + " 天每日安裝走勢");
  st.getRange("B8:F8").merge();
  st.getRange("B8").setFormula("=SPARKLINE(B" + DAILY_ROW + ":B" + lastDaily + ")");

  // ── 漏斗：下載 → 安裝 → 卸載 ───────────────────────────────
  var fr = FUNNEL_ROW;
  st.getRange(fr - 1, 1).setValue("漏斗（累計）").setFontWeight("bold");
  st.getRange(fr, 1).setValue("累計下載");
  st.getRange(fr, 2).setFormula(totalDownloads(dl));
  st.getRange(fr + 1, 1).setValue("累計安裝");
  st.getRange(fr + 1, 2).setFormula("=B5");
  st.getRange(fr + 2, 1).setValue("安裝率（安裝 ÷ 下載）");
  st.getRange(fr + 2, 2).setFormula(
    "=IF(B" + fr + '=0,"—",B' + (fr + 1) + "/B" + fr + ")"
  );
  st.getRange(fr + 3, 1).setValue("累計卸載");
  st.getRange(fr + 3, 2).setFormula("=D5");
  st.getRange(fr + 4, 1).setValue("卸載率（卸載 ÷ 安裝）");
  st.getRange(fr + 4, 2).setFormula(
    "=IF(B" + (fr + 1) + '=0,"—",B' + (fr + 3) + "/B" + (fr + 1) + ")"
  );
  st.getRange(fr + 5, 1).setValue("淨留存（次數）");
  st.getRange(fr + 5, 2).setFormula("=F5");
  st.getRange(fr + 2, 2).setNumberFormat("0.0%");
  st.getRange(fr + 4, 2).setNumberFormat("0.0%");

  // 判讀說明——不可省略。兩個偏差方向相反，所以絕對百分比不可靠。
  st.getRange(fr + 6, 1, 1, 6).merge();
  st.getRange(fr + 6, 1)
    .setValue(
      "下載與安裝都是「次數」，同一個基準（皆非不重複人數）。" +
        "差別在於下載含爬蟲，而爬蟲不會安裝——所以安裝率會系統性偏低。" +
        "另一個方向：下載每天只抓一次、安裝是即時寫入，所以剛釋出的頭一兩天安裝率會反而虛高。" +
        "看趨勢變化比看絕對數字可靠。"
    )
    .setWrap(true)
    .setFontSize(9)
    .setFontColor("#666666");

  // ── 每日趨勢（連續日期軸，沒事件的日子補 0）──────────────────
  st.getRange(DAILY_ROW - 2, 1)
    .setValue("每日趨勢（近 " + DAILY_DAYS + " 天，含沒有事件的日子＝0）")
    .setFontWeight("bold");
  st.getRange(DAILY_ROW - 1, 1, 1, 6).setValues([
    ["日期", "當日安裝", "當日卸載", "累計安裝", "累計淨留存", "當日下載"],
  ]);
  st.getRange(DAILY_ROW - 1, 1, 1, 6).setFontWeight("bold").setBackground("#f1f3f4");

  var daily = [];
  for (var d = 0; d < DAILY_DAYS; d++) {
    var r = DAILY_ROW + d;
    daily.push([
      "=TODAY()-" + (DAILY_DAYS - 1 - d),
      dayCount(q, "install", r),
      dayCount(q, "uninstall", r),
      upToCount(q, "install", r),
      netUpTo(q, r),
      dayDownloads(dl, r),
    ]);
  }
  st.getRange(DAILY_ROW, 1, DAILY_DAYS, 6).setFormulas(daily);
  st.getRange(DAILY_ROW, 1, DAILY_DAYS, 1).setNumberFormat("yyyy-mm-dd");

  // ── 折線圖：累計趨勢（放在右上角，一眼看走勢）─────────────────
  var chart = st
    .newChart()
    .setChartType(Charts.ChartType.LINE)
    .addRange(st.getRange(DAILY_ROW - 1, 1, DAILY_DAYS + 1, 1)) // 日期
    .addRange(st.getRange(DAILY_ROW - 1, 4, DAILY_DAYS + 1, 2)) // 累計安裝、累計淨留存
    .setNumHeaders(1)
    .setPosition(4, 8, 0, 0) // 第 4 列、第 H 欄
    .setOption("title", "累計趨勢（次數，非人數）")
    .setOption("width", 620)
    .setOption("height", 300)
    .setOption("legend", { position: "bottom" })
    .build();
  st.insertChart(chart);

  // ── 每週彙總（事件稀疏時用這個看，比每日穩）──────────────────
  var wLast = WEEKLY_ROW + WEEKLY_WEEKS - 1;
  st.getRange(WEEKLY_ROW - 2, 8)
    .setValue("每週彙總（近 " + WEEKLY_WEEKS + " 週，週一為起始）")
    .setFontWeight("bold");
  st.getRange(WEEKLY_ROW - 1, 8, 1, 3).setValues([["週起始", "安裝", "卸載"]]);
  st.getRange(WEEKLY_ROW - 1, 8, 1, 3).setFontWeight("bold").setBackground("#f1f3f4");

  var weekly = [];
  for (var w = 0; w < WEEKLY_WEEKS; w++) {
    var wr = WEEKLY_ROW + w;
    weekly.push([
      "=TODAY()-WEEKDAY(TODAY(),3)-" + 7 * (WEEKLY_WEEKS - 1 - w),
      weekCount(q, "install", wr),
      weekCount(q, "uninstall", wr),
    ]);
  }
  st.getRange(WEEKLY_ROW, 8, WEEKLY_WEEKS, 3).setFormulas(weekly);
  st.getRange(WEEKLY_ROW, 8, WEEKLY_WEEKS, 1).setNumberFormat("yyyy-mm-dd");

  // ── 版本與平台分布（動態，冒出沒預期的值也看得到）─────────────
  // 空狀態同樣先用 COUNTA 判斷。QUERY 對空範圍不會回 #N/A，
  // 而是回「只有標籤列」的結果，所以 IFERROR 也接不到（跟 MIN／MAX 同一類陷阱）。
  st.getRange(wLast + 3, 8).setValue("版本分布").setFontWeight("bold");
  st.getRange(wLast + 4, 8).setFormula(distFormula(q, "C", "版本"));
  st.getRange(wLast + 3, 11).setValue("平台分布").setFontWeight("bold");
  st.getRange(wLast + 4, 11).setFormula(distFormula(q, "D", "平台"));

  // 快照的標籤與時間戳跟每日表格共用欄位，寬度要能容納「Windows（win32）」
  // 與「2026-08-11 15:39」——設太窄會被截斷成「Windows（win」「2026-08-11 15」。
  st.setColumnWidth(1, 150);
  st.setColumnWidth(2, 145);
  st.setColumnWidth(3, 145);
  st.setColumnWidth(4, 145);
  st.setColumnWidth(5, 130);
  st.setColumnWidth(6, 110);
  ss.setActiveSheet(st);
  Logger.log(
    "統計分頁已重建（資料分頁：" + data.getName() +
      "）。每日 " + DAILY_DAYS + " 天、每週 " + WEEKLY_WEEKS + " 週、折線圖 1 張。"
  );
}

/** 某一天的事件數（日期在 A 欄該列） */
function dayCount(q, event, row) {
  return (
    '=COUNTIFS(' + q + '$B:$B,"' + event + '",' +
    q + '$A:$A,">="&$A' + row + "," +
    q + '$A:$A,"<"&$A' + row + "+1)"
  );
}

/** 到某一天結束為止的累計事件數（全部歷史，不受視窗影響） */
function upToCount(q, event, row) {
  return "=" + countifsBody(q, event, row);
}

/** 到某一天結束為止的累計淨留存＝累計安裝 − 累計卸載（次數相減，非人數） */
function netUpTo(q, row) {
  return "=" + countifsBody(q, "install", row) + "-" + countifsBody(q, "uninstall", row);
}

/** COUNTIFS 本體（不含開頭的等號），方便組合成相減式 */
function countifsBody(q, event, row) {
  return (
    'COUNTIFS(' + q + '$B:$B,"' + event + '",' +
    q + '$A:$A,"<"&$A' + row + "+1)"
  );
}

/**
 * 分布表（版本／平台）。空資料時直接顯示「（還沒有資料）」。
 * @param col 資料分頁的欄位字母（C＝版本、D＝平台）
 */
function distFormula(q, col, label) {
  return (
    "=IF(COUNTA(" + q + col + '2:' + col + ')=0,"（還沒有資料）",' +
    "QUERY(" + q + col + "2:" + col + "," +
    '"select Col1, count(Col1) where Col1 is not null and Col1 <> \'\' ' +
    "group by Col1 order by count(Col1) desc " +
    "label Col1 '" + label + "', count(Col1) '筆數'\"))"
  );
}

/**
 * 累計下載＝每個資產只取一個值，再加總。
 *
 * 「下載」分頁每一列都是當下的絕對值快照，所以**不能整欄加總**——
 * 同一資產不同天的快照相加會嚴重高估。
 * 用 max() group by 版本+資產：GitHub 的計數只增不減，所以 max 等於最新值，
 * 而且不依賴列的排序（手動編輯過也不會錯）。
 *
 * 唯一例外：資產被刪掉重新上傳時計數會歸零，此時 max 會保留歸零前的高值而高估。
 * 那種情況很罕見，而且發生時「下載」分頁會出現負的「較上次新增」，看得出來。
 */
function totalDownloads(dl) {
  return (
    "=IFERROR(SUM(QUERY(" + dl + "B2:D," +
    '"select max(Col3) group by Col1, Col2 label max(Col3) \'\'"' +
    ")),0)"
  );
}

/**
 * 某一天的下載新增（日期在 A 欄該列），跨資產加總。
 *
 * 「那天沒抓到」與「那天 0 次下載」是兩件事，所以要先判斷那天有沒有
 * **非空**的「較上次新增」——第一次抓取雖然有列，但差值是空的（還沒有基準），
 * 那天仍然是未知，不能顯示 0。
 */
function dayDownloads(dl, row) {
  var from = dl + '$A:$A,">="&$A' + row;
  var to = dl + '$A:$A,"<"&$A' + row + "+1";
  return (
    "=IF(COUNTIFS(" + from + "," + to + "," + dl + '$E:$E,"<>")=0,"",' +
    "SUMIFS(" + dl + "$E:$E," + from + "," + to + "))"
  );
}

/** 某一週（起始日在 H 欄該列）的事件數 */
function weekCount(q, event, row) {
  return (
    '=COUNTIFS(' + q + '$B:$B,"' + event + '",' +
    q + '$A:$A,">="&$H' + row + "," +
    q + '$A:$A,"<"&$H' + row + "+7)"
  );
}

/**
 * clearAllData()：清掉資料分頁的**所有**資料列，只留標題列。
 *
 * ⚠️ 用途是清除測試資料。真實計數一旦清掉就回不來（沒有備份）。
 *    要執行前先確認你真的想清空。
 */
function clearAllData() {
  var sh = sheet();
  var last = sh.getLastRow();
  if (last <= 1) {
    Logger.log("沒有資料列可清。");
    return;
  }
  sh.deleteRows(2, last - 1);
  Logger.log("已清除 " + (last - 1) + " 列資料，標題列保留。");
}

// ───────────────────────────────────────────────────────────────
// 下載追蹤（v2.1）—— 每天抓一次 GitHub Release 的累計下載數
//
// 與安裝／卸載計數完全獨立：這裡失敗不會影響 doPost 的寫入。
// 任何錯誤都只寫 Logger 然後安靜結束——拋錯會讓每日觸發器寄失敗信。
// ───────────────────────────────────────────────────────────────

var GITHUB_RELEASES_API =
  "https://api.github.com/repos/pcshen-mingyi/mymate-starter-kit/releases";
var DOWNLOAD_SHEET = "下載";
var DOWNLOAD_HEADERS = ["抓取時間", "版本(tag)", "資產名稱", "累計下載", "較上次新增"];
var DOWNLOAD_TRIGGER_FN = "fetchDownloads";

/**
 * 每日抓取的時段（24 小時制）。設在深夜是刻意的：
 *
 * 差值＝兩次抓取之間的新增，所以抓取時間決定了那一列涵蓋哪段時間。
 * 早上 6 點抓的話，寫在 8/13 那列的差值其實是 8/12 06:00 → 8/13 06:00，
 * 裡面有 8/12 的 18 小時、只有 8/13 的 6 小時——標著 8/13、內容主要是前一天。
 * 改成深夜抓，窗口幾乎等於當天 00:00–23:xx，才能跟即時寫入的安裝事件按日對齊。
 *
 * 附帶好處：早上看漏斗時，下載數最多只落後幾小時，而不是整整一天。
 */
var DOWNLOAD_TRIGGER_HOUR = 23;

/** 「下載」分頁；不存在就建。標題列缺漏或改過名稱也會一併補正 */
function downloadSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(DOWNLOAD_SHEET) || ss.insertSheet(DOWNLOAD_SHEET);
  var head = sh.getRange(1, 1, 1, DOWNLOAD_HEADERS.length);
  // 分隔字元要用看得見的字元。用 NUL（\0）當分隔雖然能跑，
  // 但會讓整個檔案在 grep 眼中變成二進位檔而被跳過，機密掃描就失效了。
  if (head.getValues()[0].join("|") !== DOWNLOAD_HEADERS.join("|")) {
    head.setValues([DOWNLOAD_HEADERS]).setFontWeight("bold");
    sh.setFrozenRows(1);
  }
  return sh;
}

/**
 * fetchDownloads()：抓 GitHub Release 的累計下載數，每個資產一天一列。
 * 由每日觸發器呼叫，也可以手動執行。同一天重複執行只會更新，不會新增重複列。
 */
function fetchDownloads() {
  var res;
  try {
    res = UrlFetchApp.fetch(GITHUB_RELEASES_API, {
      muteHttpExceptions: true,
      headers: { Accept: "application/vnd.github+json" },
    });
  } catch (err) {
    Logger.log("下載追蹤：連線失敗，本次跳過（不寫入）。" + err);
    return;
  }

  var code = res.getResponseCode();
  if (code !== 200) {
    Logger.log("下載追蹤：GitHub 回應 " + code + "，本次跳過（不寫入）。");
    return;
  }

  var releases;
  try {
    releases = JSON.parse(res.getContentText());
  } catch (err) {
    Logger.log("下載追蹤：JSON 解析失敗，本次跳過（不寫入）。");
    return;
  }
  if (!releases || !releases.length) {
    Logger.log("下載追蹤：沒有任何 Release，本次跳過（不寫入）。");
    return;
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tz = ss.getSpreadsheetTimeZone();
  var now = new Date();
  var today = Utilities.formatDate(now, tz, "yyyy-MM-dd");

  var sh = downloadSheet();
  var plan = planDownloadWrites(readDownloadRows(sh, tz), releases, today);
  if (!plan.length) {
    Logger.log("下載追蹤：Release 裡沒有任何資產可記錄，本次跳過（不寫入）。");
    return;
  }

  for (var i = 0; i < plan.length; i++) {
    var p = plan[i];
    var range = sh.getRange(p.row, 1, 1, 5);
    // 版本(tag) 與資產名稱存文字，否則 "2.0" 會被判成數字 2（與 writeRow 同一理由）
    range.setNumberFormats([["yyyy/mm/dd hh:mm:ss", "@", "@", "0", "0"]]);
    // 沒有前一次可比時寫空字串。空值與 0 是兩件事，不能用 0 冒充：
    // 填 0 會被讀成「那天沒人下載」，實際上是「還沒有基準可以比」。
    // 同理，某天漏抓就留空，那天的量會併進下一次成功抓取的差值裡。
    range.setValues([
      [now, p.tag, p.asset, p.total, p.delta === null ? "" : p.delta],
    ]);
  }
  Logger.log(
    "下載追蹤：更新 " + countPlan(plan, true) + " 列、新增 " + countPlan(plan, false) + " 列。"
  );
}

/** 讀出「下載」分頁現有資料列，轉成純資料好做判斷 */
function readDownloadRows(sh, tz) {
  var last = sh.getLastRow();
  if (last < 2) return [];
  var values = sh.getRange(2, 1, last - 1, 5).getValues();
  var out = [];
  for (var i = 0; i < values.length; i++) {
    var v = values[i];
    out.push({
      dateStr:
        v[0] instanceof Date
          ? Utilities.formatDate(v[0], tz, "yyyy-MM-dd")
          : String(v[0]).slice(0, 10),
      tag: String(v[1]),
      asset: String(v[2]),
      total: Number(v[3]),
    });
  }
  return out;
}

/**
 * 決定每個資產要寫在哪一列、當日新增是多少。
 * 抽成純函式是為了能在本機直接驗證這兩條最容易做錯的規則：
 *
 *  1. 同一天重複執行要「更新那一列」而不是新增。觸發器可能因重試一天跑多次，
 *     每次都 append 的話「當日新增」會全部算錯，錯誤還會累積到後面每一天。
 *  2. 當日新增要跟「前一天的快照」比，不能跟今天早先那次比
 *     （跟今天自己比，重跑就會變成 0）。找不到前一天就回 null → 寫空白，不要寫 0。
 *
 * 假設資料列按時間先後排列（正常寫入就是這樣）。
 * 若資產被刪掉重新上傳，GitHub 的計數會歸零，此時差值會是負數——
 * 那是真實事件，刻意不遮蓋。
 *
 * @param existing 現有資料列 [{dateStr, tag, asset, total}]，順序即列序（第 2 列起）
 * @param releases GitHub API 的 releases 陣列
 * @param today    今天的 yyyy-MM-dd
 * @return [{row, isUpdate, tag, asset, total, delta}]
 */
function planDownloadWrites(existing, releases, today) {
  var plan = [];
  var nextRow = existing.length + 2;

  for (var i = 0; i < releases.length; i++) {
    var rel = releases[i];
    var assets = rel.assets || [];
    for (var j = 0; j < assets.length; j++) {
      var tag = String(rel.tag_name);
      var name = String(assets[j].name);
      var total = Number(assets[j].download_count);

      var todayRow = null;
      var prevTotal = null;
      for (var k = 0; k < existing.length; k++) {
        var e = existing[k];
        if (e.tag !== tag || e.asset !== name) continue;
        if (e.dateStr === today) todayRow = k + 2;
        else prevTotal = e.total; // 順著掃，留下最近一筆「不是今天」的
      }

      plan.push({
        row: todayRow === null ? nextRow++ : todayRow,
        isUpdate: todayRow !== null,
        tag: tag,
        asset: name,
        total: total,
        delta: prevTotal === null ? null : total - prevTotal,
      });
    }
  }
  return plan;
}

function countPlan(plan, isUpdate) {
  var n = 0;
  for (var i = 0; i < plan.length; i++) if (plan[i].isUpdate === isUpdate) n++;
  return n;
}

/**
 * setupTrigger()：裝每日觸發器（時段見 DOWNLOAD_TRIGGER_HOUR）。
 * 重複執行安全——會先刪掉既有的同名觸發器，不會愈疊愈多。
 * 改過時段後要重跑一次，舊觸發器才會被換掉。
 */
function setupTrigger() {
  var all = ScriptApp.getProjectTriggers();
  var removed = 0;
  for (var i = 0; i < all.length; i++) {
    if (all[i].getHandlerFunction() === DOWNLOAD_TRIGGER_FN) {
      ScriptApp.deleteTrigger(all[i]);
      removed++;
    }
  }
  ScriptApp.newTrigger(DOWNLOAD_TRIGGER_FN)
    .timeBased()
    .atHour(DOWNLOAD_TRIGGER_HOUR)
    .everyDays(1)
    .create();
  Logger.log(
    "已刪除舊的同名觸發器 " + removed + " 個，並建立每日 " +
      DOWNLOAD_TRIGGER_HOUR + ":00 前後執行 " + DOWNLOAD_TRIGGER_FN + " 的觸發器 1 個。"
  );
}
