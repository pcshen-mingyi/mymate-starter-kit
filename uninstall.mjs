#!/usr/bin/env node
/**
 * uninstall.mjs —— 移除 install.mjs 加上去的東西。
 *
 * 核心原則：**精準移除，不是回到過去。**
 * 從「目前的」settings.json 逐項拆掉本包當初加入的項目，
 * 使用者在安裝之後自己新增的設定一律原樣保留。
 *
 *   1. 依 .mymate-manifest.json 的 settingsAdded 紀錄，移除本包加入的
 *      plugin 開關、權限規則、autoInstallEnabledPlugins；hooks 以本包檔名辨識。
 *      （沒有紀錄時才退回「比對本包內容」推斷，並會提醒使用者。）
 *   2. 只移除「本包安裝的」skills / hooks 檔案（同樣依 manifest 判斷）。
 *   3. 還原安裝時被保護起來的同名項目（<名稱>.before-mymate）。
 *   4. 偵測並告知已被自動下載的 plugin（不代為刪除）。
 *
 * 註：settings.mymate-original.json 與時間戳快照仍會保留，但**不會自動套用**——
 *     那是「上次安裝當下」的樣子，直接套用會抹掉使用者之後新增的設定。
 *     僅供萬一需要時人工比對。
 *
 * 用法：
 *   node uninstall.mjs --dry-run   只顯示會做什麼
 *   node uninstall.mjs             實際還原
 */
import { homedir, platform } from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { sendStat, statsNotice } from "./_stats.mjs";

const DRY = process.argv.includes("--dry-run");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, ".claude");
const DEST = path.join(homedir(), ".claude");
const MANIFEST = path.join(DEST, ".mymate-manifest.json");

const log = (...a) => console.log(...a);
const step = (m) => log(`\n▸ ${m}`);
const ok = (m) => log(`  ✓ ${m}`);
const warn = (m) => log(`  ! ${m}`);

const isJunk = (n) => n === ".DS_Store" || n === "Thumbs.db";
const pluginKeys = (v) =>
  Array.isArray(v) ? [...v] : v && typeof v === "object" ? Object.keys(v) : [];

async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }
async function readJson(p, fb = {}) {
  try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return fb; }
}

/**
 * 偵測本包的 plugin 是否已被實際下載到電腦。
 * install.mjs 會寫入 autoInstallEnabledPlugins，App 重啟後會把 plugin
 * 下載到 ~/.claude/plugins/cache/ 並登記在 installed_plugins.json。
 * 還原只移除 settings 的開關，**檔案與登記都還在** —— 必須誠實告訴使用者。
 */
async function detectDownloadedPlugins(names) {
  const pluginsDir = path.join(DEST, "plugins");
  const found = new Map();

  // (a) 登記檔
  const reg = path.join(pluginsDir, "installed_plugins.json");
  if (await exists(reg)) {
    const data = await readJson(reg, {});
    const keys = new Set();
    const walk = (v) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object")
        for (const [k, val] of Object.entries(v)) { keys.add(k); walk(val); }
    };
    walk(data);
    for (const full of names) {
      const short = full.split("@")[0];
      if (keys.has(full) || keys.has(short)) found.set(full, ["installed_plugins.json"]);
    }
  }

  // (b) 下載快取
  const cache = path.join(pluginsDir, "cache");
  if (await exists(cache)) {
    let entries = [];
    try { entries = await fs.readdir(cache); } catch {}
    for (const full of names) {
      const short = full.split("@")[0];
      const hit = entries.find((e) => e === short || e.includes(short));
      if (hit) {
        const where = found.get(full) ?? [];
        where.push(`plugins/cache/${hit}`);
        found.set(full, where);
      }
    }
  }

  return [...found.entries()].map(([name, where]) => ({ name, where: where.join(" + ") }));
}

async function main() {
  log("━".repeat(56));
  log(" MYmate 小白包 —— 還原安裝");
  log("━".repeat(56));
  log(`平台     ：${platform()}`);
  log(`還原目標 ：${DEST}`);
  if (DRY) log(`模式     ：DRY RUN（不會實際修改任何檔案）`);

  if (!(await exists(DEST))) { log("\n這台電腦沒有使用者層級設定，無需還原。"); return; }

  const ourSettings = await readJson(path.join(SRC, "settings.json"));
  const manifest = await readJson(MANIFEST, {});

  // 1. 從「目前的」settings.json 精準移除本包加入的項目
  //    ⚠️ 刻意不採用「還原快照」的做法：快照是上次安裝當下的狀態，
  //    直接套用會把使用者之後自己新增的設定（例如新的 hook、新的 plugin）一起抹掉。
  step("移除本包加入的設定（保留你之後自己新增的）");
  const destSettings = path.join(DEST, "settings.json");
  const rec = manifest.settingsAdded;

  if (!(await exists(destSettings))) {
    ok("沒有 settings.json，略過");
  } else {
    const cur = await readJson(destSettings);
    const removed = [];

    // 決定要移除哪些：優先用安裝紀錄；沒有紀錄才退回「比對本包內容」
    let rmPlugins, rmPerms, rmAutoInstall;
    if (rec) {
      rmPlugins = new Set(rec.enabledPlugins ?? []);
      rmPerms = rec.permissions ?? {};
      rmAutoInstall = !!rec.autoInstallEnabledPlugins;
    } else {
      warn("找不到安裝紀錄，改用「比對本包內容」推斷（可能移除你原本就有的同名規則）");
      rmPlugins = new Set(pluginKeys(ourSettings.enabledPlugins));
      rmPerms = ourSettings.permissions ?? {};
      rmAutoInstall = ourSettings.autoInstallEnabledPlugins !== undefined;
    }

    // (a) plugin 開關
    if (rmPlugins.size) {
      if (Array.isArray(cur.enabledPlugins)) {
        const b = cur.enabledPlugins.length;
        cur.enabledPlugins = cur.enabledPlugins.filter((x) => !rmPlugins.has(x));
        if (b !== cur.enabledPlugins.length) removed.push(`${b - cur.enabledPlugins.length} 個 plugin 開關`);
      } else if (cur.enabledPlugins && typeof cur.enabledPlugins === "object") {
        let n = 0;
        for (const k of Object.keys(cur.enabledPlugins))
          if (rmPlugins.has(k)) { delete cur.enabledPlugins[k]; n += 1; }
        if (n) removed.push(`${n} 個 plugin 開關`);
      }
    }

    // (b) autoInstallEnabledPlugins：只有當初是我們設的才移除
    if (rmAutoInstall && "autoInstallEnabledPlugins" in cur) {
      delete cur.autoInstallEnabledPlugins;
      removed.push("自動安裝設定");
    }

    // (c) 權限規則
    const touchedPerm = [];
    for (const k of ["deny", "ask", "allow"]) {
      const ours = new Set(rmPerms?.[k] ?? []);
      if (!ours.size || !Array.isArray(cur.permissions?.[k])) continue;
      const b = cur.permissions[k].length;
      cur.permissions[k] = cur.permissions[k].filter((x) => !ours.has(x));
      const n = b - cur.permissions[k].length;
      if (n) { removed.push(`${n} 條 ${k} 規則`); touchedPerm.push(k); }
    }
    // 清空殼：只清「當初由我們建立」的鍵，使用者自己原本就有的空結構一律保留
    const createdByUs = new Set(rec?.createdKeys ?? []);

    for (const k of touchedPerm)
      if (Array.isArray(cur.permissions?.[k]) && !cur.permissions[k].length) delete cur.permissions[k];
    if (createdByUs.has("permissions") && cur.permissions && !Object.keys(cur.permissions).length)
      delete cur.permissions;

    if (createdByUs.has("enabledPlugins") && rmPlugins.size) {
      const left = Array.isArray(cur.enabledPlugins)
        ? cur.enabledPlugins.length
        : cur.enabledPlugins && typeof cur.enabledPlugins === "object"
        ? Object.keys(cur.enabledPlugins).length
        : null;
      if (left === 0) delete cur.enabledPlugins;
    }

    // (d) hooks：以我們的檔名精準辨識，不會誤刪使用者的
    let hookN = 0;
    for (const [event, groups] of Object.entries(cur.hooks ?? {})) {
      if (!Array.isArray(groups)) continue;
      const kept = [];
      for (const g of groups) {
        const before = (g.hooks ?? []).length;
        g.hooks = (g.hooks ?? []).filter(
          (h) => !/(block-delete|block-sensitive|confirm-send)\.mjs/.test(h.command ?? "")
        );
        hookN += before - g.hooks.length;
        if (g.hooks.length) kept.push(g);
      }
      if (kept.length) cur.hooks[event] = kept; else delete cur.hooks[event];
    }
    if (hookN) removed.push(`${hookN} 個護欄`);
    if (createdByUs.has("hooks") && cur.hooks && !Object.keys(cur.hooks).length) delete cur.hooks;

    if (!DRY) await fs.writeFile(destSettings, JSON.stringify(cur, null, 2) + "\n", "utf8");
    ok(removed.length ? `已移除：${removed.join("、")}` : "沒有需要移除的設定");
    ok("你在安裝之後自己新增的設定，都原樣保留");
  }

  // 快照僅作為緊急參考，不主動套用
  const files = await fs.readdir(DEST);
  const PRISTINE_NAME = "settings.mymate-original.json";
  const backups = files.filter((f) => /^settings\.backup-.*\.json$/.test(f));
  if ((await exists(path.join(DEST, PRISTINE_NAME))) || backups.length) {
    log(`    （另有 ${PRISTINE_NAME} 與 ${backups.length} 份快照保留著；`);
    log(`      那是「上次安裝當下」的樣子，僅供萬一需要時人工比對，不會自動套用）`);
  }

  // 2. 只移除「本包裝的」項目
  for (const kind of ["hooks", "skills"]) {
    step(`移除本包的 ${kind}`);
    const owned = Array.isArray(manifest[kind]) ? manifest[kind].filter((f) => !isJunk(f)) : null;
    let list;
    if (owned && owned.length) {
      // 舊版安裝紀錄可能夾帶 .DS_Store，這裡一併濾掉，避免顯示看不懂的項目
      list = owned;
    } else {
      // 沒有 manifest（舊版安裝）→ 退回用 bundle 內容推斷
      const from = path.join(SRC, kind);
      list = (await exists(from)) ? (await fs.readdir(from)).filter((f) => !isJunk(f)) : [];
      if (list.length) warn("找不到安裝紀錄，改依本包內容推斷要移除哪些項目");
    }

    let n = 0;
    for (const name of list) {
      const target = path.join(DEST, kind, name);
      if (await exists(target)) {
        if (!DRY) await fs.rm(target, { recursive: true, force: true });
        n += 1;
      }
      // 還原安裝時被保護起來的同名項目
      const keep = target + ".before-mymate";
      if (await exists(keep)) {
        if (!DRY) { await fs.cp(keep, target, { recursive: true }); await fs.rm(keep, { recursive: true, force: true }); }
        ok(`已把你原本的 ${name} 放回去`);
      }
    }
    ok(n ? `已移除 ${n} 項：${list.join("、")}` : `沒有需要移除的 ${kind}`);
  }

  // 3. 檢查自動下載的 plugin（我們不自行刪除，但必須誠實告知）
  step("檢查自動下載的 plugin");
  const ourPluginNames = pluginKeys(ourSettings.enabledPlugins);
  const foundPlugins = await detectDownloadedPlugins(ourPluginNames);
  if (foundPlugins.length) {
    warn("下列 plugin 當初因為自動安裝設定而被下載到你的電腦：");
    foundPlugins.forEach((f) => log(`      ‧ ${f.name}   （位置：${f.where}）`));
    log("");
    log("    這些是 Claude 自己管理的檔案，本工具**不會**代為刪除，");
    log("    以免弄壞你的 plugin 狀態。要移除請在 Claude 對話框執行：");
    foundPlugins.forEach((f) => log(`      /plugin uninstall ${f.name}`));
    log("");
    log("    （settings.json 裡的開關已隨還原移除，重開後不會再自動下載。）");
  } else {
    ok("沒有偵測到本包帶進來的 plugin，或它們已被移除");
  }

  // 4. 清掉安裝紀錄
  if (await exists(MANIFEST)) {
    if (!DRY) await fs.rm(MANIFEST, { force: true });
    ok("已清除安裝紀錄");
  }

  await sendStat("uninstall", DRY);

  log("\n" + "━".repeat(56));
  log(DRY ? " DRY RUN 結束，未修改任何檔案。" : " 還原完成！請完全關掉 Claude App 再重開（Mac 按 Cmd+Q）。");
  log("━".repeat(56));
  const notice = statsNotice();
  if (notice) log("\n" + notice);
  if (!foundPlugins.length) {
    log("\n註：若之後發現仍有本包帶進來的 plugin，可在 Claude 對話框執行：");
    log("    /plugin uninstall claude-code-setup@claude-plugins-official");
  }
}

main().catch((e) => {
  console.error("\n✗ 還原失敗：", e.message);
  process.exit(1);
});
