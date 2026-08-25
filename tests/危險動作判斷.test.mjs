/**
 * 危險動作判斷的回歸測試。
 *
 *   node tests/危險動作判斷.test.mjs
 *
 * 這裡守的是兩條方向相反的線：
 *   1. 真正會毀掉資料的動作**必須**被攔（漏報 → 使用者失去檔案）
 *   2. 純讀取的動作**絕對不能**被誤攔（假警報 → 使用者學會無腦按允許，
 *      然後真正該擋的那次也被按過去）
 *
 * 第 2 條是這個檔案存在的原因：
 * `find . -name ".git" 2>/dev/null` 曾被判定為「覆寫檔案內容，約 10 個目標」。
 */
import { matchDestructive, describeScope, redirectTargets, removeTargets } from "../.claude/hooks/_destructive.mjs";

let pass = 0, fail = 0;
const ck = (name, ok, detail) => {
  if (ok) { pass++; console.log("✓ " + name); }
  else { fail++; console.log("✗ " + name + (detail ? "\n    " + detail : "")); }
};
const flagged = (cmd) => matchDestructive(cmd) !== null;

console.log("── 不該被攔：純讀取的指令 ──");
const safe = [
  ['find . -name ".git" 2>/dev/null', "當初的誤判案例"],
  ['cd "/tmp/x" && ls -la && echo "---" && find . -maxdepth 3 -name ".git" 2>/dev/null', "完整的原始案例"],
  ["ls -la", "列目錄"],
  ["cat README.md", "讀檔"],
  ["grep -rn foo . 2>/dev/null", "搜尋並丟掉錯誤訊息"],
  ["node --version 2>/dev/null", "查版本"],
  ["echo hello", "只印到畫面"],
  ["git status", "看狀態"],
  ["command 2>&1 | head", "錯誤併進標準輸出"],
  ["echo hi >> log.txt", "附加不會毀掉原內容"],
  ["ls > /dev/null", "輸出丟進黑洞"],
  ["ls &>/dev/null", "全部丟進黑洞"],
];
for (const [cmd, why] of safe) ck(`${why}：${cmd}`, !flagged(cmd), "被誤攔了");

console.log("\n── 必須被攔：真的會毀資料 ──");
const dangerous = [
  ["rm -rf /tmp/x", "強制遞迴刪除"],
  ["rm notes.txt", "刪檔"],
  ["git reset --hard HEAD~1", "捨棄未提交的修改"],
  ["git clean -fd", "刪未追蹤檔案"],
  ["truncate -s 0 log.txt", "清空檔案"],
  ["echo x > important.txt", "截斷覆寫"],
  ["cat a.txt > b.txt", "覆寫另一個檔案"],
  ["ls 2> errors.txt", "錯誤訊息寫進真的檔案（同樣會截斷）"],
  ["dd if=/dev/zero of=/tmp/disk", "dd 覆寫"],
];
for (const [cmd, why] of dangerous) ck(`${why}：${cmd}`, flagged(cmd), "沒被攔到");

console.log("\n── 重導向目標要抓對，不是抓整行的詞 ──");
ck("2>/dev/null 沒有目標", redirectTargets("find . 2>/dev/null").length === 0);
ck("> out.txt 抓到 out.txt", redirectTargets("echo x > out.txt")[0] === "out.txt");
ck('引號內含空白也抓得到', redirectTargets('echo x > "my file.txt"')[0] === "my file.txt");
ck(">> 不算（附加）", redirectTargets("echo x >> log.txt").length === 0);
ck("2>&1 不算（沒有檔案）", redirectTargets("cmd 2>&1").length === 0);
ck("同時有黑洞與真檔案時只抓真檔案",
  JSON.stringify(redirectTargets("cmd > real.txt 2>/dev/null")) === JSON.stringify(["real.txt"]));

console.log("\n── rm 的目標只看 rm 自己的參數 ──");
ck("不會把 ls／echo 算成刪除目標",
  JSON.stringify(removeTargets('ls -la && echo hi && rm a.txt b.txt')) === JSON.stringify(["a.txt", "b.txt"]));
ck("旗標不算目標", JSON.stringify(removeTargets("rm -rf dir")) === JSON.stringify(["dir"]));

console.log("\n── 說明文字：算不出來要明講，不能編數字 ──");
{
  const hit = matchDestructive("git reset --hard HEAD~1");
  const scope = describeScope(hit, "git reset --hard HEAD~1");
  ck("沒有可列舉目標時明講無法列出", scope.includes("無法自動列出影響範圍"), scope);
  ck("不會出現「約 N 個目標」這種假數字", !/約 \d+ 個目標/.test(scope), scope);
}
{
  const cmd = "rm a.txt b.txt c.txt";
  const scope = describeScope(matchDestructive(cmd), cmd);
  ck("能列舉時逐項列出", scope.includes("a.txt") && scope.includes("c.txt"), scope);
  ck("三個以內全部列出，不顯示數量前綴", scope.startsWith("會影響：") && scope.includes("b.txt"), scope);
}

console.log("\n── heredoc：寫進檔案的內容不是要執行的指令 ──");
{
  const write = ["cat > tests/t.mjs <<'EOF'", "const cases = ['rm -rf /tmp/x'];", "EOF", "node tests/t.mjs"].join("\n");
  const hit = matchDestructive(write);
  ck("不會被誤判成 rm -rf", hit && !hit.label.includes("資料夾"), hit ? hit.label : "無命中");
  ck("正確判定為寫入檔案", hit && hit.label.includes("覆蓋"), hit ? hit.label : "無命中");
  ck("目標是被寫入的檔案，不是 heredoc 內容的詞",
    describeScope(hit, write) === "會影響：tests/t.mjs", describeScope(hit, write));
  ck("接給 bash 執行時仍會攔（內容真的會跑）",
    matchDestructive("echo 'rm -rf /x' | bash") !== null);
}

console.log("\n── 引號裡的符號不是 shell 符號（實際踩過的誤判 3）──");
{
  // 原始案例：用 node -e 讀 docx 的文字，全程唯讀，被判成「覆蓋檔案內容，會影響 10 個」
  const readDocx = [
    'cd "/Users/x/AI 社工同事體驗包 v2/個案訪視紀錄工具包" && node -e \'',
    'import("./shared/lib/zip.mjs").then(async ({readZip}) => {',
    '  const entries = readZip("../個人工作/CASE-001 訪視逐字稿.docx");',
    '  const docEntry = entries.find(e => e.name === "word/document.xml");',
    '  const paras = docEntry.data.toString("utf8").split(/<\\/w:p>/).map(p => {',
    '    return [...p.matchAll(/<w:t[^>]*>([^<]*)<\\/w:t>/g)].map(m => m[1]).join("");',
    '  }).filter(t => t.trim().length > 0);',
    '  console.log(paras.join("\\n"));',
    "});'",
  ].join("\n");
  ck("node -e 唯讀讀取 docx 不該被攔", !flagged(readDocx), "被誤攔了");
}
const quoted = [
  ["node -e 'const f = (a) => a + 1'", "箭頭函式的 => 不是重導向"],
  ["python3 -c 'print(1 > 0)'", "比較運算子不是重導向"],
  ['echo "a > b"', "引號裡的純文字"],
  ["git log --format='%h %s' | head", "格式字串"],
  ['grep -rn "rm -rf" .', "搜尋「rm -rf」這串字，不是要執行它"],
  ['echo "會刪掉整個資料夾" ', "說明文字提到刪除"],
];
for (const [cmd, why] of quoted) ck(`${why}：${cmd}`, !flagged(cmd), "被誤攔了");

console.log("\n── 但引號裡真的會被執行時，仍然要攔 ──");
const reallyRuns = [
  ["bash -c 'rm -rf /tmp/x'", "bash -c 的內容就是指令"],
  ['sh -c "echo x > f.txt"', "sh -c 裡的重導向是真的"],
  ['eval "rm -rf /tmp/x"', "eval 一定執行"],
  ["echo 'rm -rf /x' | bash", "接給 bash"],
];
for (const [cmd, why] of reallyRuns) ck(`${why}：${cmd}`, flagged(cmd), "沒被攔到");
ck("bash -c 'rm -rf' 判定為最高級別",
  matchDestructive("bash -c 'rm -rf /tmp/x'")?.severe === true);

console.log("\n── 引號還原：被引號包住的目標仍要列得出來 ──");
ck('重導向目標在引號裡', redirectTargets('echo x > "my file.txt"')[0] === "my file.txt",
  JSON.stringify(redirectTargets('echo x > "my file.txt"')));
ck("刪除目標在引號裡", removeTargets('rm "my file.txt"')[0] === "my file.txt",
  JSON.stringify(removeTargets('rm "my file.txt"')));
ck("引號沒收尾時保守處理，該攔的照攔", flagged('echo x > out.txt "沒收尾'));

console.log("\n── 訊息長度：太長就不會被讀 ──");
{
  const cmd = "rm a.txt b.txt c.txt d.txt e.txt f.txt";
  const scope = describeScope(matchDestructive(cmd), cmd);
  ck("多目標時壓成一行", !scope.includes("\n"), scope);
  ck("最多列三個並說明還有幾個", scope.includes("…還有 3 個"), scope);
}

console.log(`\n結果：${pass} 通過、${fail} 失敗`);
process.exit(fail === 0 ? 0 : 1);
