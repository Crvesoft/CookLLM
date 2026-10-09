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
  - 详细规范见 `docs/发布指引.md`，**必须优先使用项目内置的发布脚本执行自动化发版**：
    1. 提升版本：运行 `npm run release:bump -- <patch|minor|major>`（自动同步 6 处版本号并在 `CHANGELOG.md` 与 `README.md` 插入占位段落）；
    2. 完善说明：根据本次实际改动内容，编辑 `CHANGELOG.md` 与 `README.md`，将占位符「- 待补充」替换为真实更新日志；
    3. 执行发布：运行 `npm run release -- --yes`（脚本会自动执行版本核对、日志校验、`npm run build` 和 `cargo check` 编译检查、安全暂存、创建提交并打 `vX.Y.Z` Tag 推送至 GitHub 触发 Release workflow）；
    4. 严禁人工手动逐个文件替换版本号，防止漏改或破坏 README 的 5 版本截断规范。

## 3. 功能开发与代码修改完成后的构建规范

- 在完成功能开发与代码修改后，除执行基本的类型与语法检查外，主动为用户执行完整的本地编译打包（`npm run tauri build`），确保可执行文件产物就绪供用户直接使用与验证。

