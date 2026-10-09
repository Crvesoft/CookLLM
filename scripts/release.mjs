#!/usr/bin/env node
/**
 * CookLLM 版本号自动化与发布工作流脚本
 *
 * 用法：
 *   node scripts/release.mjs check
 *       检查当前 6 处版本号一致性与 CHANGELOG/README 日志状态
 *
 *   node scripts/release.mjs bump <patch|minor|major|x.y.z> [--dry-run]
 *       提升版本号，同步 6 处文件，并在 CHANGELOG.md / README.md 插入更新日志占位段落
 *
 *   node scripts/release.mjs publish [--yes] [--skip-check]
 *       发版自动化：
 *       1. 校验 6 处版本号严格一致
 *       2. 校验 CHANGELOG.md 与 README.md 是否已填写真实说明（拦截「- 待补充」）
 *       3. 检查 Tag 是否已存在，防止重复发版
 *       4. 执行 npm run build 与 cargo check 编译验证（可通过 --skip-check 跳过）
 *       5. 精准暂存 6 处版本文件 + 2 处文档文件，创建 release 提交并打 Tag
 *       6. 推送 master 与 Tag 到 GitHub 触发 Release workflow
 *
 * 6 处版本文件：
 *   1. package.json
 *   2. package-lock.json
 *   3. src-tauri/tauri.conf.json
 *   4. src-tauri/Cargo.toml
 *   5. src-tauri/Cargo.lock
 *   6. src/data.ts
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

/** [文件相对路径, 版本提取函数, 版本写入函数]（均在 LF 内容上操作） */
const VERSION_FILES = [
  [
    "package.json",
    (s) => JSON.parse(s).version,
    (s, v) => JSON.stringify({ ...JSON.parse(s), version: v }, null, 2) + "\n",
  ],
  [
    "package-lock.json",
    (s) => JSON.parse(s).version,
    (s, v) => {
      const j = JSON.parse(s);
      j.version = v;
      if (j.packages && j.packages[""]) {
        j.packages[""].version = v;
      }
      return JSON.stringify(j, null, 2) + "\n";
    },
  ],
  [
    "src-tauri/tauri.conf.json",
    (s) => JSON.parse(s).version,
    (s, v) => JSON.stringify({ ...JSON.parse(s), version: v }, null, 2) + "\n",
  ],
  [
    "src-tauri/Cargo.toml",
    (s) => s.match(/\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m)?.[1] || s.match(/^version\s*=\s*"([^"]+)"/m)?.[1],
    (s, v) => s.replace(/(\[package\][\s\S]*?^version\s*=\s*")[^"]+(")/m, `$1${v}$2`),
  ],
  [
    "src-tauri/Cargo.lock",
    (s) => s.match(/name = "cookllm"\nversion = "([^"]+)"/)?.[1],
    (s, v) => s.replace(/(name = "cookllm"\nversion = ")[^"]+(")/, `$1${v}$2`),
  ],
  [
    "src/data.ts",
    (s) => s.match(/APP_VERSION = "([^"]+)"/)?.[1],
    (s, v) => s.replace(/APP_VERSION = "[^"]+"/, `APP_VERSION = "${v}"`),
  ],
];

const RELEASE_FILES = [
  ...VERSION_FILES.map(([file]) => file),
  "CHANGELOG.md",
  "README.md",
];

function bumpVersion(cur, target) {
  if (/^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/.test(target)) {
    return target;
  }
  const [maj, min, pat] = cur.split(".").map(Number);
  if ([maj, min, pat].some((n) => Number.isNaN(n))) {
    throw new Error(`无法解析当前版本号: ${cur}`);
  }
  if (target === "major") return `${maj + 1}.0.0`;
  if (target === "minor") return `${maj}.${min + 1}.0`;
  if (target === "patch") return `${maj}.${min}.${pat + 1}`;
  throw new Error(`无法识别的目标版本: "${target}"。支持: patch | minor | major 或具体版本号如 0.3.2`);
}

function insertChangelog(s, v) {
  if (new RegExp(`^## v${v.replace(/\./g, "\\.")}$`, "m").test(s)) {
    throw new Error(`CHANGELOG.md 已存在 ## v${v} 段落`);
  }
  const stub = `## v${v}\n\n- 待补充\n\n`;
  const m = s.search(/^## v\d/m);
  if (m === -1) return s.replace(/\n*$/, "\n") + stub;
  return s.slice(0, m) + stub + s.slice(m);
}

function insertReadme(s, v) {
  if (new RegExp(`^### v${v.replace(/\./g, "\\.")}$`, "m").test(s)) {
    throw new Error(`README.md 已存在 ### v${v} 段落`);
  }
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

function extractChangelogSection(changelog, v) {
  const escaped = v.replace(/\./g, "\\.");
  const regex = new RegExp(`^## v${escaped}\\s*\\n([\\s\\S]*?)(?=\\n## v|$)`, "m");
  const match = changelog.match(regex);
  return match ? match[1].trim() : null;
}

function extractReadmeSection(readme, v) {
  const escaped = v.replace(/\./g, "\\.");
  const regex = new RegExp(`^### v${escaped}\\s*\\n([\\s\\S]*?)(?=\\n### v|\\n## |$)`, "m");
  const match = readme.match(regex);
  return match ? match[1].trim() : null;
}

function validateReleaseState(v, checkLogs = true) {
  const problems = [];
  for (const [file, extract] of VERSION_FILES) {
    try {
      const got = extract(readLF(file));
      if (got !== v) {
        problems.push(`${file} 版本为 ${got}（期望 ${v}）`);
      }
    } catch (err) {
      problems.push(`${file} 解析版本失败: ${err.message}`);
    }
  }

  if (checkLogs) {
    const changelogSec = extractChangelogSection(readLF("CHANGELOG.md"), v);
    if (!changelogSec) {
      problems.push(`CHANGELOG.md 缺少 ## v${v} 段落`);
    } else if (changelogSec.includes("- 待补充") || changelogSec.length < 5) {
      problems.push(`CHANGELOG.md 中 ## v${v} 仍包含占位符「- 待补充」或内容为空，请先填写真实更新说明`);
    }

    const readmeSec = extractReadmeSection(readLF("README.md"), v);
    if (!readmeSec) {
      problems.push(`README.md 缺少 ### v${v} 段落`);
    } else if (readmeSec.includes("- 待补充") || readmeSec.length < 5) {
      problems.push(`README.md 中 ### v${v} 仍包含占位符「- 待补充」或内容为空，请先填写真实更新说明`);
    }
  }

  return problems;
}

function cmdCheck() {
  const v = JSON.parse(readLF("package.json")).version;
  console.log(`🔍 正在检查版本一致性与更新日志 (当前版本: v${v})...`);
  const problems = validateReleaseState(v, true);
  if (problems.length > 0) {
    console.error("❌ 检查未通过:\n  - " + problems.join("\n  - "));
    process.exit(1);
  }
  console.log(`✅ 校验通过: 6 处版本号一致 (v${v})，CHANGELOG.md 与 README.md 日志就绪。`);
}

function cmdBump(target, dryRun) {
  const cur = JSON.parse(readLF("package.json")).version;
  const next = bumpVersion(cur, target);
  const changes = VERSION_FILES.map(([file, , transform]) => [file, transform(readLF(file), next)]);
  changes.push(["CHANGELOG.md", insertChangelog(readLF("CHANGELOG.md"), next)]);
  changes.push(["README.md", insertReadme(readLF("README.md"), next)]);

  if (dryRun) {
    console.log(`[dry-run] ${cur} → ${next}`);
    for (const [file] of changes) console.log(`  将修改: ${file}`);
    return;
  }

  for (const [file, content] of changes) writeLF(file, content);
  console.log(`\n🎉 已成功提升版本: ${cur} → ${next}`);
  console.log("   - 6 处版本文件已同步");
  console.log("   - CHANGELOG.md 与 README.md 已插入新版本占位段落");
  console.log(`\n👉 下一步操作:`);
  console.log(`   1. 打开 CHANGELOG.md 与 README.md，将「- 待补充」替换为本次实际更新内容；`);
  console.log(`   2. 运行 npm run release -- --yes 进行编译校验并自动发版。`);
}

function cmdPublish(skipCheck) {
  const v = JSON.parse(readLF("package.json")).version;
  const problems = validateReleaseState(v, true);

  if (problems.length) {
    console.error("\n❌ 发布前校验失败:\n  - " + problems.join("\n  - "));
    console.error("\n请修复上述问题后再运行发布命令。");
    process.exit(1);
  }

  // 检查 Tag 是否已经存在
  try {
    const existingTag = execSync(`git tag -l "v${v}"`, { cwd: root, encoding: "utf8" }).trim();
    if (existingTag) {
      console.error(`\n❌ 发布中止: Tag v${v} 已经在本地仓库中存在！`);
      console.error(`若需重新发布该版本，请先按照 docs/发布指引.md 清除本地和远端 Tag；若发布新版本请先执行 bump。`);
      process.exit(1);
    }
  } catch {}

  // 检查工作区是否有其他未跟踪或未暂存文件，输出友好提醒
  try {
    const statusOutput = execSync("git status --porcelain", { cwd: root, encoding: "utf8" }).trim();
    if (statusOutput) {
      const lines = statusOutput.split("\n").map((l) => l.trim()).filter(Boolean);
      const otherFiles = lines.filter((l) => {
        const file = l.slice(3).trim();
        return !RELEASE_FILES.some((rf) => file === rf || file.endsWith("/" + rf));
      });
      if (otherFiles.length > 0) {
        console.log(`\n⚠️  提示: 检测到工作区存在未提交的其他修改 (${otherFiles.length} 个文件):`);
        for (const f of otherFiles.slice(0, 5)) console.log(`   ${f}`);
        if (otherFiles.length > 5) console.log(`   ...等共 ${otherFiles.length} 个文件`);
        console.log("   本次发布将仅精确提交 6 处版本文件与更新日志，不会夹带其他未完成的改动。\n");
      }
    }
  } catch {}

  console.log(`\n✅ 基础校验通过: v${v}（6 处版本一致，更新日志就位）`);

  // 发版前本地构建与语法检查
  if (!skipCheck) {
    console.log("\n🛠️  [1/2] 正在执行前端构建与类型校验 (npm run build)...");
    execSync("npm run build", { cwd: root, stdio: "inherit" });
    console.log("✅ 前端校验通过");

    console.log("\n🦀 [2/2] 正在执行 Rust 后端校验 (cargo check)...");
    execSync("cargo check --manifest-path src-tauri/Cargo.toml", { cwd: root, stdio: "inherit" });
    console.log("✅ Rust 后端校验通过");
  } else {
    console.log("\n⚠️  已跳过本地编译检查 (--skip-check)");
  }

  // 精准暂存发布文件
  console.log("\n📦 正在暂存版本文件与更新日志...");
  for (const f of RELEASE_FILES) {
    git(`add "${f}"`);
  }

  // 提交与打 Tag
  console.log(`📝 创建提交: release: v${v}`);
  try {
    git(`commit -m "release: v${v}"`);
  } catch {
    console.log("ℹ️  版本文件未变动或已在先前提交中包含");
  }

  console.log(`🏷️  创建 Tag: v${v}`);
  git(`tag v${v}`);

  console.log("🚀 推送 master 分支与 Tag 至 GitHub 远端仓库...");
  git("push origin master");
  git(`push origin v${v}`);

  console.log(`\n🎉 发布流程执行完毕！已推送 master 与 tag v${v}，GitHub Actions Release workflow 已触发构建。`);
}

const [, , cmd, arg] = process.argv;
const dryRun = process.argv.includes("--dry-run");
const skipCheck = process.argv.includes("--skip-check");

if (cmd === "check") {
  cmdCheck();
} else if (cmd === "bump") {
  if (!arg || arg.startsWith("--")) {
    console.error("用法: node scripts/release.mjs bump <patch|minor|major|x.y.z> [--dry-run]");
    process.exit(1);
  }
  cmdBump(arg, dryRun);
} else if (cmd === "publish") {
  if (!process.argv.includes("--yes")) {
    console.error("\n⚠️  防误触保护: publish 将执行编译校验并触发 commit + tag + push 操作。");
    console.error("确认版本号已升级、更新日志已补充无误后，请使用以下命令执行发布:");
    console.error("  npm run release -- --yes\n  (或 node scripts/release.mjs publish --yes)\n");
    process.exit(1);
  }
  cmdPublish(skipCheck);
} else {
  console.error("用法: node scripts/release.mjs <check|bump|publish>");
  console.error("示例:");
  console.error("  node scripts/release.mjs check");
  console.error("  node scripts/release.mjs bump patch");
  console.error("  node scripts/release.mjs bump 0.4.0 --dry-run");
  console.error("  node scripts/release.mjs publish --yes");
  process.exit(1);
}