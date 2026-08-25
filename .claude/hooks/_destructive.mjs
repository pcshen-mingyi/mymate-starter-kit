/**
 * 危險動作的判斷邏輯（純函式，沒有副作用，可以單獨測試）。
 *
 * 為什麼要獨立成一個檔案：這裡的判斷錯了會有兩種後果，而且**假警報的長期
 * 傷害比漏報更大**——使用者看過幾次「⚠️ 可能無法復原」而實際什麼都沒發生
 * 之後，就不會再讀警示，然後真正該擋的那一次也會被按過去。
 * 警示的價值來自它很少響，所以這裡的規則寧可精準也不要寬鬆。
 *
 * 實際踩過的誤判（每一個都有對應的回歸測試）：
 *   1. `find . -name ".git" 2>/dev/null` → 判成「覆寫檔案內容，約 10 個目標」。
 *      原因：`2>`（錯誤訊息重導向）跟 `>`（覆寫）混為一談；而且「目標」是把
 *      整行指令的每個詞都算進去，不是真正的重導向目標。
 *   2. 建立測試檔的 `cat > f <<'EOF' … EOF`，內容裡寫到 `rm -rf` → 判成真的要刪。
 *      原因：heredoc 中間那段是**要寫進檔案的內容**，不是要執行的指令。
 *   3. `node -e '… (e) => e.name …'` 純讀取 docx → 判成「覆蓋檔案內容，會影響 10 個」。
 *      原因：判斷時完全沒考慮 shell 的引號。引號裡整段是 JavaScript，
 *      那些 `>` 是箭頭函式和 XML 標籤，shell 不會把它當符號。
 *      同一個成因也會誤攔 `python3 -c 'print(1 > 0)'` 和 `echo "a > b"`。
 */

/**
 * 寫進去就消失、或根本不是檔案的目標。重導向到這些位置不會有任何檔案被改動。
 * `/dev/null` 是系統黑洞裝置；`NUL` 是 Windows 的對應物。
 */
const NULL_SINKS = /^(\/dev\/null|\/dev\/stdout|\/dev\/stderr|\/dev\/tty|NUL)$/i;

/** 整行指令被接給 shell 執行——引號／heredoc 裡的東西真的會跑，不能略過。 */
const PIPES_TO_SHELL = /\|\s*(bash|sh|zsh|dash|python\d?)\b/;

/**
 * 引號緊接在 shell 直譯器後面（`bash -c '…'`、`eval "…"`）。
 * 這種引號裡的內容**真的會被當指令執行**，所以不能略過。
 * `node -e`、`python -c`、`awk`、`sed` 不在此列——那些是別的語言，
 * shell 的重導向符號在裡面沒有意義。
 */
const SHELL_ARG_TAIL = /(?:^|[\s|&;(])(?:eval|bash|sh|zsh|dash|ksh)\s+(?:-\S+\s+)*$/;

/** 佔位符的前後綴。用控制字元，才不會跟指令裡真實出現的字撞到。 */
const MARK = String.fromCharCode(1);

/**
 * 把引號裡的內容換成佔位符，原文另存一份。
 *
 * 這是誤判 3 的修法。shell 的 `>`、`rm`、`&&` 在引號裡都只是普通字元，
 * 所以「這是不是危險指令」必須看**去掉引號內容之後**的樣子；
 * 而「會影響哪些檔案」又需要把引號還原回來（`echo x > "my file.txt"`）。
 * 兩個需求方向相反，所以是換成佔位符，而不是直接刪掉。
 */
export function maskQuoted(cmd = "") {
  const strings = [];
  let masked = "";
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    // 引號外的反斜線轉義：連同下一個字原樣保留
    if (ch === "\\" && i + 1 < cmd.length) {
      masked += ch + cmd[i + 1];
      i++;
      continue;
    }
    if (ch !== '"' && ch !== "'") {
      masked += ch;
      continue;
    }
    // 找這個引號的結尾。單引號裡沒有轉義；雙引號裡的 \" 不算結尾。
    let end = -1;
    for (let j = i + 1; j < cmd.length; j++) {
      if (ch === '"' && cmd[j] === "\\") { j++; continue; }
      if (cmd[j] === ch) { end = j; break; }
    }
    if (end === -1) { masked += cmd.slice(i); break; } // 引號沒收尾，保守起見原樣保留
    const body = cmd.slice(i + 1, end);
    if (SHELL_ARG_TAIL.test(masked)) {
      masked += body; // bash -c '…'：內容真的會執行，不能略過
    } else {
      strings.push(body);
      masked += MARK + (strings.length - 1) + MARK;
    }
    i = end;
  }
  return { masked, strings };
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
  if (PIPES_TO_SHELL.test(cmd)) return cmd;
  return cmd.replace(
    /<<-?\s*(['"]?)([A-Za-z_]\w*)\1[\s\S]*?(?:\n|^)\2[ \t]*(?=\n|$)/g,
    " <<檔案內容已略過>> "
  );
}

/**
 * 把一行指令整理成「真的會被 shell 當成語法的部分」，供後面所有判斷共用。
 * 回傳 `code`（heredoc 已略過、引號內容已換成佔位符）與 `strings`（引號原文）。
 */
export function shellView(cmd = "") {
  const stripped = stripHeredocs(cmd);
  if (PIPES_TO_SHELL.test(stripped)) return { code: stripped, strings: [] };
  const { masked, strings } = maskQuoted(stripped);
  return { code: masked, strings };
}

/** 把佔位符還原成引號裡的原文 */
function unmask(token, strings) {
  return token.replace(
    new RegExp(MARK + "(\\d+)" + MARK, "g"),
    (_, n) => strings[Number(n)] ?? ""
  );
}

/**
 * 找出「會截斷檔案」的重導向目標。必須區分五件事，否則就會誤報：
 *
 *   >  file        截斷覆寫 → 真的有風險
 *   2> file        錯誤訊息寫進檔案，同樣會截斷 → 有風險
 *   >> file        附加到結尾 → 不會毀掉原有內容 → 不算
 *   2>/dev/null    丟進系統黑洞 → 沒有任何檔案被碰到 → 不算（最常見的誤判來源）
 *   2>&1           把錯誤併進標準輸出 → 沒有檔案 → 不算
 *   "a > b"        在引號裡 → shell 不當它是符號 → 不算（第二常見的誤判來源）
 */
export function redirectTargets(cmd = "") {
  const { code, strings } = shellView(cmd);
  const out = [];
  // 四個守衛，少一個就會誤判：
  //   (?<![>=]) 前面不是 > 或 = → 排除 `>> file` 的第二個 >，以及箭頭函式 `=>`
  //   (?![>&])  後面不是 > 或 & → 排除 >>（附加）與 >&（描述符合併，如 2>&1）
  //   引號內容已換成佔位符 → 引號裡的 > 根本不會進到這裡
  //   NULL_SINKS 過濾 → 排除 /dev/null 這類黑洞
  const re = /(?<![>=])(?:\d+|&)?>(?![>&])\s*([^\s>|&;]+)/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const target = unmask(m[1], strings).replace(/^["']|["']$/g, "");
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
  const { code, strings } = shellView(cmd);
  const out = [];
  const re = /\b(?:rm|Remove-Item)\b([^|&;]*)/gi;
  let m;
  while ((m = re.exec(code)) !== null) {
    for (const tok of m[1].trim().split(/\s+/)) {
      if (!tok || tok.startsWith("-")) continue;
      if (/^[|&;><]/.test(tok)) continue;
      out.push(unmask(tok, strings).replace(/^["']|["']$/g, ""));
    }
  }
  return out;
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
  const { code } = shellView(cmd);
  return DESTRUCTIVE.find((d) => (d.test ? d.test(cmd) : d.re.test(code))) ?? null;
}

/**
 * 產生一行「會影響什麼」。刻意壓成一行——訊息太長使用者就不會讀，
 * 而讀不到重點跟沒有警示的效果一樣。
 *
 * 列不出來就明講列不出來，**不要生成一個假的數字**。
 * 具體但錯誤的數字比「無法判斷」更糟，因為它看起來很可信。
 */
export function describeScope(hit, cmd = "", max = 3) {
  const targets = typeof hit?.targets === "function" ? hit.targets(cmd) : [];
  if (targets.length === 0) return "無法自動列出影響範圍";
  const shown = targets.slice(0, max).join("、");
  if (targets.length <= max) return `會影響：${shown}`;
  return `會影響 ${targets.length} 個：${shown}…還有 ${targets.length - max} 個`;
}
