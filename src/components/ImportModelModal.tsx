import { useEffect, useMemo, useRef, useState } from "react";
import { FileBox, FolderOpen, Loader2, Upload, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { expandPaths, isTauri, pickFiles, pickFolder } from "../tauri";
import type { PickedFile } from "../tauri";
import { cn, fileName, formatBytes } from "../utils";

interface Candidate extends PickedFile {
  checked: boolean;
}

interface Props {
  /** 仓库中已有模型的小写路径集合，用于标记重复项（默认不勾选） */
  existingPaths: Set<string>;
  /** 确认后回调：传入用户勾选的文件，由 App 执行导入 */
  onImport: (paths: PickedFile[]) => Promise<void>;
  onClose: () => void;
}

/** 浏览器模式：递归遍历 webkitGetAsEntry 拖入的文件 / 目录，仅收集 .gguf */
async function walkEntry(entry: Record<string, any>, base: string): Promise<PickedFile[]> {
  if (entry.isFile) {
    const file = await new Promise<File | null>((resolve, reject) => entry.file(resolve, reject)).catch(() => null);
    if (file && file.name.toLowerCase().endsWith(".gguf")) return [{ path: `${base}${file.name}`, sizeBytes: file.size }];
    return [];
  }
  if (!entry.isDirectory) return [];
  const out: PickedFile[] = [];
  const childBase = `${base}${entry.name}/`;
  const reader = entry.createReader();
  for (;;) {
    // readEntries 每次最多返回 100 条，需循环读取直到返回空批
    const batch: Record<string, any>[] = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) break;
    for (const child of batch) out.push(...(await walkEntry(child, childBase)));
  }
  return out;
}

export default function ImportModelModal({ existingPaths, onImport, onClose }: Props) {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dropRef = useRef<HTMLDivElement>(null);
  const scaleRef = useRef(1);
  const dragDepth = useRef(0);
  const browserFileRef = useRef<HTMLInputElement>(null);
  const browserFolderRef = useRef<HTMLInputElement>(null);

  const selected = useMemo(() => candidates.filter((item) => item.checked), [candidates]);

  const isDup = (path: string) => existingPaths.has(path.toLowerCase());

  /** 把新文件并入候选列表：按路径去重，已在仓库的项默认不勾选 */
  const merge = (items: PickedFile[]) => {
    setCandidates((previous) => {
      const known = new Set(previous.map((item) => item.path.toLowerCase()));
      const fresh: Candidate[] = [];
      for (const item of items) {
        if (!item.path) continue;
        const key = item.path.toLowerCase();
        if (known.has(key)) continue;
        known.add(key);
        fresh.push({ ...item, checked: !isDup(item.path) });
      }
      return [...previous, ...fresh];
    });
  };

  const handleTauriDrop = async (paths: string[]) => {
    if (!paths.length) return;
    setBusy(true);
    setError(null);
    try {
      const items = await expandPaths(paths);
      if (!items.length) {
        setError("所选位置中没有 GGUF 文件");
        return;
      }
      merge(items);
    } catch (err) {
      setError(`读取失败：${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const handlePickFiles = async () => {
    if (!isTauri()) return browserFileRef.current?.click();
    setBusy(true);
    setError(null);
    try {
      const items = await pickFiles(["gguf"]);
      if (!items.length) return;
      merge(items);
    } catch (err) {
      setError(`选择文件失败：${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const handlePickFolder = async () => {
    if (!isTauri()) return browserFolderRef.current?.click();
    setBusy(true);
    setError(null);
    try {
      const items = await pickFolder();
      if (!items.length) {
        setError("文件夹内未找到 GGUF 模型文件");
        return;
      }
      merge(items);
    } catch (err) {
      setError(`导入文件夹失败：${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  /** Tauri 模式：窗口级 drag-drop 事件（拖入的文件/文件夹拿到真实绝对路径） */
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      const scale = await getCurrentWindow().scaleFactor();
      scaleRef.current = scale;
      const un = await getCurrentWindow().onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "drop") {
          setDragging(false);
          void handleTauriDrop(payload.paths);
        } else if (payload.type === "enter" || payload.type === "over") {
          const rect = dropRef.current?.getBoundingClientRect();
          if (!rect) return setDragging(false);
          const x = payload.position.x / scaleRef.current;
          const y = payload.position.y / scaleRef.current;
          setDragging(x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom);
        } else {
          setDragging(false);
        }
      });
      if (cancelled) un();
      else unlisten = un;
    })();
    return () => {
      cancelled = true;
      void unlisten?.();
    };
  }, []);

  /** Esc 关闭 */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /** 浏览器模式：HTML5 拖拽（拿不到绝对路径，与既有浏览器演示行为一致） */
  const handleBrowserDrop = async (event: React.DragEvent) => {
    event.preventDefault();
    const transfers = event.dataTransfer;
    if (!transfers) return;
    const items: PickedFile[] = [];
    const entries: Record<string, any>[] = [];
    for (let i = 0; i < transfers.items.length; i += 1) {
      const entry = (transfers.items[i] as any)?.webkitGetAsEntry?.();
      if (entry) entries.push(entry);
    }
    if (!entries.length) {
      const files = transfers.files;
      for (let i = 0; i < files.length; i += 1) {
        const file = files[i];
        if (file.name.toLowerCase().endsWith(".gguf")) items.push({ path: file.name, sizeBytes: file.size });
      }
    } else {
      for (const entry of entries) items.push(...(await walkEntry(entry, "")));
    }
    if (!items.length) {
      setError("拖入的内容中没有 GGUF 文件");
      return;
    }
    merge(items);
    setDragging(false);
  };

  const onBrowserDragEnter = (event: React.DragEvent) => {
    if (event.dataTransfer?.types?.includes("Files")) {
      dragDepth.current += 1;
      setDragging(true);
    }
  };
  const onBrowserDragLeave = () => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (!dragDepth.current) setDragging(false);
  };

  const toggleCandidate = (path: string) =>
    setCandidates((previous) => previous.map((item) => (item.path === path ? { ...item, checked: !item.checked } : item)));
  const removeCandidate = (path: string) =>
    setCandidates((previous) => previous.filter((item) => item.path !== path));

  const handleConfirm = async () => {
    if (!selected.length || importing) return;
    setImporting(true);
    try {
      await onImport(selected);
    } finally {
      setImporting(false);
    }
  };

  return <>
    <div className="import-modal-backdrop" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <div className="import-modal">
        <header>
          <div><span>MODEL IMPORT</span><h2>导入模型</h2></div>
          <button className="ghost-icon" aria-label="关闭" onClick={onClose}><X size={18} /></button>
        </header>
        <div className="import-body">
          <div
            ref={dropRef}
            className={cn("import-dropzone", dragging && "active", busy && "busy")}
            onDragEnter={onBrowserDragEnter}
            onDragLeave={onBrowserDragLeave}
            onDragOver={(event) => event.preventDefault()}
            onDrop={handleBrowserDrop}
          >
            <div className="import-dropzone-icon">{busy ? <Loader2 size={30} className="spin" /> : <Upload size={30} />}</div>
            <h3>{busy ? "正在读取所选内容…" : "拖拽 GGUF 文件 / 文件夹到此处"}</h3>
            <p>支持同时拖入多个文件或整个文件夹，仅识别 .gguf</p>
            <div className="import-dropzone-actions">
              <button className="import-link" disabled={busy} onClick={handlePickFiles}><FileBox size={15} />选择模型文件</button>
              <button className="import-link" disabled={busy} onClick={handlePickFolder}><FolderOpen size={15} />选择文件夹</button>
            </div>
          </div>
          {error && <p className="import-error">{error}</p>}
          {candidates.length > 0 && (
            <div className="import-list">
              {candidates.map((item) => (
                <div
                  key={item.path}
                  className={cn("import-row", !item.checked && "unchecked")}
                  onClick={() => toggleCandidate(item.path)}
                >
                  <input
                    type="checkbox"
                    checked={item.checked}
                    readOnly
                    onClick={(event) => event.stopPropagation()}
                    onChange={() => toggleCandidate(item.path)}
                  />
                  <div className="import-row-info">
                    <strong>{fileName(item.path)}</strong>
                    <code>{item.path}</code>
                  </div>
                  {isDup(item.path) && <span className="import-dup-tag">已在仓库</span>}
                  <span className="import-row-size">{formatBytes(item.sizeBytes)}</span>
                  <button
                    className="import-row-remove"
                    aria-label="移除"
                    onClick={(event) => {
                      event.stopPropagation();
                      removeCandidate(item.path);
                    }}
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
        <footer>
          <span className="import-summary">{candidates.length ? `${selected.length} / ${candidates.length} 已选` : "尚未选择文件"}</span>
          <button className="secondary-button" onClick={onClose}>取消</button>
          <button className="primary-button" disabled={!selected.length || importing} onClick={handleConfirm}>
            {importing && <Loader2 size={15} className="spin" />}导入选中（{selected.length}）
          </button>
        </footer>
      </div>
    </div>
    {!isTauri() && <>
      <input
        ref={browserFileRef}
        hidden
        type="file"
        multiple
        accept=".gguf"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? [])
            .map((file) => ({ path: file.name, sizeBytes: file.size }))
            .filter((item) => item.path.toLowerCase().endsWith(".gguf"));
          if (files.length) merge(files);
          event.target.value = "";
        }}
      />
      <input
        ref={browserFolderRef}
        hidden
        type="file"
        multiple
        {...{ webkitdirectory: "" }}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? [])
            .map((file) => ({ path: (file as any).webkitRelativePath || file.name, sizeBytes: file.size }))
            .filter((item) => item.path.toLowerCase().endsWith(".gguf"));
          if (files.length) merge(files);
          event.target.value = "";
        }}
      />
    </>}
  </>;
}
