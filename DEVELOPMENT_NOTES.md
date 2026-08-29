# CookLLM 开发笔记

## 左下角紧凑状态卡（Mini Status Bar）

### GPU 指标区迁移标题栏（2026-08-29）
- 原卡片「GPU检测」指标区改名为 **GPU性能监测**，从左下角移到标题栏中间：`GpuMonitorStrip`（`.gpu-monitor`，`margin: 0 auto` 居中于面包屑与操作区之间；每格 = 左侧"标题/数值"纵排 + 右侧固定 64×36 迷你图，复用 `Spark` / `ms-view-title` / `ms-val` / `ms-spark`）。
- 左下角仅保留单条功耗行（`.mini-status` 收缩为单行）：功耗值在左，健康灯 + 版本号 + ⚙设置入口沉底右端；仍由 `MiniStatusBar` 渲染、无定时器。
- 接线：App 把 `tokSample` / `gpuStats` 同时传给 Topbar（新）与 Sidebar；1s tick、历史采样（HISTORY_MAX=90）、t/s 过期 → Idle 判定均随 GpuMonitorStrip。

### 机制
- **位置**：Sidebar 底部，两行结构（原四行布局 / `.sidebar-footer` 已移除）：① 头部 = 健康灯 + 模型名 | 版本号 `v0.1.0` + 设置图标（缩小后移入头部右侧）；② 主体 = 指标行纵向堆叠——每行 [微型图标 + 值 (+状态)] 在左、无轨道迷你图 flex 撑满右侧（图表与对应行严格成对），功耗独占底部通栏细行。
- **GPU 数据来源**：Rust `get_gpu_stats` 命令查询 nvidia-smi（字段 `memory.total,memory.used,utilization.gpu,power.draw`，单位 MiB/%/W；路径优先取 `SystemRoot\system32\nvidia-smi.exe` 并缓存，busy 标志防查询堆积）。前端 App 每 2s 轮询 → `gpuStats` 状态。无 NVIDIA 驱动 / 查询失败 → null → 显存 / 核心 / 功耗均显示 "--"。
- **指标行**（`.ms-metric`）：左侧 = lucide 微型图标（`MemoryStick`=显存 / `Cpu`=核心，灰字色 `.ms-ico`）+ 等宽值——显存 `X.X / Y GB`（斜杠两侧留空格、单位只出现一次）、核心 `NN%`；核心行尾追加状态后缀：推理中显示实时速率 `XX.X t/s`（橙色 `.live`）、**仅运行且占用率 <40%**（`IDLE_UTIL_MAX`）才标 Idle——未运行或高负载时隐藏，避免 "94% Idle" 语义冲突。功耗降级为底部通栏细行（`.ms-power`：Zap 图标 + "功耗" + `NN W`，上分隔线、次级灰）。原 `.ms-tag` 中括号与右侧固定图表列已移除。
- **右侧无轨道迷你图**：`Spark` 组件（MiniStatusBar.tsx 内）为右锚定滚动窗口——新样本从右缘推入、旧值左移，满窗后持续滚动；SVG `preserveAspectRatio="none"` + `vector-effect:non-scaling-stroke` 保证线宽不随缩放变形；无轨道设计 = 半透明填充（polygon）+ 顶边实线（polyline），`.ms-track` 占用条、SVG 网格线与背景色均已移除。每张图内联于对应指标行右侧 flex 撑满（`.ms-spark { flex:1 1 auto; height:22px }`，宽高比约 3:1+）。采样缓存在 MiniStatusBar 本地 state（`memHistory/coreHistory`），上限 `HISTORY_MAX=90` × 2s ≈ 3min，纯前端保留、不落盘、Rust 端无改动；数据不足时留白占位。
- **Token 速率**：日志行经 `parseTokPerSec` 解析为 `tokSample { rate, at }`（带时间戳）；MiniStatusBar 内部 1s tick，采样超过 8s 未更新则不再显示速率、按占用率决定是否标 Idle（避免生成结束后残留旧速率）。启动 / 停止服务均重置 tokSample。展示从独立行改为核心行的状态后缀。
- **状态灯语义**：绿 = 运行中（status.running）/ 红+脉冲 = serviceAbnormal（启动失败或进程意外退出）/ 灰 = 未运行；配色沿用 log-dock-bar 的 running/abnormal 语义（暗 #36d38b/#e26f91，亮 #1e9e63/#d34f78），动画复用 `dock-pulse`。
- **主题切换**：卡片月亮/太阳快捷按钮随底部行移除——入口改为设置页"外观主题"卡；Sidebar 不再接收 theme/onSetTheme props（App.tsx / Layout.tsx 同步移除）。
- **改动文件**：src-tauri/src/lib.rs（GpuStats + find_nvidia_smi/query_gpu_stats/get_gpu_stats）、types.ts（GpuStats/TokSample）、tauri.ts（getGpuStats）、components/MiniStatusBar.tsx、Layout.tsx（Sidebar 换装，移除 theme props）、App.tsx（tokSample/gpuStats 管线）、index.css（.mini-status* 暗亮双主题）。

## 会话页 WebUI 布局机制

### 机制
- **Dock 下全屏**：WebUI 始终填满当前面板的全部剩余高度——`.playground-pane` 负 margin 贴满主区，iframe `height:100%`；无手动显示范围调节。
- **随 Dock 联动（flex）**：LogDock 是 workspace flex 子项，展开时占位（120px ~ 60% 视口），WebUI 靠 `flex:1; min-height:0` 随布局自动缩小、按常规窗口缩放重排；收起 = 底部状态栏，WebUI 获得全部剩余高度。
- **已移除**：旧的 `.webui-resize` 隐藏下界边框（悬停显现）与 `Playground.tsx` 内 `bottomOffset` 手动拖拽 state 均已删除。

## 日志显示统一为 Dock 模式

### 机制
- **Dock 覆盖除"日志"页外所有页面**：`PAGE_LOG_MODE`（types.ts）中 models/profiles/playground/settings 均为 `"dock"`，仅 logs 为 `"page"`；各页共用同一份 `logDockOpen` / `logDockHeight` 状态（App），高度持久化到 localStorage。
- **左菜单"日志"页保持整页全屏**：LogsPage 独立渲染（`.logs-page` 负 margin 贴满主区，`height: calc(100vh - 62px)`），不进 Dock。
- **启动联动**：任意 Dock 页启动服务时自动展开 Dock 显示加载日志（就绪后自动收起）；进程意外退出 / 启动失败自动展开并标红——不再限于会话页。
- **已移除悬浮抽屉**：`ConsoleDrawer`（Layout.tsx）、`consoleOpen` / `consoleHeight` 状态及其 CSS（`.console-drawer/.console-tab/.console-shell/.console-resize`）全部删除；`.main-content` 底部 230px 留白随之取消。
- **共享样式**：`.console-toolbar` / `.console-lines` / `.log-line*` 仍被 LogDock 与 LogsPage 复用，改动时两处都要验证。

## 主题颜色调整区域（配色速查）

### 机制
- 主题由 `<html data-theme="light|dark">` 驱动：`App.tsx:70` 读取 `config.theme`（默认 light），写入 html 属性，同时调 `setWindowTheme()` 同步 Windows 标题栏。
- 切换入口：设置页"外观主题"卡片。
- **所有颜色都在 CSS 里**，TSX 无任何硬编码色值（已验证）。

### src/index.css（~313 行，主样式表）

| 区域 | 位置 | 内容 |
|---|---|---|
| 暗色基线变量 | `:root`（约 L3–26） | 中性色 `--bg/--panel*/--line*/--muted*/--text*`、分类色变量（见下）、`--bg-radial: rgba(255,107,40,.12)` |
| 亮色覆盖块 | `[data-theme="light"]`（约 L100 起） | 中性色亮色变体 + 分类色亮色变体 + 各组件橙色亮色套 |

**品牌主色"活力橙"** 未走变量、按选择器硬编码，暗/亮成对出现：

*暗色套*
- 渐变主按钮 `.primary-button`：`#ffa02e → #ff4d17`（边框 `#df8c42`、阴影 `rgba(217,127,54,.22)`）
- 光晕基色：`rgba(255,107,40, α)`，α 档位 .05/.07/.09/.10/.12/.14/.16/.18/.28/.3/.45/.6 —— 径向背景、focus ring、glow
- accent 高亮：`#ee9b55 / #eba45c / #dd8239 / #de8b43`（active 竖条、search-box focus、选中卡片边框、text-button）
- 亮字/悬停：`#fff6ec / #ffd9ad / #f2a260 / #bd9469`
- 暖深底/边框：`#302113 / #2b1c10 / #261f17 / #48351f / #584129 / #1f150e`；`.launch-button`（卡片内启动服务）为扁平暖橙淡档：暗 `#ffd9ad/#48351f/#2b1c10`、亮 `#bd5c16/#efd3a6/#fdf1dd`，风格对齐 `.service-toggle.running` 的"关闭服务"态（玫红淡档），颜色取主题橙色的浅一档

*亮色套*
- 文字 accent：`#bd5c16`（主，约 14 处）、`#9c5a1e`
- 暖浅底：`#fdf1dd / #fcf2df / #fbf2e2`；边框：`#efd3a6 / #eed0ab / #eed8b0`

### src/splash.css（启动屏，仅 2 处）
- L5 径向光晕 `rgba(238,155,85,.12)`（= `#ee9b55` @ .12）
- L13 loading 转圈环 `border-top-color: #ee9b55`

### 分类色系统（非品牌色，改品牌色时**不要动**）
`--violet/--cyan/--green/--amber/--rose` 五色变量（暗 :root / 亮块各一套），用于：
- `.model-symbol.{violet|cyan|amber|rose}` 模型符号徽章（暗 L74、亮 L139）
- `.profile-number` 预设编号装饰数字四色（L80，默认 violet）
- 控制台日志行分类：`.log-line.system #987bdc` / `.err` rose / `.warn` amber（L85）

### 快速换品牌色 checklist
1. 橙色系共五组，按组整体替换、**保持组内相对明度关系不变**：
   - 渐变对 `#ffa02e/#ff4d17` + 边框/阴影 → 新主色的渐变对
   - 光晕基色 `rgba(255,107,40, …)`（只改 RGB，α 档位不动；含 `--bg-radial`）
   - accent 高亮组：暗 `#ee9b55/#eba45c/#dd8239/#de8b43` ↔ 亮 `#bd5c16/#9c5a1e`
   - 暖色底/边框组：暗 `#302113` 系 ↔ 亮 `#fdf1dd` 系
   - splash.css L5/L13 —— 必须与新主 accent（对应 `#ee9b55`）同步
2. 分类色系统（`--violet` 等五色及 model-symbol/profile-number/日志行）**保持不变**。
3. 验证：
   ```bat
   findstr /N /C:"ffa02e" /C:"ff4d17" /C:"255,107,40" src\index.css src\splash.css
   npm run build
   ```
   findstr 应无输出（旧色零残留），build 须通过。


