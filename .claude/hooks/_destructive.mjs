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

export const DESTRUCTIVE = [
  {
    re: /\brm\s+(-\S+\s+)*-\S*r\S*f/i,
    label: "強制遞迴刪除整個資料夾（rm -rf）",
    severe: true,
    targets: removeTargets,
  },
  { re: /\brm\b/, label: "刪除檔案（rm）", targets: removeTargets },
  { re: /\bRemove-Item\b/i, label: "刪除檔案（Remove-Item）", targets: removeTargets },
  {
    re: /\bgit\s+reset\s+--hard/,
    label: "捨棄所有未提交的修改（git reset --hard）",
    severe: true,
  },
  {
    re: /\bgit\s+clean\s+-\S*f/,
    label: "刪除所有未追蹤的檔案（git clean -f）",
    severe: true,
  },
  { re: /\btruncate\b/, label: "把檔案內容清空" },
  { re: /\bdd\b[^|]*\bof=/, label: "用 dd 直接覆寫檔案／磁碟", severe: true },
  {
    test: hasTruncatingRedirect,
    label: "覆寫檔案內容（> 把輸出寫進檔案，原本的內容會被蓋掉）",
    targets: redirectTargets,
  },
];

/** 找出第一個命中的規則；沒有就回 null */
export function matchDestructive(cmd = "") {
  return DESTRUCTIVE.find((d) => (d.test ? d.test(cmd) : d.re.test(cmd))) ?? null;
}

/**
 * 產生「會影響什麼」的說明。
 * 列不出來就明講列不出來——**不要生成一個假的數字**。
 * 具體但錯誤的數字比「無法判斷」更糟，因為它看起來很可信。
 */
export function describeScope(hit, cmd = "", max = 5) {
  const targets = typeof hit?.targets === "function" ? hit.targets(cmd) : [];
  if (targets.length === 0) {
    return "無法自動列出會影響哪些檔案（這不代表沒有影響，也不代表很多）。";
  }
  if (targets.length === 1) return `會影響：${targets[0]}`;
  const shown = targets.slice(0, max).map((t) => `  ・${t}`);
  const rest = targets.length > max ? `\n  ・…（其餘 ${targets.length - max} 個）` : "";
  return `會影響這 ${targets.length} 個目標：\n${shown.join("\n")}${rest}`;
}
