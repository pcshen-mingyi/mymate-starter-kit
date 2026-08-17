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
// 右側區塊（圖表、每週彙總、分布）的起始欄。每日表格已經佔到第 8 欄（H），
// 所以右側從第 10 欄（J）起，中間留一欄空白當間隔。
var RIGHT_COL = 10;

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
  st.getRange("A1:H1").merge().setValue(
    "這是「次數」不是「人數」。無識別碼，同一人重裝會重複計算，安裝與卸載無法配對。"
  );
  st.getRange("A2:H2").merge().setValue(
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
  st.getRange("B8:H8").merge();
  st.getRange("B8").setFormula("=SPARKLINE(C" + DAILY_ROW + ":C" + lastDaily + ")");

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

  // 分母的基準日。安裝是即時的、下載每天才抓一次，
  // 所以看安裝率之前要先知道下載數統計到哪一天。
  st.getRange(fr, 3).setValue("下載統計至");
  st.getRange(fr, 4).setFormula(downloadsAsOf(dl));
  st.getRange(fr, 3, 1, 2).setFontSize(9).setFontColor("#666666");

  // 判讀說明——不可省略。兩個偏差方向相反，所以絕對百分比不可靠。
  st.getRange(fr + 6, 1, 1, 8).merge();
  st.getRange(fr + 6, 1)
    .setValue(
      "下載與安裝都是「次數」，同一個基準（皆非不重複人數）。" +
        "差別在於下載含爬蟲，而爬蟲不會安裝——所以安裝率會系統性偏低。" +
        "另一個方向：安裝是即時寫入、下載每天才抓一次（見右方「下載統計至」），" +
        "所以分母比分子舊，剛釋出的頭一兩天安裝率會反而虛高。" +
        "看趨勢變化比看絕對數字可靠；要比較單日或單週的比例，用下方按統計日對齊的表格。"
    )
    .setWrap(true)
    .setFontSize(9)
    .setFontColor("#666666");

  // ── 每日趨勢（連續日期軸，沒事件的日子補 0）──────────────────
  st.getRange(DAILY_ROW - 2, 1)
    .setValue("每日趨勢（近 " + DAILY_DAYS + " 天，含沒有事件的日子＝0）")
    .setFontWeight("bold");
  // 欄位順序照漏斗由左而右：下載 → 安裝 → 卸載 → 累計 → 兩個比率。
  // 反過來排（安裝在下載左邊）讀起來會跟漏斗打架。
  st.getRange(DAILY_ROW - 1, 1, 1, 8).setValues([
    [
      "日期", "當日下載", "當日安裝", "當日卸載",
      "累計安裝", "累計淨留存", "安裝率", "卸載率",
    ],
  ]);
  st.getRange(DAILY_ROW - 1, 1, 1, 8).setFontWeight("bold").setBackground("#f1f3f4");

  var daily = [];
  for (var d = 0; d < DAILY_DAYS; d++) {
    var r = DAILY_ROW + d;
    daily.push([
      "=TODAY()-" + (DAILY_DAYS - 1 - d),
      dayDownloads(dl, r),
      dayCount(q, "install", r),
      dayCount(q, "uninstall", r),
      upToCount(q, "install", r),
      netUpTo(q, r),
      dayInstallRate(r),
      dayUninstallRate(r),
    ]);
  }
  st.getRange(DAILY_ROW, 1, DAILY_DAYS, 8).setFormulas(daily);
  st.getRange(DAILY_ROW, 1, DAILY_DAYS, 1).setNumberFormat("yyyy-mm-dd");
  st.getRange(DAILY_ROW, 7, DAILY_DAYS, 2).setNumberFormat("0.0%");

  // ── 折線圖：累計趨勢（放在右上角，一眼看走勢）─────────────────
  var chart = st
    .newChart()
    .setChartType(Charts.ChartType.LINE)
    .addRange(st.getRange(DAILY_ROW - 1, 1, DAILY_DAYS + 1, 1)) // 日期
    .addRange(st.getRange(DAILY_ROW - 1, 5, DAILY_DAYS + 1, 2)) // 累計安裝、累計淨留存
    .setNumHeaders(1)
    .setPosition(4, RIGHT_COL, 0, 0) // 第 4 列、右側區塊起始欄
    .setOption("title", "累計趨勢（次數，非人數）")
    .setOption("width", 620)
    .setOption("height", 300)
    .setOption("legend", { position: "bottom" })
    .build();
  st.insertChart(chart);

  // ── 每週彙總（事件稀疏時用這個看，比每日穩）──────────────────
  var wLast = WEEKLY_ROW + WEEKLY_WEEKS - 1;
  st.getRange(WEEKLY_ROW - 2, RIGHT_COL)
    .setValue("每週彙總（近 " + WEEKLY_WEEKS + " 週，週一為起始）")
    .setFontWeight("bold");
  st.getRange(WEEKLY_ROW - 1, RIGHT_COL, 1, 3).setValues([["週起始", "安裝", "卸載"]]);
  st.getRange(WEEKLY_ROW - 1, RIGHT_COL, 1, 3).setFontWeight("bold").setBackground("#f1f3f4");

  var weekCol = String.fromCharCode(64 + RIGHT_COL); // 週起始所在欄的字母
  var weekly = [];
  for (var w = 0; w < WEEKLY_WEEKS; w++) {
    var wr = WEEKLY_ROW + w;
    weekly.push([
      "=TODAY()-WEEKDAY(TODAY(),3)-" + 7 * (WEEKLY_WEEKS - 1 - w),
      weekCount(q, "install", wr, weekCol),
      weekCount(q, "uninstall", wr, weekCol),
    ]);
  }
  st.getRange(WEEKLY_ROW, RIGHT_COL, WEEKLY_WEEKS, 3).setFormulas(weekly);
  st.getRange(WEEKLY_ROW, RIGHT_COL, WEEKLY_WEEKS, 1).setNumberFormat("yyyy-mm-dd");

  // ── 版本與平台分布（動態，冒出沒預期的值也看得到）─────────────
  // 空狀態同樣先用 COUNTA 判斷。QUERY 對空範圍不會回 #N/A，
  // 而是回「只有標籤列」的結果，所以 IFERROR 也接不到（跟 MIN／MAX 同一類陷阱）。
  st.getRange(wLast + 3, RIGHT_COL).setValue("版本分布").setFontWeight("bold");
  st.getRange(wLast + 4, RIGHT_COL).setFormula(distFormula(q, "C", "版本"));
  st.getRange(wLast + 3, RIGHT_COL + 3).setValue("平台分布").setFontWeight("bold");
  st.getRange(wLast + 4, RIGHT_COL + 3).setFormula(distFormula(q, "D", "平台"));

  // 快照的標籤與時間戳跟每日表格共用欄位，寬度要能容納「Windows（win32）」
  // 與「2026-08-11 15:39」——設太窄會被截斷成「Windows（win」「2026-08-11 15」。
  st.setColumnWidth(1, 150);
  st.setColumnWidth(2, 145);
  st.setColumnWidth(3, 145);
  st.setColumnWidth(4, 145);
  st.setColumnWidth(5, 130);
  st.setColumnWidth(6, 130);
  st.setColumnWidth(7, 90);
  st.setColumnWidth(8, 90);
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
    "=IFERROR(SUM(QUERY(" + dl + "C2:E," +
    '"select max(Col3) group by Col1, Col2 label max(Col3) \'\'"' +
    ")),0)"
  );
}

/**
 * 當日安裝率＝當日安裝 ÷ 當日下載（B＝當日下載、C＝當日安裝）。
 *
 * 分母是空白（那天沒抓到）或 0（抓到了但沒人下載）時一律顯示「—」：
 * 兩種情況都算不出比率，硬算會變成 #DIV/0!；而填 0% 更糟，
 * 那會被讀成「有人下載卻沒人安裝」，實際上是「根本沒人下載」。
 */
function dayInstallRate(row) {
  return (
    '=IF(OR($B' + row + '="",$B' + row + '=0),"—",$C' + row + "/$B" + row + ")"
  );
}

/**
 * 當日卸載率＝當日卸載 ÷ 當日安裝（C＝當日安裝、D＝當日卸載）。
 * 當日安裝為 0 時顯示「—」（那天沒有安裝，卸載率沒有意義）。
 *
 * 注意這是「當日卸載 ÷ 當日安裝」，不是同一批人的留存率——
 * 沒有識別碼，無法把某次卸載對應到某次安裝，某天的卸載很可能來自更早的安裝。
 */
function dayUninstallRate(row) {
  return '=IF($C' + row + '=0,"—",$D' + row + "/$C" + row + ")";
}

/** 下載數的基準日＝最大的統計日。沒有資料就顯示「—」 */
function downloadsAsOf(dl) {
  return (
    "=IF(COUNTA(" + dl + 'A2:A)=0,"—",TEXT(MAX(' + dl + 'A2:A),"yyyy-mm-dd"))'
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
  // 統計日是純日期，所以直接等值比對；不必再用 >=X 且 <X+1 去掃時間戳
  var sameDay = dl + "$A:$A,$A" + row;
  return (
    "=IF(COUNTIFS(" + sameDay + "," + dl + '$F:$F,"<>")=0,"",' +
    "SUMIFS(" + dl + "$F:$F," + sameDay + "))"
  );
}

/** 某一週（起始日在 H 欄該列）的事件數 */
function weekCount(q, event, row, col) {
  return (
    '=COUNTIFS(' + q + '$B:$B,"' + event + '",' +
    q + '$A:$A,">="&$' + col + row + "," +
    q + '$A:$A,"<"&$' + col + row + '+7)'
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

/**
 * 要追蹤的發佈來源。每個 repo 寫進自己的分頁，彼此完全獨立。
 *
 * 分頁刻意不共用：「較上次新增」是拿同一張表裡「最近一筆不是今天的同名資產」
 * 來相減，兩個產品混在一張表雖然靠 (tag, 資產名稱) 也分得開，但「統計」分頁的
 * 漏斗公式是整欄加總的——混進第二個產品的下載數，MYmate 的安裝率會被稀釋成
 * 一個沒有意義的數字。分頁分開，既有公式一行都不用改。
 *
 * 新增產品就在這裡多加一列 {api, sheet}；分頁不存在會自動建立。
 */
var DOWNLOAD_SOURCES = [
  { api: GITHUB_RELEASES_API, sheet: DOWNLOAD_SHEET },
  {
    api: "https://api.github.com/repos/pcshen-mingyi/ai-social-worker-pack/releases",
    sheet: "下載-社工體驗包",
  },
];

/**
 * 「統計日」與「抓取時間」是兩件事，必須分開存：
 *
 *   統計日    這一列的數字代表哪一天的狀態（as-of）。分析、漏斗、按日對齊都看這一欄。
 *   抓取時間  我們實際去問 GitHub 的時刻（載入時間）。只用來查問題、判斷資料多新。
 *
 * 混在一欄的話，每次讀表都得先想「這一列其實是哪天」。分開之後：
 *   - 公式從區間比對（>=X 且 <X+1）變成等值比對（=X），不容易寫錯
 *   - 同一個統計日重複抓就是更新那一列，所以白天手動跑過、晚上排程再跑，
 *     最後留下的是 23:00 那個較完整的值——手動執行會自動被修正
 */
var DOWNLOAD_HEADERS = [
  "統計日",
  "抓取時間",
  "版本(tag)",
  "資產名稱",
  "累計下載",
  "較上次新增",
];

/** v2.1 早期的欄位結構（沒有「統計日」），用來偵測並自動升級 */
var DOWNLOAD_HEADERS_V1 = ["抓取時間", "版本(tag)", "資產名稱", "累計下載", "較上次新增"];

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

/**
 * 下載分頁；不存在就建。舊欄位結構會自動升級，標題列改名也會補正。
 * @param name 分頁名稱，省略時用 DOWNLOAD_SHEET（保留舊呼叫方式，setup() 仍能直接用）
 */
function downloadSheet(name) {
  var target = name || DOWNLOAD_SHEET;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(target) || ss.insertSheet(target);

  // 舊結構（沒有「統計日」）→ 在最前面插一欄，並用抓取時間的日期回填。
  // 不能只換標題列，那會讓既有資料整排錯位。
  var v1 = sh.getRange(1, 1, 1, DOWNLOAD_HEADERS_V1.length).getValues()[0];
  if (v1.join("|") === DOWNLOAD_HEADERS_V1.join("|")) {
    sh.insertColumnBefore(1);
    var last = sh.getLastRow();
    if (last >= 2) {
      var fetched = sh.getRange(2, 2, last - 1, 1).getValues();
      var asOf = [];
      for (var i = 0; i < fetched.length; i++) {
        var t = fetched[i][0];
        // 統計日＝抓取時間的日期部分（去掉時分秒）
        asOf.push([t instanceof Date ? new Date(t.getFullYear(), t.getMonth(), t.getDate()) : ""]);
      }
      sh.getRange(2, 1, asOf.length, 1).setValues(asOf).setNumberFormat("yyyy-mm-dd");
    }
    Logger.log("「下載」分頁已升級：新增「統計日」欄，並用抓取時間回填。");
  }

  // 分隔字元要用看得見的字元。用 NUL（\0）當分隔雖然能跑，
  // 但會讓整個檔案在 grep 眼中變成二進位檔而被跳過，機密掃描就失效了。
  var head = sh.getRange(1, 1, 1, DOWNLOAD_HEADERS.length);
  if (head.getValues()[0].join("|") !== DOWNLOAD_HEADERS.join("|")) {
    head.setValues([DOWNLOAD_HEADERS]).setFontWeight("bold");
    sh.setFrozenRows(1);
    sh.setColumnWidth(1, 100);
    sh.setColumnWidth(2, 150);
  }
  return sh;
}

/**
 * fetchDownloads()：走訪 DOWNLOAD_SOURCES 的每個來源，各自抓取並寫入自己的分頁。
 * 由每日觸發器呼叫，也可以手動執行。同一天重複執行只會更新，不會新增重複列。
 *
 * 每個來源獨立處理：某個 repo 抓失敗（斷線、404、改名）只會跳過那一個，
 * 其他來源照常寫入。這裡一樣不拋錯，避免每日觸發器寄失敗信。
 */
function fetchDownloads() {
  for (var s = 0; s < DOWNLOAD_SOURCES.length; s++) {
    fetchOneSource(DOWNLOAD_SOURCES[s]);
  }
}

/**
 * 抓單一來源並寫入它自己的分頁。
 * @param src {api, sheet}
 */
function fetchOneSource(src) {
  var label = "下載追蹤[" + src.sheet + "]：";
  var res;
  try {
    res = UrlFetchApp.fetch(src.api, {
      muteHttpExceptions: true,
      headers: { Accept: "application/vnd.github+json" },
    });
  } catch (err) {
    Logger.log(label + "連線失敗，本次跳過（不寫入）。" + err);
    return;
  }

  var code = res.getResponseCode();
  if (code !== 200) {
    Logger.log(label + "GitHub 回應 " + code + "，本次跳過（不寫入）。");
    return;
  }

  var releases;
  try {
    releases = JSON.parse(res.getContentText());
  } catch (err) {
    Logger.log(label + "JSON 解析失敗，本次跳過（不寫入）。");
    return;
  }
  if (!releases || !releases.length) {
    Logger.log(label + "沒有任何 Release，本次跳過（不寫入）。");
    return;
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tz = ss.getSpreadsheetTimeZone();
  var now = new Date();
  var today = Utilities.formatDate(now, tz, "yyyy-MM-dd");
  var asOf = new Date(now.getFullYear(), now.getMonth(), now.getDate()); // 統計日＝今天

  var sh = downloadSheet(src.sheet);
  var plan = planDownloadWrites(readDownloadRows(sh, tz), releases, today);
  if (!plan.length) {
    Logger.log(label + "Release 裡沒有任何資產可記錄，本次跳過（不寫入）。");
    return;
  }

  for (var i = 0; i < plan.length; i++) {
    var p = plan[i];
    var range = sh.getRange(p.row, 1, 1, 6);
    // 版本(tag) 與資產名稱存文字，否則 "2.0" 會被判成數字 2（與 writeRow 同一理由）
    range.setNumberFormats([
      ["yyyy-mm-dd", "yyyy/mm/dd hh:mm:ss", "@", "@", "0", "0"],
    ]);
    // 沒有前一次可比時寫空字串。空值與 0 是兩件事，不能用 0 冒充：
    // 填 0 會被讀成「那天沒人下載」，實際上是「還沒有基準可以比」。
    // 同理，某天漏抓就留空，那天的量會併進下一次成功抓取的差值裡。
    range.setValues([
      [asOf, now, p.tag, p.asset, p.total, p.delta === null ? "" : p.delta],
    ]);
  }
  Logger.log(
    label + "更新 " + countPlan(plan, true) + " 列、新增 " + countPlan(plan, false) + " 列。"
  );
}

/**
 * 讀出「下載」分頁現有資料列，轉成純資料好做判斷。
 * 日期一律取「統計日」（A 欄），不是抓取時間——分析與比對都以統計日為基準。
 */
function readDownloadRows(sh, tz) {
  var last = sh.getLastRow();
  if (last < 2) return [];
  var values = sh.getRange(2, 1, last - 1, 6).getValues();
  var out = [];
  for (var i = 0; i < values.length; i++) {
    var v = values[i];
    out.push({
      dateStr:
        v[0] instanceof Date
          ? Utilities.formatDate(v[0], tz, "yyyy-MM-dd")
          : String(v[0]).slice(0, 10),
      tag: String(v[2]),
      asset: String(v[3]),
      total: Number(v[4]),
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
