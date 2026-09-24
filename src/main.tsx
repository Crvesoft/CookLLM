import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
// 设计字体（latin 子集，纯 woff2 加载）：正文 Inter，等宽/徽标 JetBrains Mono
import "./fonts.css";
import "./index.css";

type StartupProbe = { t0: number; wall0: number; domReady: number };

declare global {
  interface Window { __startup?: StartupProbe }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
