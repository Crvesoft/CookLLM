import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import App from "./App";
// 设计字体（latin 子集，按字重加载）：正文 Inter，等宽/徽标 JetBrains Mono
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/inter/latin-700.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import "@fontsource/jetbrains-mono/latin-600.css";
import "@fontsource/jetbrains-mono/latin-700.css";
import "./index.css";
import { isTauri } from "./tauri";

type StartupProbe = { t0: number; wall0: number; domReady: number };

declare global {
  interface Window { __startup?: StartupProbe }
}

const startup: StartupProbe | undefined = window.__startup;

// 上报启动计时（unix 毫秒）：文档开始 / DOM 就绪（splash 可见）/ React 挂载
const reportStartupTiming = () => {
  if (!isTauri()) return;
  const now = Date.now();
  invoke("report_startup_timing", {
    pageLoadMs: startup?.wall0 ?? now,
    splashShownMs: startup?.domReady || now,
    reactMountedMs: now,
  }).catch(() => {/* 非 Tauri 环境无此命令 */});
};

// 窗口以 visible:false 创建：React 首帧提交后立即显示，避免 WebView2 冷启动的黑屏阶段
const revealWindow = () => {
  if (!isTauri()) return;
  invoke("show_main_window").catch(() => {/* 非 Tauri 环境无此命令 */});
};

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
// 首帧提交后：显示主窗口 + 上报计时（rAF 保证在下一帧之前已完成）
requestAnimationFrame(() => { revealWindow(); reportStartupTiming(); });
