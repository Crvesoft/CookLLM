# 🦙 CookLLM

> **本地大模型服务调度器** —— 专为 `llama.cpp` / `GGUF` 打造的现代化 Windows 桌面管理工具。
> 集成模型仓库、运行预设、一键启停、实时日志与内置会话于一体。

![CookLLM 截图](docs/screenshot.png)

---

## ✨ 核心特性

* 🗂 **模型仓库**
  * **便捷导入**：支持直接拖放文件/目录、原生文件选择，自动递归扫描并去重
  * **智能解析**：自动从文件名提取模型架构、参数量与量化格式（如 `Q4_K_M`）
  * **精细管理**：支持多维度搜索（名称/路径/架构）、重命名、快速移除及默认模型设定
  * **独立隔离**：每个模型拥有专属的运行预设方案

* 🎛 **运行预设**
  * **开箱即用**：内置「均衡模式」、「深度思考」、「低显存」三套经典方案
  * **深度参数**：支持 GPU 卸载层数、上下文长度、Batch / uBatch、Flash Attention、KV Cache 类型、Jinja 模板、Reasoning 强度（xhigh/medium/low）、mmap 加载以及采样参数等
  * **灵活扩展**：支持预设的新建、克隆、删除及自定义 CLI 额外参数注入

* 🚀 **一键启停与进程管控**
  * 由 Rust 原生托管 `llama-server` 子进程，状态自动轮询（PID / 端口）
  * 停止时采用 `taskkill /T /F` 强制终结完整进程树，彻底告别显存卡死

* 📟 **实时日志系统**
  * 实时捕获 `stdout` / `stderr`，按 **ERR / WRN / SYS / OUT** 级别彩色渲染
  * 提供底部高度自适应的控制台抽屉与独立完整日志页

* 💬 **内置会话与 OpenAI 兼容**
  * 基于标准 `/v1/chat/completions` 实现开箱即用的测试对话与历史持久化
  * 启动后本地暴露标准 `/v1` 接口，可无缝对接各类第三方客户端

* ⚙️ **纯本地与隐私保障**
  * **零遥测**：模型索引、预设配置与会话历史 100% 留存在本机
  * **健壮存储**：配置采用原子写入机制（临时文件 + rename），避免意外损坏

---

## 🛠 技术架构

| 模块 | 技术选型 | 说明 |
| :--- | :--- | :--- |
| **桌面框架** | [Tauri 2](https://tauri.app/) (Rust) | 轻量原生内核，解决启动白屏/黑屏问题 |
| **前端技术** | React 19 · TypeScript · Vite 6 · Tailwind CSS 4 | 现代化响应式单页架构 |
| **后端运行时** | Rust Core | 子进程生命周期管理、日志管道转发、配置原子写入 |
| **推理引擎** | llama.cpp (`llama-server.exe`) | 本地 GGUF 模型高性能推理 |
| **打包分发** | NSIS / WiX | Windows 原生安装包与免安装便携版 |

---

## 📁 目录结构

```text
├── index.html              # Splash 启动页与 HTML 入口
├── src/                    # 前端项目 (React + TypeScript)
│   ├── App.tsx             # 顶层状态与全局事件调度
│   ├── tauri.ts            # Tauri API / 事件桥（内置 Web 演示降级）
│   ├── data.ts             # 默认预设模版、迁移脚本与 mock 数据
│   ├── components/         # 仓库卡片、预设编辑器、控制台与会话组件
│   └── types.ts            # 全局 TypeScript 类型定义
└── src-tauri/              # 后端项目 (Rust + Tauri 2)
    ├── src/lib.rs          # 进程管控、日志监听、文件扫描与配置管理
    ├── tauri.conf.json     # Tauri 基础配置
    └── capabilities/       # 安全策略与窗口权限声明
```

---

## 🚀 快速上手

1. 打开 **设置**，指定本机的 `llama-server.exe` 路径
2. 将 `.gguf` 模型拖入 **模型仓库**
3. 选择合适的 **运行预设**，点击 **启动服务**
4. 在 **会话** 面板中即刻体验，或通过本地 `http://127.0.0.1:8080/v1` 接入其他应用

---

## 💻 本地开发与构建

**前置准备**

- Windows 10 / 11 (x64)
- Node.js 18+ & Rust 工具链（MSVC）
- 已编译的 `llama-server.exe` 与 GGUF 模型

**开发调试**

```bash
# 安装依赖
npm install

# 启动桌面端热重载开发
npm run tauri dev
```

**生产构建**

```bash
# 生成发布安装包 (位于 src-tauri/target/release/)
npm run tauri build
```

---

## 📄 开源协议

本项目采用 MIT License 授权。
