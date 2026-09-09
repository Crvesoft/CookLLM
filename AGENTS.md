# CookLLM Agent 指南与操作规范

## 1. `docs/` 目录定位与提交规则（最高准则）

- **定位**：`docs/` 目录仅用于存放 `README.md` 中引用的演示截图及维护者文档（如 `发布指引.md`），不参与 Tauri 应用打包与源码构建。
- **仅 `docs/` 变动时的处理规范**：
  - 当项目内**仅有 `docs/` 目录下的文件存在修改**（如用户更新了截图图片、修改了文档），且用户要求提交/更新时：
    1. **仅提交到 GitHub**：执行 `git add docs/`、`git commit -m "docs: ..."` 并 `git push origin master`；
    2. **禁止修改版本号**：绝不要修改 `package.json`、`Cargo.toml`、`src/data.ts` 等任何版本号；
    3. **禁止重新编译**：无需运行 `npm run build` 或 `cargo check`；
    4. **禁止发布版本与打 Tag**：严禁创建或推送 `v*` Tag，绝不触发 GitHub Actions Release workflow。

## 2. 软件版本发布规则

- 只有在**实际修改了应用功能/代码**，且**用户明确要求发版**（如输入“发版”、“版本号+1”、“发布新版本”）时，才执行完整的发版流程：
  - 详细规范见 `docs/发布指引.md`：
    - 同步更新 6 处版本号（`package.json`、`package-lock.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`、`src/data.ts`）；
    - 在 `CHANGELOG.md` 与 `README.md` 中同步追加更新日志；
    - 执行 `npm run build` 与 `cargo check` 验证；
    - 提交代码并打 `vX.Y.Z` Tag 推送触发自动化构建。
