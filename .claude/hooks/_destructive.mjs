/**
 * 危險動作的判斷邏輯（純函式，沒有副作用，可以單獨測試）。
 *
 * 為什麼要獨立成一個檔案：這裡的判斷錯了會有兩種後果，而且**假警報的長期
 * 傷害比漏報更大**——使用者看過幾次「⚠️ 可能無法復原」而實際什麼都沒發生
 * 之後，就不會再讀警示，然後真正該擋的那一次也會被按過去。
 * 警示的價值來自它很少響，所以這裡的規則寧可精準也不要寬鬆。
 *
 * 實際踩過的誤判：`find . -name ".git" 2>/dev/null` 被判定為
 * 「覆寫檔案內容，約 10 個目標」。那個指令是純讀取、零寫入。
 * 原因有兩個，都修在這個檔案裡：
 *   1. `2>`（錯誤訊息重導向）跟 `>`（覆寫檔案）被當成同一件事
 *   2. 「目標」是把整行指令的每個詞都算進去，不是真正的重導向目標
 */

/**
 * 寫進去就消失、或根本不是檔案的目標。重導向到這些位置不會有任何檔案被改動。
 * `/dev/null` 是系統黑洞裝置；`NUL` 是 Windows 的對應物。
 */
const NULL_SINKS = /^(\/dev\/null|\/dev\/stdout|\/dev\/stderr|\/dev\/tty|NUL)$/i;

/**
 * 找出「會截斷檔案」的重導向目標。必須區分四件事，否則就會誤報：
 *
 *   >  file        截斷覆寫 → 真的有風險
 *   2> file        錯誤訊息寫進檔案，同樣會截斷 → 有風險
 *   >> file        附加到結尾 → 不會毀掉原有內容 → 不算
 *   2>/dev/null    丟進系統黑洞 → 沒有任何檔案被碰到 → 不算（最常見的誤判來源）
 *   2>&1           把錯誤併進標準輸出 → 沒有檔案 → 不算
 */
export function redirectTargets(cmd = "") {
  const out = [];
  // 三個守衛，少一個就會誤判：
  //   (?<!>)   前面不是 > → 否則 `>> file` 的第二個 > 會被當成截斷覆寫
  //   (?![>&]) 後面不是 > 或 & → 排除 >>（附加）與 >&（描述符合併，如 2>&1）
  //   NULL_SINKS 過濾 → 排除 /dev/null 這類黑洞
  const re = /(?<!>)(?:\d+|&)?>(?![>&])\s*("[^"]*"|'[^']*'|[^\s>|&;]+)/g;
  let m;
  while ((m = re.exec(cmd)) !== null) {
    const target = m[1].replace(/^["']|["']$/g, "");
    if (!target || NULL_SINKS.test(target)) continue;
    out.push(target);
  }
  return out;
}

export function hasTruncatingRedirect(cmd = "") {
  return redirectTargets(cmd).length > 0;
}

/**
 * 找出 rm／Remove-Item 真正要刪的東西。
 * 只看那個指令自己的參數，不是整行指令的每個詞——原本的做法會把
 * `ls`、`echo`、`3`、路徑被空白切碎的片段全部算成「目標」。
 */
export function removeTargets(cmd = "") {
  const out = [];
  const re = /\b(?:rm|Remove-Item)\b([^|&;]*)/gi;
  let m;
  while ((m = re.exec(cmd)) !== null) {
    for (const tok of m[1].trim().split(/\s+/)) {
      if (!tok || tok.startsWith("-")) continue;
      if (/^[|&;><]/.test(tok)) continue;
      out.push(tok.replace(/^["']|["']$/g, ""));
    }
  }
  return out;
}

/**
 * 把 heredoc 的內容拿掉再判斷。
 *
 * `cat > f.mjs <<'EOF' … EOF` 中間那一大段是**要寫進檔案的內容**，不是要執行的指令。
 * 不拿掉的話，內容裡出現的 `rm -rf`（測試案例、說明文件都很常寫到）會被誤判成
 * 真的要刪東西——實際踩過：建立測試檔的指令被判成「rm -rf，約 235 個目標」。
 *
 * 例外：內容被接給 shell 執行時（`| bash`、`| sh`）就真的會跑，那時不能忽略。
 */
export function stripHeredocs(cmd = "") {
  if (/\|\s*(bash|sh|zsh|dash|python\d?)\b/.test(cmd)) return cmd;
  return cmd.replace(
    /<<-?\s*(['"]?)([A-Za-z_]\w*)\1[\s\S]*?(?:\n|^)\2[ \t]*(?=\n|$)/g,
    " <<檔案內容已略過>> "
  );
}

export const DESTRUCTIVE = [
  {
    re: /\brm\s+(-\S+\s+)*-\S*r\S*f/i,
    label: "刪掉整個資料夾，連裡面所有東西一起",
    severe: true,
    targets: removeTargets,
  },
  { re: /\brm\b/, label: "刪掉檔案", targets: removeTargets },
  { re: /\bRemove-Item\b/i, label: "刪掉檔案", targets: removeTargets },
  {
    re: /\bgit\s+reset\s+--hard/,
    label: "丟掉還沒存進版本紀錄的修改",
    severe: true,
  },
  {
    re: /\bgit\s+clean\s+-\S*f/,
    label: "刪掉沒被版本控管的檔案",
    severe: true,
  },
  { re: /\btruncate\b/, label: "把檔案內容清空" },
  { re: /\bdd\b[^|]*\bof=/, label: "直接覆寫檔案或磁碟", severe: true },
  {
    test: hasTruncatingRedirect,
    label: "覆蓋檔案內容，原本的內容會消失",
    targets: redirectTargets,
  },
];

/** 找出第一個命中的規則；沒有就回 null */
export function matchDestructive(cmd = "") {
  const c = stripHeredocs(cmd);
  return DESTRUCTIVE.find((d) => (d.test ? d.test(c) : d.re.test(c))) ?? null;
}

/**
 * 產生一行「會影響什麼」。刻意壓成一行——訊息太長使用者就不會讀，
 * 而讀不到重點跟沒有警示的效果一樣。
 *
 * 列不出來就明講列不出來，**不要生成一個假的數字**。
 * 具體但錯誤的數字比「無法判斷」更糟，因為它看起來很可信。
 */
export function describeScope(hit, cmd = "", max = 3) {
  const c = stripHeredocs(cmd);
  const targets = typeof hit?.targets === "function" ? hit.targets(c) : [];
  if (targets.length === 0) return "無法自動列出影響範圍";
  const shown = targets.slice(0, max).join("、");
  if (targets.length <= max) return `會影響：${shown}`;
  return `會影響 ${targets.length} 個：${shown}…還有 ${targets.length - max} 個`;
}
