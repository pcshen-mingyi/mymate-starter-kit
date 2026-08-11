#!/usr/bin/env node
/**
 * install.mjs —— 把這個資料夾的 .claude/ 安裝到「使用者層級」（家目錄），
 * 讓自動攔阻真正生效，並在任何資料夾都能用。
 *
 * 跨平台：家目錄由 os.homedir() 判斷
 *   macOS   → ~/.claude/
 *   Windows → %USERPROFILE%\.claude\
 *
 * 用法：
 *   node install.mjs            實際安裝
 *   node install.mjs --dry-run  只顯示會做什麼，不動任何檔案
 *
 * 三個安全承諾：
 *   1. settings.json 一律「合併」不覆蓋，且寫檔前先驗證沒有動到使用者原有的東西。
 *   2. 安裝前保存「原貌」備份，重複安裝也還原得回去。
 *   3. 同名的 skill／hook 不會被無聲蓋掉——先備份成 <名稱>.before-mymate 再安裝。
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
const willBe = (m) => log(DRY ? `  · （試跑）將會${m}` : `  ✓ ${m}`);

/** macOS／Windows 產生的垃圾檔，不要跟著裝進使用者設定區 */
const isJunk = (name) => name === ".DS_Store" || name === "Thumbs.db";

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}
async function readJson(p, fb = {}) {
  try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return fb; }
}

/* ─────────── enabledPlugins 的兩種格式 ───────────
 * 陣列   ["a@b", "c@d"]
 * 對照表 { "a@b": true, "c@d": false }   ← Claude 目前實際寫入的格式
 * 一律要能處理，且輸出時沿用使用者原本的格式。
 */
const pluginKeys = (v) =>
  Array.isArray(v) ? [...v] : v && typeof v === "object" ? Object.keys(v) : [];
const isPluginMap = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/** 合併 plugin 清單：沿用使用者格式，只補他還沒有的；已存在的一律不動（含刻意設 false 的開關） */
function mergePlugins(mine, theirs) {
  const wanted = pluginKeys(theirs);
  if (isPluginMap(mine)) {
    const out = { ...mine };
    let added = 0;
    for (const k of wanted) if (!(k in out)) { out[k] = true; added += 1; }
    return { value: out, added };
  }
  const out = Array.isArray(mine) ? [...mine] : [];
  let added = 0;
  for (const k of wanted) if (!out.includes(k)) { out.push(k); added += 1; }
  return { value: out, added };
}

/** 陣列聯集（保留使用者原有順序，只在後面追加我們的）；非陣列一律當空陣列處理 */
const unionKeep = (mine, theirs = []) => {
  const out = Array.isArray(mine) ? [...mine] : [];
  for (const x of theirs) if (!out.includes(x)) out.push(x);
  return out;
};

/** 我們自己 hook 的檔名（用於精準辨識，避免動到使用者的 hook） */
const OUR_HOOK_FILES = ["block-delete.mjs", "block-sensitive.mjs", "confirm-send.mjs"];
const isOurHook = (cmd = "") => OUR_HOOK_FILES.some((f) => String(cmd).includes(f));

/**
 * 外科手術式合併：只碰我們管的欄位，其餘一律原封不動。
 * 不覆蓋既有值、不寫入我們的 _note、autoInstallEnabledPlugins 僅在未設過時寫入。
 */
function mergeSettings(current, incoming, destDir) {
  const out = JSON.parse(JSON.stringify(current));
  const changes = [];
  // 精確記錄「這次我們實際新增了什麼」——還原時只移除這些，不動使用者後來加的東西
  const added = {
    enabledPlugins: [],
    autoInstallEnabledPlugins: false,
    permissions: { deny: [], ask: [], allow: [] },
    // 哪些鍵在安裝前「本來不存在」——只有這些才可以在還原時清掉空殼
    createdKeys: [
      ...(current.permissions === undefined ? ["permissions"] : []),
      ...(current.enabledPlugins === undefined ? ["enabledPlugins"] : []),
      ...(current.hooks === undefined ? ["hooks"] : []),
    ],
  };

  // --- enabledPlugins：兩種格式都支援 ---
  if (pluginKeys(incoming.enabledPlugins).length) {
    const existed = new Set(pluginKeys(out.enabledPlugins));
    const { value, added: n } = mergePlugins(out.enabledPlugins, incoming.enabledPlugins);
    out.enabledPlugins = value;
    added.enabledPlugins = pluginKeys(incoming.enabledPlugins).filter((k) => !existed.has(k));
    if (n) changes.push(`新增 ${n} 個 plugin`);
  }

  // --- autoInstallEnabledPlugins：僅在使用者完全沒設過時寫入 ---
  if (out.autoInstallEnabledPlugins === undefined && incoming.autoInstallEnabledPlugins !== undefined) {
    out.autoInstallEnabledPlugins = incoming.autoInstallEnabledPlugins;
    added.autoInstallEnabledPlugins = true;
    changes.push("設定自動安裝 plugin");
  }

  // --- permissions：只對 deny/ask/allow 做聯集 ---
  if (incoming.permissions) {
    out.permissions ??= {};
    for (const k of ["deny", "ask", "allow"]) {
      if (Array.isArray(incoming.permissions[k]) && incoming.permissions[k].length) {
        const existed = new Set(Array.isArray(out.permissions[k]) ? out.permissions[k] : []);
        const before = existed.size;
        out.permissions[k] = unionKeep(out.permissions[k], incoming.permissions[k]);
        added.permissions[k] = incoming.permissions[k].filter((x) => !existed.has(x));
        const n = out.permissions[k].length - before;
        if (n) changes.push(`${k} 新增 ${n} 條規則`);
      }
    }
  }

  // --- hooks：只追加我們自己的，路徑改寫也只針對我們的 ---
  if (incoming.hooks) {
    out.hooks ??= {};
    for (const [event, groups] of Object.entries(incoming.hooks)) {
      if (!Array.isArray(groups)) continue;
      out.hooks[event] = Array.isArray(out.hooks[event]) ? out.hooks[event] : [];
      for (const g of groups) {
        const ours = (g.hooks ?? [])
          .filter((h) => isOurHook(h.command))
          .map((h) => ({
            ...h,
            command: String(h.command).replace(
              /node\s+[^\s]*hooks[/\\]/,
              `node ${path.join(destDir, "hooks")}${path.sep}`
            ),
          }));
        if (!ours.length) continue;

        const same = out.hooks[event].find((x) => (x.matcher ?? "") === (g.matcher ?? ""));
        if (same) {
          same.hooks = Array.isArray(same.hooks) ? same.hooks : [];
          for (const h of ours) {
            const which = (c) => OUR_HOOK_FILES.find((f) => String(c).includes(f));
            const dup = same.hooks.find((e) => isOurHook(e.command) && which(e.command) === which(h.command));
            if (dup) dup.command = h.command;
            else { same.hooks.push(h); changes.push(`${event} 新增護欄`); }
          }
        } else {
          out.hooks[event].push({ ...g, hooks: ours });
          changes.push(`${event} 新增護欄`);
        }
      }
    }
  }

  return { merged: out, changes, added };
}

/** 寫檔前驗證：使用者原有的一切都必須完整保留 */
function verifyNoClobber(before, after) {
  const MANAGED = new Set(["enabledPlugins", "autoInstallEnabledPlugins", "permissions", "hooks"]);
  const problems = [];

  for (const [k, v] of Object.entries(before)) {
    if (MANAGED.has(k)) continue;
    if (!(k in after)) problems.push(`遺失欄位 ${k}`);
    else if (JSON.stringify(after[k]) !== JSON.stringify(v)) problems.push(`欄位 ${k} 被更動`);
  }

  const afterPlugins = pluginKeys(after.enabledPlugins);
  for (const x of pluginKeys(before.enabledPlugins))
    if (!afterPlugins.includes(x)) problems.push(`遺失 plugin ${x}`);
  // 對照表格式：使用者原本的開關值（含刻意關掉的 false）不能被改
  if (isPluginMap(before.enabledPlugins)) {
    for (const [k, v] of Object.entries(before.enabledPlugins))
      if (after.enabledPlugins?.[k] !== v) problems.push(`plugin ${k} 的開關被更動`);
  }

  for (const k of ["deny", "ask", "allow"]) {
    const list = before.permissions?.[k];
    if (!Array.isArray(list)) continue;
    for (const x of list)
      if (!after.permissions?.[k]?.includes(x)) problems.push(`遺失 ${k} 規則 ${x}`);
  }

  for (const [ev, groups] of Object.entries(before.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups)
      for (const h of g.hooks ?? []) {
        const still = (after.hooks?.[ev] ?? []).some((ag) =>
          (ag.hooks ?? []).some((ah) => ah.command === h.command)
        );
        if (!still) problems.push(`使用者原有的 ${ev} hook 被更動或移除`);
      }
  }
  return problems;
}

async function copyDir(from, to) {
  await fs.mkdir(to, { recursive: true });
  for (const e of await fs.readdir(from, { withFileTypes: true })) {
    if (isJunk(e.name)) continue;
    const s = path.join(from, e.name);
    const d = path.join(to, e.name);
    if (e.isDirectory()) await copyDir(s, d);
    else await fs.copyFile(s, d);
  }
}

/**
 * 安裝一個目錄下的項目，並保護使用者的同名項目：
 * 若目的地已存在同名、且不是我們上次裝的，先備份成 <名稱>.before-mymate。
 */
async function installItems(kind, manifest) {
  const from = path.join(SRC, kind);
  if (!(await exists(from))) { warn(`來源沒有 ${kind}/，略過`); return []; }

  const items = (await fs.readdir(from)).filter((f) => !isJunk(f));
  const ownedBefore = new Set(manifest[kind] ?? []);
  const installed = [];

  for (const name of items) {
    const src = path.join(from, name);
    const dst = path.join(DEST, kind, name);

    if ((await exists(dst)) && !ownedBefore.has(name)) {
      // 使用者原本就有同名的東西 → 先保住它
      const keep = dst + ".before-mymate";
      if (!(await exists(keep))) {
        if (!DRY) await fs.cp(dst, keep, { recursive: true });
        warn(`你原本就有同名的 ${name}，已備份為 ${name}.before-mymate`);
        manifest.preserved = [...new Set([...(manifest.preserved ?? []), `${kind}/${name}`])];
      }
    }

    if (!DRY) {
      const st = await fs.stat(src);
      if (st.isDirectory()) await copyDir(src, dst);
      else { await fs.mkdir(path.dirname(dst), { recursive: true }); await fs.copyFile(src, dst); }
    }
    installed.push(name);
  }

  manifest[kind] = [...new Set([...(manifest[kind] ?? []), ...installed])];
  return installed;
}

async function main() {
  log("━".repeat(56));
  log(" MYmate 小白包 —— 安裝到使用者層級");
  log("━".repeat(56));
  log(`平台      ：${platform()}`);
  log(`來源      ：${SRC}`);
  log(`安裝目標  ：${DEST}`);
  if (DRY) log(`模式      ：DRY RUN（不會實際修改任何檔案）`);

  if (!(await exists(SRC))) {
    console.error(`\n✗ 找不到 ${SRC}，請確認你在小白包資料夾內執行。`);
    process.exit(1);
  }

  const manifest = await readJson(MANIFEST, {});

  // 1. 備份
  step("備份現有設定");
  const destSettings = path.join(DEST, "settings.json");
  const PRISTINE = path.join(DEST, "settings.mymate-original.json");
  if (await exists(destSettings)) {
    if (!(await exists(PRISTINE))) {
      if (!DRY) await fs.copyFile(destSettings, PRISTINE);
      willBe(`保存安裝前原貌 → ${path.basename(PRISTINE)}（僅供緊急參考，還原不會直接套用它）`);
    } else {
      ok(`安裝前原貌已存在，保持不變（${path.basename(PRISTINE)}）`);
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const snap = path.join(DEST, `settings.backup-${stamp}.json`);
    if (!DRY) await fs.copyFile(destSettings, snap);
    willBe(`留一份本次快照 → ${path.basename(snap)}`);
  } else {
    ok("目前沒有既有 settings.json，無需備份");
  }

  // 2. 合併 settings
  step("合併 settings.json（不覆蓋你原有的設定）");
  const { _note, ...incoming } = await readJson(path.join(SRC, "settings.json"));
  const current = await readJson(destSettings);
  const { merged, changes, added } = mergeSettings(current, incoming, DEST);

  const problems = verifyNoClobber(current, merged);
  if (problems.length) {
    console.error("\n✗ 安全檢查未通過，已中止（未修改任何檔案）：");
    problems.forEach((x) => console.error("   - " + x));
    console.error("\n請把上面訊息回報給維護者。");
    process.exit(1);
  }
  ok("安全檢查通過：使用者原有設定完整保留");

  if (!DRY) {
    await fs.mkdir(DEST, { recursive: true });
    await fs.writeFile(destSettings, JSON.stringify(merged, null, 2) + "\n", "utf8");
  }
  if (changes.length) changes.forEach((c) => ok(c));
  else ok("沒有需要新增的項目（可能已安裝過）");

  // 3. 安裝 skills / hooks
  for (const kind of ["skills", "hooks"]) {
    step(`安裝 ${kind}/`);
    const installed = await installItems(kind, manifest);
    if (installed.length) ok(`${installed.length} 項：${installed.join("、")}`);
  }

  // 記錄「我們加了什麼」，供還原時精準移除（重複安裝時做聯集，不覆蓋）
  const prev = manifest.settingsAdded ?? {};
  manifest.settingsAdded = {
    enabledPlugins: [...new Set([...(prev.enabledPlugins ?? []), ...added.enabledPlugins])],
    autoInstallEnabledPlugins: prev.autoInstallEnabledPlugins || added.autoInstallEnabledPlugins,
    permissions: {
      deny: [...new Set([...(prev.permissions?.deny ?? []), ...added.permissions.deny])],
      ask: [...new Set([...(prev.permissions?.ask ?? []), ...added.permissions.ask])],
      allow: [...new Set([...(prev.permissions?.allow ?? []), ...added.permissions.allow])],
    },
    // 首次安裝時記錄即可；重複安裝時這些鍵早已存在，不該再被視為我們建立的
    createdKeys: prev.createdKeys ?? added.createdKeys,
  };

  if (!DRY) {
    manifest.updatedAt = new Date().toISOString();
    await fs.writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  }

  await sendStat("install", DRY);

  log("\n" + "━".repeat(56));
  log(DRY ? " DRY RUN 結束，未修改任何檔案。" : " 安裝完成！請完全關掉 Claude App 再重開（Mac 按 Cmd+Q）。");
  log("━".repeat(56));
  const notice = statsNotice();
  if (notice) log("\n" + notice);
  if (!DRY) {
    log("\n如需完整還原（settings + skills + hooks）：node uninstall.mjs");
    log("先看會做什麼：node uninstall.mjs --dry-run");
    log("還原時只會移除本包加入的項目，你之後自己新增的設定都會保留。");
  }
}

main().catch((e) => {
  console.error("\n✗ 安裝失敗：", e.message);
  process.exit(1);
});
