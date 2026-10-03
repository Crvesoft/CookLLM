#!/usr/bin/env node
/**
 * CookLLM 版本号自动化
 *
 * 用法：
 *   node scripts/release.mjs bump <patch|minor|major> [--dry-run]
 *       提升版本号，同步 6 处文件，并在 CHANGELOG.md / README.md 插入占位段落
 *   node scripts/release.mjs publish --yes
 *       校验 6 处版本一致且更新日志就位后：commit + tag + push
 *       （不带 --yes 只打印提示，不执行 git 操作）
 *
 * 6 处版本文件：package.json / package-lock.json / src-tauri/tauri.conf.json
 *               src-tauri/Cargo.toml / src-tauri/Cargo.lock / src/data.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const git = (cmd) => execSync(`git ${cmd}`, { cwd: root, stdio: "inherit" });

/** 按 LF 读取（Windows 检出的 CRLF 文件统一转 LF 处理） */
const readLF = (p) => {
  const s = readFileSync(join(root, p), "utf8");
  return s.includes("\r\n") ? s.replace(/\r\n/g, "\n") : s;
};
/** 写回时恢复文件原有的行尾风格 */
const writeLF = (p, s) => {
  const crlf = readFileSync(join(root, p), "utf8").includes("\r\n");
  writeFileSync(join(root, p), crlf ? s.replace(/\n/g, "\r\n") : s);
};

/** [文件, 版本提取, 版本写入]（均在 LF 内容上操作） */
const VERSION_FILES = [
  ["package.json",
    (s) => JSON.parse(s).version,
    (s, v) => JSON.stringify({ ...JSON.parse(s), version: v }, null, 2) + "\n"],
  ["package-lock.json",
    (s) => JSON.parse(s).version,
    (s, v) => {
      const j = JSON.parse(s);
      j.version = v;
      j.packages[""].version = v;
      return JSON.stringify(j, null, 2) + "\n";
    }],
  ["src-tauri/tauri.conf.json",
    (s) => JSON.parse(s).version,
    (s, v) => JSON.stringify({ ...JSON.parse(s), version: v }, null, 2) + "\n"],
  ["src-tauri/Cargo.toml",
    (s) => s.match(/^version = "([^"]+)"$/m)?.[1],
    (s, v) => s.replace(/^version = "[^"]+"$/m, `version = "${v}"`)],
  ["src-tauri/Cargo.lock",
    (s) => s.match(/name = "cookllm"\nversion = "([^"]+)"/)?.[1],
    (s, v) => s.replace(/(name = "cookllm"\nversion = ")[^"]+(")/, `$1${v}$2`)],
  ["src/data.ts",
    (s) => s.match(/APP_VERSION = "([^"]+)"/)?.[1],
    (s, v) => s.replace(/APP_VERSION = "[^"]+"/, `APP_VERSION = "${v}"`)],
];

function bumpVersion(v, part) {
  const [maj, min, pat] = v.split(".").map(Number);
  if ([maj, min, pat].some((n) => Number.isNaN(n))) throw new Error(`无法解析版本号: ${v}`);
  if (part === "major") return `${maj + 1}.${min}.${pat}`;
  if (part === "minor") return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

function insertChangelog(s, v) {
  if (new RegExp(`^## v${v}$`, "m").test(s)) throw new Error(`CHANGELOG.md 已存在 ## v${v} 段落`);
  const stub = `## v${v}\n\n- 待补充\n\n`;
  const m = s.search(/^## v\d/m);
  if (m === -1) return s.replace(/\n*$/, "\n") + stub;
  return s.slice(0, m) + stub + s.slice(m);
}

function insertReadme(s, v) {
  if (new RegExp(`^### v${v}$`, "m").test(s)) throw new Error(`README.md 已存在 ### v${v} 段落`);
  const marker = "## ✅ 更新日志";
  const idx = s.indexOf(marker);
  if (idx === -1) throw new Error("README.md 未找到「## ✅ 更新日志」区块");
  const next = s.search(/^### v[\d.]+$/m);
  if (next === -1 || next < idx) throw new Error("README.md 更新日志区块未找到版本段落");
  const stub = `### v${v}\n\n- 待补充\n\n`;
  let out = s.slice(0, next) + stub + s.slice(next);
  // 更新日志区块只保留最近 5 个版本
  const start = out.indexOf(marker);
  const end = out.indexOf("\n## ", start + 1);
  if (end !== -1) {
    const area = out.slice(start, end);
    const heads = [...area.matchAll(/^### v[\d.]+$/gm)];
    if (heads.length > 5) {
      const cut = heads[5]; // 第 6 个版本区块起点
      out = out.slice(0, start) + area.slice(0, cut.index) + out.slice(end);
    }
  }
  return out;
}

function cmdBump(part, dryRun) {
  const cur = JSON.parse(readLF("package.json")).version;
  const next = bumpVersion(cur, part);
  const changes = VERSION_FILES.map(([file, , transform]) => [file, transform(readLF(file), next)]);
  changes.push(["CHANGELOG.md", insertChangelog(readLF("CHANGELOG.md"), next)]);
  changes.push(["README.md", insertReadme(readLF("README.md"), next)]);
  if (dryRun) {
    console.log(`[dry-run] ${cur} → ${next}`);
    for (const [file] of changes) console.log(`  将修改: ${file}`);
    return;
  }
  for (const [file, content] of changes) writeLF(file, content);
  console.log(`已提升版本: ${cur} → ${next}（6 处已同步，CHANGELOG/README 已插入占位段落）`);
  console.log(`下一步: 填写 CHANGELOG.md 与 README.md 的「- 待补充」，然后运行 node scripts/release.mjs publish --yes`);
}

function cmdPublish() {
  const v = JSON.parse(readLF("package.json")).version;
  const problems = [];
  for (const [file, extract] of VERSION_FILES) {
    const got = extract(readLF(file));
    if (got !== v) problems.push(`${file} 版本为 ${got}（期望 ${v}）`);
  }
  if (!new RegExp(`^## v${v}$`, "m").test(readLF("CHANGELOG.md"))) problems.push(`CHANGELOG.md 缺少 ## v${v} 段落`);
  if (!new RegExp(`^### v${v}$`, "m").test(readLF("README.md"))) problems.push(`README.md 缺少 ### v${v} 段落`);
  if (problems.length) {
    console.error("发布前校验失败:\n  - " + problems.join("\n  - "));
    process.exit(1);
  }
  console.log(`校验通过: v${v}（6 处版本一致，更新日志就位）`);
  git("add -A");
  git(`commit -m "release: v${v}"`);
  git(`tag v${v}`);
  git("push origin master");
  git(`push origin v${v}`);
  console.log(`已推送 master 与 tag v${v}，GitHub Actions Release workflow 已触发`);
}

const [, , cmd, arg] = process.argv;
const dryRun = process.argv.includes("--dry-run");
if (cmd === "bump") {
  if (!["patch", "minor", "major"].includes(arg)) {
    console.error("用法: node scripts/release.mjs bump <patch|minor|major> [--dry-run]");
    process.exit(1);
  }
  cmdBump(arg, dryRun);
} else if (cmd === "publish") {
  if (!process.argv.includes("--yes")) {
    console.error("publish 将执行 commit + tag + push。确认版本号与更新日志无误后运行: node scripts/release.mjs publish --yes");
    process.exit(1);
  }
  cmdPublish();
} else {
  console.error("用法: node scripts/release.mjs <bump|publish>");
  process.exit(1);
}