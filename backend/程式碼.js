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
var DAILY_ROW = 11; // 每日表格第一列
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

  st.getRange("A7").setValue("首筆事件");
  st.getRange("B7").setFormula(
    '=IFERROR(TEXT(MIN(' + q + 'A2:A),"yyyy-mm-dd hh:mm"),"—")'
  );
  st.getRange("C7").setValue("最近事件");
  st.getRange("D7").setFormula(
    '=IFERROR(TEXT(MAX(' + q + 'A2:A),"yyyy-mm-dd hh:mm"),"—")'
  );
  st.getRange("E7").setValue("最近事件距今");
  st.getRange("F7").setFormula(
    '=IFERROR(TODAY()-INT(MAX(' + q + 'A2:A))&" 天","—")'
  );

  // 近 60 天每日安裝的迷你走勢，放在快照裡（一眼看一格就好）
  var lastDaily = DAILY_ROW + DAILY_DAYS - 1;
  st.getRange("A8").setValue("近 " + DAILY_DAYS + " 天每日安裝走勢");
  st.getRange("B8:F8").merge();
  st.getRange("B8").setFormula("=SPARKLINE(B" + DAILY_ROW + ":B" + lastDaily + ")");

  // ── 每日趨勢（連續日期軸，沒事件的日子補 0）──────────────────
  st.getRange("A9")
    .setValue("每日趨勢（近 " + DAILY_DAYS + " 天，含沒有事件的日子＝0）")
    .setFontWeight("bold");
  st.getRange(DAILY_ROW - 1, 1, 1, 5).setValues([
    ["日期", "當日安裝", "當日卸載", "累計安裝", "累計淨留存"],
  ]);
  st.getRange(DAILY_ROW - 1, 1, 1, 5).setFontWeight("bold").setBackground("#f1f3f4");

  var daily = [];
  for (var d = 0; d < DAILY_DAYS; d++) {
    var r = DAILY_ROW + d;
    daily.push([
      "=TODAY()-" + (DAILY_DAYS - 1 - d),
      dayCount(q, "install", r),
      dayCount(q, "uninstall", r),
      upToCount(q, "install", r),
      netUpTo(q, r),
    ]);
  }
  st.getRange(DAILY_ROW, 1, DAILY_DAYS, 5).setFormulas(daily);
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
  st.getRange(wLast + 3, 8).setValue("版本分布").setFontWeight("bold");
  st.getRange(wLast + 4, 8).setFormula(
    '=IFERROR(QUERY(' + q + "C2:C," +
      '"select Col1, count(Col1) where Col1 is not null and Col1 <> \'\' ' +
      "group by Col1 order by count(Col1) desc " +
      'label Col1 \'版本\', count(Col1) \'筆數\'"),"（還沒有資料）")'
  );
  st.getRange(wLast + 3, 11).setValue("平台分布").setFontWeight("bold");
  st.getRange(wLast + 4, 11).setFormula(
    '=IFERROR(QUERY(' + q + "D2:D," +
      '"select Col1, count(Col1) where Col1 is not null and Col1 <> \'\' ' +
      "group by Col1 order by count(Col1) desc " +
      'label Col1 \'平台\', count(Col1) \'筆數\'"),"（還沒有資料）")'
  );

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
