//! 本机 WebUI / 指标反向代理。
//!
//! 两个用途：
//! - 启用 API Key 后，前端 iframe 与外部浏览器请求不会携带密钥，引擎直接 401；
//!   这里在本机回环地址上起一个极简 HTTP/1.1 代理补上鉴权头。
//! - NInfer 0.19 起引擎包默认不再内嵌 WebUI（`NINFER_WEBUI_DIR` 为编译期开关），`GET /` 只回空 404。
//!   `UiState` 提供 WebUI 静态目录时，代理在本机直接托管运行时获取的 llama.cpp 官方
//!   WebUI；目录尚未就绪时先返回等待页，其余 API 请求照常转发给引擎，使 iframe 体验与
//!   llama.cpp 一致。
//!
//! 转发部分：补上 `Authorization: Bearer <key>`；响应（含 SSE 流）按字节透传；请求体严格按
//! Content-Length 转发，支持 keep-alive 上的连续请求；Upgrade / chunked 等无法安全改写的请求
//! 退化为原始双向透传。
//!
//! 仅依赖标准库：代理只服务本机回环，不需要 TLS、连接池或 HTTP/2。

use std::fs;
use std::io::{self, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use std::thread;
use std::time::Duration;

const MAX_HEAD_BYTES: usize = 64 * 1024;
const IO_POLL: Duration = Duration::from_millis(500);

/// WebUI 静态资源状态：下载/解压在后台线程完成，代理先返回等待页。
pub(crate) struct UiState {
    root: RwLock<Option<PathBuf>>,
    error: RwLock<Option<String>>,
    /// 是否仍会再自动尝试一次：失败文案据此区分「稍后自动重试」与「已停止」
    retrying: AtomicBool,
    /// 后台准备线程是否在跑：避免重复点击重试时并发下载同一份资源
    busy: AtomicBool,
}

struct UiSnapshot {
    root: Option<PathBuf>,
    error: Option<String>,
    retrying: bool,
}

impl UiState {
    pub(crate) fn new() -> Self {
        Self {
            root: RwLock::new(None),
            error: RwLock::new(None),
            retrying: AtomicBool::new(false),
            busy: AtomicBool::new(false),
        }
    }

    #[cfg(test)]
    pub(crate) fn ready(root: PathBuf) -> Self {
        Self {
            root: RwLock::new(Some(root)),
            error: RwLock::new(None),
            retrying: AtomicBool::new(false),
            busy: AtomicBool::new(false),
        }
    }

    /// 开始一次准备：已有线程在跑时返回 false。调用方必须配对调用 `finish`。
    pub(crate) fn begin(&self) -> bool {
        if self.busy.swap(true, Ordering::SeqCst) {
            return false;
        }
        if let Ok(mut guard) = self.error.write() {
            *guard = None;
        }
        self.retrying.store(false, Ordering::SeqCst);
        true
    }

    pub(crate) fn finish(&self) {
        self.busy.store(false, Ordering::SeqCst);
    }

    pub(crate) fn set_ready(&self, root: PathBuf) {
        if let Ok(mut guard) = self.root.write() {
            *guard = Some(root);
        }
        if let Ok(mut guard) = self.error.write() {
            *guard = None;
        }
        self.retrying.store(false, Ordering::SeqCst);
    }

    /// 本轮失败但还会自动重试：等待页展示「正在自动重试」。
    pub(crate) fn set_retrying(&self, error: String) {
        if let Ok(mut guard) = self.error.write() {
            *guard = Some(error);
        }
        self.retrying.store(true, Ordering::SeqCst);
    }

    /// 自动重试已结束：等待页不再暗示会自行恢复。
    pub(crate) fn set_error(&self, error: String) {
        if let Ok(mut guard) = self.error.write() {
            *guard = Some(error);
        }
        self.retrying.store(false, Ordering::SeqCst);
    }

    fn snapshot(&self) -> UiSnapshot {
        UiSnapshot {
            root: self.root.read().ok().and_then(|guard| guard.clone()),
            error: self.error.read().ok().and_then(|guard| guard.clone()),
            retrying: self.retrying.load(Ordering::SeqCst),
        }
    }
}

impl Default for UiState {
    fn default() -> Self {
        Self::new()
    }
}

pub(crate) struct WebuiProxy {
    pub(crate) port: u16,
    shutdown: Arc<AtomicBool>,
}

impl WebuiProxy {
    /// 在 127.0.0.1 上启动代理：优先使用引擎端口 +1，被占用时退回系统分配端口。
    /// `ui` 提供 llama.cpp 官方 WebUI 的运行时状态；目录尚未就绪时先返回等待页。
    pub(crate) fn start(
        engine_host: &str,
        engine_port: u16,
        api_key: Option<String>,
        ui: Option<Arc<UiState>>,
    ) -> Option<Self> {
        let api_key = api_key.filter(|key| !key.trim().is_empty());
        if api_key.is_none() && ui.is_none() {
            return None;
        }
        let listener = bind_listener(engine_port.checked_add(1))?;
        let port = listener.local_addr().ok()?.port();
        listener.set_nonblocking(true).ok()?;

        let shutdown = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&shutdown);
        let target_host = connect_host(engine_host).to_string();
        thread::Builder::new()
            .name("cookllm-webui-proxy".into())
            .spawn(move || accept_loop(listener, target_host, engine_port, api_key, ui, flag))
            .ok()?;

        Some(Self { port, shutdown })
    }
}

impl Drop for WebuiProxy {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::SeqCst);
    }
}

fn bind_listener(preferred: Option<u16>) -> Option<TcpListener> {
    if let Some(port) = preferred {
        if let Ok(listener) = TcpListener::bind(("127.0.0.1", port)) {
            return Some(listener);
        }
    }
    TcpListener::bind(("127.0.0.1", 0)).ok()
}

/// 引擎监听地址 → 代理连接地址：通配地址回落到回环地址，其余按原地址连接。
fn connect_host(engine_host: &str) -> &str {
    match engine_host.trim() {
        "" | "0.0.0.0" => "127.0.0.1",
        "::" | "[::]" => "::1",
        host => host,
    }
}

fn accept_loop(
    listener: TcpListener,
    target_host: String,
    target_port: u16,
    api_key: Option<String>,
    ui: Option<Arc<UiState>>,
    shutdown: Arc<AtomicBool>,
) {
    while !shutdown.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((client, _)) => {
                let host = target_host.clone();
                let key = api_key.clone();
                let ui = ui.clone();
                let flag = Arc::clone(&shutdown);
                let _ = thread::Builder::new()
                    .name("cookllm-webui-conn".into())
                    .spawn(move || {
                        if flag.load(Ordering::SeqCst) {
                            return;
                        }
                        // 引擎尚未监听时仍可先托管官方 WebUI 静态页，API 请求再返回 503
                        let engine = TcpStream::connect((host.as_str(), target_port)).ok();
                        serve(client, engine, key.as_deref(), ui.as_deref(), flag);
                    });
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => thread::sleep(Duration::from_millis(50)),
            Err(_) => thread::sleep(Duration::from_millis(100)),
        }
    }
}

struct RequestMeta {
    close: bool,
    upgrade: bool,
    chunked: bool,
    content_length: u64,
}

fn serve(
    mut client: TcpStream,
    engine: Option<TcpStream>,
    api_key: Option<&str>,
    ui: Option<&UiState>,
    shutdown: Arc<AtomicBool>,
) {
    let _ = client.set_nodelay(true);
    let _ = client.set_read_timeout(Some(IO_POLL));

    let mut upstream = None;
    if let Some(engine) = engine {
        let _ = engine.set_nodelay(true);
        let _ = engine.set_read_timeout(Some(IO_POLL));
        upstream = engine.try_clone().ok();
        if let Some(mut client_down) = client.try_clone().ok() {
            let down_exit = Arc::clone(&shutdown);
            let _ = thread::Builder::new()
                .name("cookllm-webui-down".into())
                .spawn(move || {
                    let mut buf = [0u8; 16 * 1024];
                    let mut engine = engine;
                    loop {
                        match engine.read(&mut buf) {
                            Ok(0) => {
                                let _ = client_down.shutdown(Shutdown::Write);
                                break;
                            }
                            Ok(n) => {
                                if client_down.write_all(&buf[..n]).is_err() {
                                    break;
                                }
                                let _ = client_down.flush();
                            }
                            // 空闲读超时只用于感知代理退出；不能因请求仍在处理（如长 Prefill）而中断 SSE
                            Err(error) if retryable(&error) => {
                                if down_exit.load(Ordering::SeqCst) {
                                    break;
                                }
                            }
                            Err(_) => break,
                        }
                    }
                });
        }
    }

    match forward_requests(&mut client, upstream.as_mut(), api_key, ui, &shutdown) {
        // 客户端主动断开：通知引擎本次连接不会再有请求
        Ok(ForwardOutcome::ClientClosed) => {
            if let Some(engine) = upstream.as_mut() {
                let _ = engine.shutdown(Shutdown::Write);
            }
        }
        // 请求要求关闭（Connection: close）：引擎会在响应结束后自行关闭连接，此处不能半关闭写侧，
        // 否则部分引擎会把客户端 FIN 当作断连并截断尚未发送的响应体（如 SSE）
        Ok(ForwardOutcome::RequestFinished) => {}
        Err(_) => { let _ = client.shutdown(Shutdown::Both); }
    }
    // 下游线程随引擎关闭/写入失败自行退出，这里不阻塞等待（SSE 长连接可能仍在收尾）
}

enum ForwardOutcome {
    ClientClosed,
    RequestFinished,
}

fn forward_requests(
    client: &mut TcpStream,
    mut engine: Option<&mut TcpStream>,
    api_key: Option<&str>,
    ui: Option<&UiState>,
    shutdown: &AtomicBool,
) -> io::Result<ForwardOutcome> {
    let mut pending: Vec<u8> = Vec::new();
    let mut buf = [0u8; 16 * 1024];

    loop {
        let head_end = loop {
            if let Some(pos) = find_head_end(&pending) {
                break pos;
            }
            if pending.len() > MAX_HEAD_BYTES {
                let Some(engine) = engine.as_mut().map(|stream| &mut **stream) else {
                    write_status(client, 503, "engine not ready")?;
                    return Ok(ForwardOutcome::RequestFinished);
                };
                return raw_passthrough(client, engine, &pending, shutdown);
            }
            let n = read_some(client, &mut buf, shutdown)?;
            if n == 0 {
                return Ok(ForwardOutcome::ClientClosed);
            }
            pending.extend_from_slice(&buf[..n]);
        };

        let rest = pending.split_off(head_end);
        let head = std::mem::take(&mut pending);
        let meta = parse_head(&head);
        let (method, target) = request_line(&head);

        // 引擎未内嵌 WebUI 时，页面与静态资源由代理直接托管；API 路径仍走引擎
        let is_read = method.eq_ignore_ascii_case("GET") || method.eq_ignore_ascii_case("HEAD");
        if let Some(ui) = ui.filter(|_| is_read && !is_api_path(&target)) {
            let mut body_remaining = meta.content_length;
            if body_remaining == 0 {
                pending.extend_from_slice(&rest);
            } else {
                let take = (rest.len() as u64).min(body_remaining) as usize;
                body_remaining -= take as u64;
                if take < rest.len() {
                    pending.extend_from_slice(&rest[take..]);
                }
                while body_remaining > 0 {
                    let n = read_some(client, &mut buf, shutdown)?;
                    if n == 0 {
                        return Ok(ForwardOutcome::ClientClosed);
                    }
                    let take = (n as u64).min(body_remaining) as usize;
                    body_remaining -= take as u64;
                    if take < n {
                        pending.extend_from_slice(&buf[take..n]);
                    }
                }
            }
            let snapshot = ui.snapshot();
            let head_only = method.eq_ignore_ascii_case("HEAD");
            match snapshot.root {
                Some(root) => serve_ui(client, &root, &target, head_only)?,
                None => serve_ui_pending(client, &target, snapshot.error.as_deref(), snapshot.retrying, head_only)?,
            }
            if meta.close {
                return Ok(ForwardOutcome::RequestFinished);
            }
            continue;
        }

        let Some(engine) = engine.as_mut().map(|stream| &mut **stream) else {
            write_status(client, 503, "engine not ready")?;
            return Ok(ForwardOutcome::RequestFinished);
        };

        let rewritten = rewrite_head(&head, api_key);
        engine.write_all(&rewritten)?;
        engine.flush()?;

        if meta.upgrade || meta.chunked {
            engine.write_all(&rest)?;
            engine.flush()?;
            return raw_passthrough(client, engine, &[], shutdown);
        }

        let mut body_remaining = meta.content_length;
        let mut cursor = 0usize;
        if body_remaining > 0 && !rest.is_empty() {
            let take = (rest.len() as u64).min(body_remaining) as usize;
            engine.write_all(&rest[..take])?;
            engine.flush()?;
            body_remaining -= take as u64;
            cursor = take;
        }
        // 同一缓冲区里可能已经包含下一个 keep-alive 请求
        if cursor < rest.len() {
            pending.extend_from_slice(&rest[cursor..]);
        }

        while body_remaining > 0 {
            let n = read_some(client, &mut buf, shutdown)?;
            if n == 0 {
                return Ok(ForwardOutcome::ClientClosed);
            }
            let take = (n as u64).min(body_remaining) as usize;
            engine.write_all(&buf[..take])?;
            engine.flush()?;
            body_remaining -= take as u64;
            if take < n {
                pending.extend_from_slice(&buf[take..n]);
            }
        }

        if meta.close {
            return Ok(ForwardOutcome::RequestFinished);
        }
    }
}

fn raw_passthrough(client: &mut TcpStream, engine: &mut TcpStream, initial: &[u8], shutdown: &AtomicBool) -> io::Result<ForwardOutcome> {
    if !initial.is_empty() {
        engine.write_all(initial)?;
        engine.flush()?;
    }
    let mut buf = [0u8; 16 * 1024];
    loop {
        let n = read_some(client, &mut buf, shutdown)?;
        if n == 0 {
            return Ok(ForwardOutcome::ClientClosed);
        }
        engine.write_all(&buf[..n])?;
        engine.flush()?;
    }
}

fn read_some(stream: &mut TcpStream, buf: &mut [u8], shutdown: &AtomicBool) -> io::Result<usize> {
    loop {
        match stream.read(buf) {
            Ok(n) => return Ok(n),
            Err(error) if retryable(&error) => {
                if shutdown.load(Ordering::SeqCst) {
                    return Ok(0);
                }
            }
            Err(error) => return Err(error),
        }
    }
}

fn retryable(error: &io::Error) -> bool {
    matches!(error.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut | io::ErrorKind::Interrupted)
}

fn find_head_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|window| window == b"\r\n\r\n").map(|pos| pos + 4)
}

fn parse_head(head: &[u8]) -> RequestMeta {
    let text = String::from_utf8_lossy(head);
    let mut lines = text.split("\r\n").filter(|line| !line.is_empty());
    let request_line = lines.next().unwrap_or_default();
    let mut parts = request_line.split_whitespace();
    let _method = parts.next().unwrap_or_default();
    let _target = parts.next().unwrap_or_default();
    let version = parts.next().unwrap_or_default();

    let mut close = version.eq_ignore_ascii_case("HTTP/1.0");
    let mut upgrade = false;
    let mut chunked = false;
    let mut content_length: u64 = 0;

    for line in lines {
        let Some((name, value)) = line.split_once(':') else { continue };
        let name = name.trim();
        let value = value.trim();
        if name.eq_ignore_ascii_case("connection") {
            let lower = value.to_ascii_lowercase();
            if lower.contains("close") {
                close = true;
            }
            if lower.contains("keep-alive") {
                close = false;
            }
            if lower.contains("upgrade") {
                upgrade = true;
            }
        } else if name.eq_ignore_ascii_case("upgrade") {
            upgrade = true;
        } else if name.eq_ignore_ascii_case("transfer-encoding") {
            chunked = value.to_ascii_lowercase().contains("chunked");
        } else if name.eq_ignore_ascii_case("content-length") {
            content_length = value.parse().unwrap_or(0);
        }
    }

    RequestMeta { close, upgrade, chunked, content_length }
}

/// 未自带鉴权头时补上 Bearer Key；客户端显式携带的鉴权头保持原样。
fn rewrite_head(head: &[u8], api_key: Option<&str>) -> Vec<u8> {
    let Some(api_key) = api_key.filter(|key| !key.trim().is_empty()) else {
        return head.to_vec();
    };
    // 按字节处理：头部可能包含非 UTF-8（Latin-1）值，不能走 from_utf8_lossy 改写
    let has_auth = head.split(|byte| *byte == b'\n').any(|line| {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        match line.iter().position(|byte| *byte == b':') {
            Some(pos) => {
                let name = &line[..pos];
                name.eq_ignore_ascii_case(b"authorization") || name.eq_ignore_ascii_case(b"x-api-key")
            }
            None => false,
        }
    });
    if has_auth {
        return head.to_vec();
    }

    let body_end = head.strip_suffix(b"\r\n\r\n").map_or(head.len(), |trimmed| trimmed.len());
    let mut out = Vec::with_capacity(head.len() + api_key.len() + 32);
    out.extend_from_slice(&head[..body_end]);
    out.extend_from_slice(b"\r\nAuthorization: Bearer ");
    out.extend_from_slice(api_key.as_bytes());
    out.extend_from_slice(b"\r\n\r\n");
    out
}

fn request_line(head: &[u8]) -> (String, String) {
    let text = String::from_utf8_lossy(head);
    let mut parts = text.split_whitespace();
    (
        parts.next().unwrap_or_default().to_string(),
        parts.next().unwrap_or_default().to_string(),
    )
}

/// 与 NInfer 的 `is_api_path` 对齐，并覆盖官方 WebUI 会访问的模型 / 工具端点。
fn is_api_path(target: &str) -> bool {
    let path = target.split(|c| c == '?' || c == '#').next().unwrap_or("");
    path == "/v1"
        || path.starts_with("/v1/")
        || matches!(path, "/health" | "/metrics" | "/stats" | "/slots" | "/props")
        || path == "/models"
        || path.starts_with("/models/")
        || path == "/tools"
        || path.starts_with("/tools/")
        || matches!(path, "/tokenize" | "/detokenize" | "/apply-template")
        || path == "/cors-proxy"
        || path.starts_with("/cors-proxy/")
}

/// 托管 llama.cpp 官方 WebUI：静态资源按路径返回，未知的非资源路径回退到 index.html
///（前端使用客户端路由，与服务端内嵌 WebUI 的行为一致）。
fn serve_ui(client: &mut TcpStream, root: &Path, target: &str, head_only: bool) -> io::Result<()> {
    let path = target.split(|c| c == '?' || c == '#').next().unwrap_or("");
    let rel = path.trim_start_matches('/');
    let rel = if rel.is_empty() { "index.html" } else { rel };
    // 只允许相对路径：拒绝盘符、反斜杠与 . / .. 段，避免目录穿越
    let safe = !rel.contains('\\')
        && !rel.contains(':')
        && rel.split('/').all(|segment| !segment.is_empty() && segment != "." && segment != "..");
    let file = safe.then(|| root.join(rel)).filter(|candidate| candidate.is_file());
    let fallback_index = file.is_none() && safe && !has_extension(rel);
    let is_index = fallback_index || rel.eq_ignore_ascii_case("index.html");
    let (body, content_type, cache) = match file {
        Some(file) => (fs::read(file)?, content_type_for(rel), cache_control_for(rel)),
        None if fallback_index => {
            let index = root.join("index.html");
            if !index.is_file() {
                return write_status(client, 404, "not found");
            }
            (fs::read(index)?, "text/html; charset=utf-8", "no-cache")
        }
        None => return write_status(client, 404, "not found"),
    };
    let body = if is_index { inject_theme_bootstrap(body) } else { body };
    let head = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nCache-Control: {}\r\n\r\n",
        content_type,
        body.len(),
        cache
    );
    client.write_all(head.as_bytes())?;
    if !head_only {
        client.write_all(&body)?;
    }
    client.flush()
}

/// 官方 WebUI 的深色类是脚本启动后才加上的，首帧会先按浅色绘制。
/// 这里在样式表之前按前端同一规则（CookLLM 显式主题 → LlamaUI 设置 → 系统偏好）落类并铺底色，
/// 让内嵌页面从第一帧起就与当前主题一致；显式传入 CookLLM 主题时同步写回 WebUI 设置，
/// 避免其初始化后按“跟随系统”把页面切回浅色。
fn inject_theme_bootstrap(html: Vec<u8>) -> Vec<u8> {
    const BOOTSTRAP: &str = concat!(
        "<script>(function(){try{",
        "var m=\"system\",forced=new URLSearchParams(location.search).get(\"cookllm-theme\");",
        "if(forced!==\"dark\"&&forced!==\"light\")forced=null;",
        "try{",
        "var raw=localStorage.getItem(\"LlamaUi.config\"),c=raw?JSON.parse(raw):null;",
        "if(forced){",
        "m=forced;",
        "try{localStorage.setItem(\"LlamaUi.config\",JSON.stringify(Object.assign({},c||{},{theme:forced})));}catch(e){}",
        "try{localStorage.setItem(\"mode-watcher-mode\",forced);}catch(e){}",
        "}else{",
        "var t=c&&c.theme;",
        "if(t===\"dark\"||t===\"light\"||t===\"system\"){m=t;}else{",
        "var w=localStorage.getItem(\"mode-watcher-mode\");",
        "if(w===\"dark\"||w===\"light\"||w===\"system\"){m=w;}}",
        "}",
        "}catch(e){}",
        "var d=m===\"dark\"||(m!==\"light\"&&window.matchMedia(\"(prefers-color-scheme: dark)\").matches);",
        "document.documentElement.classList.toggle(\"dark\",d);",
        "document.documentElement.style.colorScheme=d?\"dark\":\"light\";",
        "try{if(location.pathname!==\"/\")history.replaceState(null,\"\",\"/\"+location.search+location.hash);}catch(e){}",
        "try{if(window.caches)caches.keys().then(function(ks){ks.forEach(function(k){caches.delete(k);});});}catch(e){}",
        "}catch(e){}})();</script>",
        "<style>html.dark,html.dark body{background-color:#0d0d0d;color-scheme:dark}",
        "html:not(.dark),html:not(.dark) body{background-color:#fbfbfb;color-scheme:light}</style>"
    );
    let Ok(text) = std::str::from_utf8(&html) else {
        return html;
    };
    let lower = text.to_ascii_lowercase();
    let Some(start) = lower.find("<head>").or_else(|| lower.find("<head ")) else {
        return html;
    };
    let Some(offset) = text[start..].find('>') else {
        return html;
    };
    let insert_at = start + offset + 1;
    let mut out = String::with_capacity(html.len() + BOOTSTRAP.len());
    out.push_str(&text[..insert_at]);
    out.push_str(BOOTSTRAP);
    out.push_str(&text[insert_at..]);
    out.into_bytes()
}

/// UI 尚未下载完成：页面路由返回可自动刷新的等待页，静态资源返回 503，避免把 HTML 当脚本加载。
fn serve_ui_pending(
    client: &mut TcpStream,
    target: &str,
    error: Option<&str>,
    retrying: bool,
    head_only: bool,
) -> io::Result<()> {
    let path = target.split(|c| c == '?' || c == '#').next().unwrap_or("");
    let rel = path.trim_start_matches('/');
    let page_like = rel.is_empty() || rel.eq_ignore_ascii_case("index.html") || !has_extension(rel);
    if !page_like {
        let body = "WebUI 尚未就绪，请稍候";
        let head = format!(
            "HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nRetry-After: 3\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
            body.len()
        );
        client.write_all(head.as_bytes())?;
        if !head_only {
            client.write_all(body.as_bytes())?;
        }
        return client.flush();
    }

    let body = inject_theme_bootstrap(waiting_page(error, retrying).into_bytes());
    let head = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        body.len()
    );
    client.write_all(head.as_bytes())?;
    if !head_only {
        client.write_all(&body)?;
    }
    client.flush()
}

fn waiting_page(error: Option<&str>, retrying: bool) -> String {
    let detail = match error {
        Some(error) if retrying => format!(
            "<p class=\"error\">WebUI 准备失败：{}</p><p class=\"hint\">正在自动重试，完成后页面会自动刷新。</p>",
            html_escape(error)
        ),
        Some(error) => format!(
            "<p class=\"error\">WebUI 准备失败：{}</p><p class=\"hint\">自动重试已停止，可在 CookLLM 会话页点击「重新准备」；API 接口不受影响，可继续由其他客户端接入。</p>",
            html_escape(error)
        ),
        None => "<p class=\"hint\">首次启动需要准备 llama.cpp 官方 WebUI，完成后页面会自动刷新。</p>".to_string(),
    };
    format!(
        "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta http-equiv=\"refresh\" content=\"3\"><title>CookLLM · 正在准备会话界面</title><style>html,body{{height:100%;margin:0}}body{{display:grid;place-items:center;background:#f2f4f9;color:#1f2937;font:14px/1.6 system-ui,-apple-system,\"Segoe UI\",sans-serif}}main{{max-width:520px;padding:32px;text-align:center}}h1{{font-size:18px;margin:0 0 12px}}p{{margin:8px 0}}.hint{{color:#64748b}}.error{{color:#b91c1c;word-break:break-word}}html.dark body{{background:#0d0d0d;color:#e5e7eb}}html.dark .hint{{color:#9ca3af}}html.dark .error{{color:#f87171}}</style></head><body><main><h1>正在准备会话界面</h1>{detail}</main></body></html>"
    )
}

fn html_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn write_status(client: &mut TcpStream, status: u16, body: &str) -> io::Result<()> {
    let reason = match status {
        404 => "Not Found",
        503 => "Service Unavailable",
        _ => "OK",
    };
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    client.write_all(head.as_bytes())?;
    client.write_all(body.as_bytes())?;
    client.flush()
}

fn has_extension(rel: &str) -> bool {
    rel.rsplit('/').next().map_or(false, |name| name.contains('.'))
}

fn content_type_for(rel: &str) -> &'static str {
    match rel.rsplit('.').next().unwrap_or_default().to_ascii_lowercase().as_str() {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json",
        "webmanifest" => "application/manifest+json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "wasm" => "application/wasm",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn cache_control_for(rel: &str) -> &'static str {
    if rel.starts_with("_app/immutable/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn read_request(stream: &mut TcpStream) -> (String, String) {
        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        while find_head_end(&head).is_none() {
            if stream.read(&mut byte).unwrap_or(0) == 0 {
                break;
            }
            head.push(byte[0]);
        }
        let text = String::from_utf8_lossy(&head).to_string();
        let len = text
            .split("\r\n")
            .find_map(|line| {
                let lower = line.to_ascii_lowercase();
                lower.strip_prefix("content-length:").map(|value| value.trim().parse::<usize>().unwrap_or(0))
            })
            .unwrap_or(0);
        let mut body = vec![0u8; len];
        if len > 0 {
            stream.read_exact(&mut body).unwrap();
        }
        (text, String::from_utf8_lossy(&body).to_string())
    }

    fn read_response(stream: &mut TcpStream) -> (String, String) {
        read_request(stream)
    }

    #[test]
    fn rewrite_head_injects_bearer_when_missing() {
        let rewritten = rewrite_head(b"GET / HTTP/1.1\r\nHost: x\r\n\r\n", Some("secret"));
        let text = String::from_utf8_lossy(&rewritten);
        assert!(text.contains("Authorization: Bearer secret\r\n"));
        assert!(text.ends_with("\r\n\r\n"));
    }

    #[test]
    fn rewrite_head_without_key_keeps_head() {
        let head = b"GET / HTTP/1.1\r\nHost: x\r\n\r\n";
        assert_eq!(rewrite_head(head, None), head.to_vec());
        assert_eq!(rewrite_head(head, Some("  ")), head.to_vec());
    }

    #[test]
    fn rewrite_head_respects_existing_auth_headers() {
        let head = b"GET / HTTP/1.1\r\nAuthorization: Bearer custom\r\n\r\n";
        assert_eq!(rewrite_head(head, Some("secret")), head.to_vec());
        let head = b"GET / HTTP/1.1\r\nx-api-key: custom\r\n\r\n";
        assert_eq!(rewrite_head(head, Some("secret")), head.to_vec());
    }

    #[test]
    fn api_paths_are_forwarded() {
        for path in ["/v1/models", "/v1/chat/completions", "/props", "/slots", "/models/sse", "/tools", "/health"] {
            assert!(is_api_path(path), "{path} 应转发给引擎");
        }
        for path in ["/", "/chat/abc", "/_app/immutable/bundle.js", "/favicon.ico"] {
            assert!(!is_api_path(path), "{path} 应由代理托管");
        }
    }

    #[test]
    fn proxy_forwards_keep_alive_requests_and_bodies() {
        let engine = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let engine_port = engine.local_addr().unwrap().port();
        let engine_thread = thread::spawn(move || {
            let (mut conn, _) = engine.accept().unwrap();

            let (head, body) = read_request(&mut conn);
            assert!(head.starts_with("GET /v1/models HTTP/1.1"));
            assert!(head.contains("Authorization: Bearer secret"));
            assert!(body.is_empty());
            conn.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok").unwrap();
            conn.flush().unwrap();

            let (head, body) = read_request(&mut conn);
            assert!(head.starts_with("POST /v1/chat/completions HTTP/1.1"));
            assert!(head.contains("X-Api-Key: custom"));
            assert!(!head.contains("Authorization:"));
            assert_eq!(body, "hello");
            conn.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nworld").unwrap();
            conn.flush().unwrap();
            conn.shutdown(Shutdown::Write).unwrap();
        });

        let proxy = WebuiProxy::start("127.0.0.1", engine_port, Some("secret".into()), None).expect("代理应启动");
        let mut client = TcpStream::connect(("127.0.0.1", proxy.port)).unwrap();
        client.set_read_timeout(Some(Duration::from_secs(5))).unwrap();

        client
            .write_all(b"GET /v1/models HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n")
            .unwrap();
        let (head, body) = read_response(&mut client);
        assert!(head.starts_with("HTTP/1.1 200"));
        assert_eq!(body, "ok");

        client
            .write_all(b"POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 5\r\nX-Api-Key: custom\r\n\r\nhello")
            .unwrap();
        let (_, body) = read_response(&mut client);
        assert_eq!(body, "world");

        drop(client);
        engine_thread.join().unwrap();
    }

    #[test]
    fn inject_theme_bootstrap_lands_inside_head() {
        let html = b"<!doctype html><html><head><link rel=stylesheet href=a.css></head><body></body></html>".to_vec();
        let text = String::from_utf8(inject_theme_bootstrap(html)).unwrap();
        let head_end = text.find("</head>").unwrap();
        let boot = text.find("LlamaUi.config").unwrap();
        let link = text.find("a.css").unwrap();
        assert!(text.contains("mode-watcher-mode"), "旧版本回退键应保留");
        assert!(text.contains("cookllm-theme"), "应支持 CookLLM 显式主题参数");
        assert!(text.contains("history.replaceState"), "应从 /index.html 入口还原为根路径");
        assert!(text.contains("caches.keys"), "应清理 Service Worker 旧缓存");
        assert!(boot < link && boot < head_end, "预置脚本应位于样式表之前");
    }

    #[test]
    fn inject_theme_bootstrap_keeps_fragment_without_head() {
        let html = b"<title>fragment</title>".to_vec();
        assert_eq!(inject_theme_bootstrap(html.clone()), html);
    }

    #[test]
    fn proxy_serves_bundled_ui_and_forwards_api() {
        let root = std::env::temp_dir().join(format!("cookllm-webui-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("_app/immutable")).unwrap();
        fs::write(root.join("index.html"), "<!doctype html><html><head><title>cookllm-ui-test</title></head><body>ui</body></html>").unwrap();
        fs::write(root.join("_app/immutable/app.js"), "console.log(1)").unwrap();

        let engine = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let engine_port = engine.local_addr().unwrap().port();
        thread::spawn(move || {
            for conn in engine.incoming() {
                let Ok(mut conn) = conn else { break };
                thread::spawn(move || {
                    let mut buf = [0u8; 8192];
                    let n = conn.read(&mut buf).unwrap_or(0);
                    let text = String::from_utf8_lossy(&buf[..n]);
                    if text.starts_with("GET /v1/models") {
                        assert!(text.contains("Authorization: Bearer secret"));
                        let _ = conn.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{\"data\":[]}");
                        let _ = conn.flush();
                    }
                });
            }
        });

        let proxy = WebuiProxy::start(
            "127.0.0.1",
            engine_port,
            Some("secret".into()),
            Some(Arc::new(UiState::ready(root.clone()))),
        )
        .expect("代理应启动");
        let request = |path: &str| {
            let mut client = TcpStream::connect(("127.0.0.1", proxy.port)).unwrap();
            client.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let req = format!("GET {} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n", path);
            client.write_all(req.as_bytes()).unwrap();
            let (head, body) = read_response(&mut client);
            (head, body)
        };

        let (head, body) = request("/");
        assert!(head.starts_with("HTTP/1.1 200"), "index: {head}");
        assert!(head.contains("text/html"), "index: {head}");
        assert!(body.contains("cookllm-ui-test"));
        assert!(body.contains("mode-watcher-mode"), "缺少主题预置脚本");
        assert!(body.contains("<style>html.dark,html.dark body{background-color:#0d0d0d"), "缺少深色首帧底色");

        // iframe 入口绕开 Service Worker 预缓存的 "/"，同样注入主题脚本
        let (head, body) = request("/index.html?cookllm-theme=dark");
        assert!(head.starts_with("HTTP/1.1 200"), "index.html: {head}");
        assert!(body.contains("cookllm-ui-test"));
        assert!(body.contains("mode-watcher-mode"), "index.html 缺少主题预置脚本");

        let (head, body) = request("/_app/immutable/app.js");
        assert!(head.starts_with("HTTP/1.1 200"), "asset: {head}");
        assert!(head.contains("text/javascript"), "asset: {head}");
        assert_eq!(body, "console.log(1)");

        // 前端路由路径回退到 index.html
        let (head, body) = request("/chat/42");
        assert!(head.starts_with("HTTP/1.1 200"), "spa: {head}");
        assert!(body.contains("cookllm-ui-test"));

        // 缺失的静态资源保持 404，避免返回 HTML 造成脚本加载错误
        let (head, _) = request("/missing.js");
        assert!(head.starts_with("HTTP/1.1 404"), "missing: {head}");

        // API 请求仍转发给引擎并补鉴权头
        let (head, body) = request("/v1/models");
        assert!(head.starts_with("HTTP/1.1 200"), "api: {head}");
        assert_eq!(body, "{\"data\":[]}");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn proxy_serves_waiting_page_until_ui_ready() {
        let engine = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let engine_port = engine.local_addr().unwrap().port();
        let ui = Arc::new(UiState::new());
        let proxy = WebuiProxy::start("127.0.0.1", engine_port, None, Some(ui.clone()))
            .expect("等待页代理应启动");
        let request = |path: &str| {
            let mut client = TcpStream::connect(("127.0.0.1", proxy.port)).unwrap();
            client.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let req = format!("GET {} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n", path);
            client.write_all(req.as_bytes()).unwrap();
            read_response(&mut client)
        };

        let (head, body) = request("/");
        assert!(head.starts_with("HTTP/1.1 200"), "waiting: {head}");
        assert!(body.contains("正在准备会话界面"), "waiting body: {body}");
        assert!(body.contains("mode-watcher-mode"), "waiting theme bootstrap: {body}");
        assert!(body.contains("html.dark body{background:#0d0d0d;color:#e5e7eb}"), "waiting dark style: {body}");

        let (head, body) = request("/index.html?cookllm-theme=dark");
        assert!(head.starts_with("HTTP/1.1 200"), "waiting index.html: {head}");
        assert!(body.contains("正在准备会话界面"), "waiting index.html body: {body}");

        let (head, _) = request("/_app/immutable/app.js");
        assert!(head.starts_with("HTTP/1.1 503"), "pending asset: {head}");

        ui.set_retrying("<network>".into());
        let (_, body) = request("/");
        assert!(body.contains("&lt;network&gt;"), "escaped error: {body}");
        assert!(body.contains("正在自动重试"), "retrying hint: {body}");

        // 自动重试结束后不再暗示会自行恢复，改为引导手动重试
        ui.set_error("<network>".into());
        let (_, body) = request("/");
        assert!(body.contains("自动重试已停止"), "stopped hint: {body}");
        assert!(!body.contains("正在自动重试"), "no retry hint after stop: {body}");

        let root = std::env::temp_dir().join(format!("cookllm-webui-ready-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("_app")).unwrap();
        fs::write(root.join("index.html"), "<!doctype html><title>ready-ui</title>").unwrap();
        ui.set_ready(root.clone());

        let (head, body) = request("/");
        assert!(head.starts_with("HTTP/1.1 200"), "ready: {head}");
        assert!(body.contains("ready-ui"), "ready body: {body}");

        let _ = fs::remove_dir_all(&root);
    }

    /// 手动联调：真实 NInfer 引擎 + 已下载/解压的官方 WebUI 静态目录。
    #[test]
    #[ignore]
    fn manual_bundled_ui_against_ninfer() {
        let Ok(port) = std::env::var("COOKLLM_PROXY_TEST_PORT") else { return };
        let port: u16 = port.parse().unwrap();
        let key = std::env::var("COOKLLM_PROXY_TEST_KEY").unwrap();
        let Ok(root) = std::env::var("COOKLLM_PROXY_TEST_UI_ROOT") else { return };
        let root = PathBuf::from(root);
        assert!(root.join("index.html").is_file(), "缺少 WebUI：{}", root.display());

        let proxy = WebuiProxy::start(
            "127.0.0.1",
            port,
            Some(key),
            Some(Arc::new(UiState::ready(root.clone()))),
        )
        .unwrap();
        let request = |path: &str| {
            let mut client = TcpStream::connect(("127.0.0.1", proxy.port)).unwrap();
            client.set_read_timeout(Some(Duration::from_secs(30))).unwrap();
            let req = format!("GET {} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n", path);
            client.write_all(req.as_bytes()).unwrap();
            let mut raw = Vec::new();
            client.read_to_end(&mut raw).unwrap();
            String::from_utf8_lossy(&raw).to_string()
        };

        let index = request("/");
        assert!(index.starts_with("HTTP/1.1 200"), "index: {}", &index[..index.len().min(300)]);
        assert!(index.to_ascii_lowercase().contains("text/html"), "index headers: {}", &index[..index.len().min(400)]);
        let bundle = index
            .split("_app/immutable/")
            .nth(1)
            .and_then(|rest| rest.split('"').next())
            .map(|name| format!("/_app/immutable/{name}"))
            .expect("index.html 应引用主 bundle");
        let asset = request(&bundle);
        assert!(asset.starts_with("HTTP/1.1 200"), "bundle {bundle}: {}", &asset[..asset.len().min(300)]);

        let props = request("/props");
        assert!(props.starts_with("HTTP/1.1 200"), "props: {}", &props[..props.len().min(300)]);
        assert!(props.contains("default_generation_settings"));
        println!("bundled webui ok: {} · {}", bundle, root.display());
    }

    /// 手动联调：需要真实引擎监听 COOKLLM_PROXY_TEST_PORT 且启用 COOKLLM_PROXY_TEST_KEY。
    #[test]
    #[ignore]
    fn manual_proxy_against_real_engine() {
        let Ok(port) = std::env::var("COOKLLM_PROXY_TEST_PORT") else { return };
        let port: u16 = port.parse().unwrap();
        let key = std::env::var("COOKLLM_PROXY_TEST_KEY").unwrap();
        let timeout = Duration::from_secs(120);

        let mut direct = TcpStream::connect(("127.0.0.1", port)).unwrap();
        direct.set_read_timeout(Some(timeout)).unwrap();
        direct.write_all(b"GET /v1/models HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").unwrap();
        let mut raw = Vec::new();
        direct.read_to_end(&mut raw).unwrap();
        let text = String::from_utf8_lossy(&raw);
        assert!(text.starts_with("HTTP/1.1 401"), "direct must be unauthorized: {}", &text[..text.len().min(200)]);

        let proxy = WebuiProxy::start("127.0.0.1", port, Some(key), None).unwrap();
        let request = |path: &str, extra: &str| {
            let mut client = TcpStream::connect(("127.0.0.1", proxy.port)).unwrap();
            client.set_read_timeout(Some(timeout)).unwrap();
            let req = format!("GET {} HTTP/1.1\r\nHost: x\r\n{}Connection: close\r\n\r\n", path, extra);
            client.write_all(req.as_bytes()).unwrap();
            let mut raw = Vec::new();
            client.read_to_end(&mut raw).unwrap();
            String::from_utf8_lossy(&raw).to_string()
        };
        let models = request("/v1/models", "");
        assert!(models.starts_with("HTTP/1.1 200"), "models: {}", &models[..models.len().min(300)]);
        assert!(models.contains("\"data\""));
        // 引擎内嵌 WebUI 按 Accept-Encoding 压缩返回，验证首页经代理仍可正常下发
        let ui = request("/", "Accept-Encoding: gzip\r\n");
        assert!(ui.starts_with("HTTP/1.1 200"), "ui: {}", &ui[..ui.len().min(300)]);
        assert!(ui.to_ascii_lowercase().contains("content-encoding: gzip"), "ui headers: {}", &ui[..ui.len().min(400)]);

        let mut client = TcpStream::connect(("127.0.0.1", proxy.port)).unwrap();
        client.set_read_timeout(Some(timeout)).unwrap();
        let body = "{\"model\":\"x\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"stream\":true,\"max_tokens\":4}";
        let req = format!(
            "POST /v1/chat/completions HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        client.write_all(req.as_bytes()).unwrap();
        let mut raw = Vec::new();
        client.read_to_end(&mut raw).unwrap();
        let text = String::from_utf8_lossy(&raw);
        assert!(text.starts_with("HTTP/1.1 200"), "stream head: {}", &text[..text.len().min(300)]);
        assert!(text.contains("data: "), "stream body: {}", &text[..text.len().min(600)]);
        println!("proxy stream ok: {}", &text[..text.len().min(500)]);
    }

    /// 手动联调 NInfer：浏览器原生会话走跨源 POST，需验证代理透传 CORS 预检与 SSE。
    #[test]
    #[ignore]
    fn manual_proxy_cors_against_ninfer() {
        let Ok(port) = std::env::var("COOKLLM_PROXY_TEST_PORT") else { return };
        let port: u16 = port.parse().unwrap();
        let key = std::env::var("COOKLLM_PROXY_TEST_KEY").unwrap();
        let timeout = Duration::from_secs(180);

        let proxy = WebuiProxy::start("127.0.0.1", port, Some(key), None).unwrap();
        let request = |raw: String| {
            let mut client = TcpStream::connect(("127.0.0.1", proxy.port)).unwrap();
            client.set_read_timeout(Some(timeout)).unwrap();
            client.write_all(raw.as_bytes()).unwrap();
            let mut buf = Vec::new();
            client.read_to_end(&mut buf).unwrap();
            String::from_utf8_lossy(&buf).to_string()
        };

        let preflight = request(
            "OPTIONS /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: http://tauri.localhost\r\nAccess-Control-Request-Method: POST\r\nAccess-Control-Request-Headers: content-type\r\nConnection: close\r\n\r\n".into(),
        );
        assert!(preflight.starts_with("HTTP/1.1 200") || preflight.starts_with("HTTP/1.1 204"), "preflight: {}", &preflight[..preflight.len().min(300)]);
        let lower = preflight.to_ascii_lowercase();
        assert!(lower.contains("access-control-allow-origin"), "preflight cors: {}", &preflight[..preflight.len().min(400)]);
        assert!(lower.contains("content-type"), "preflight headers: {}", &preflight[..preflight.len().min(400)]);

        let models = request(
            "GET /v1/models HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n".into(),
        );
        let model = models
            .split("\"id\":\"")
            .nth(1)
            .and_then(|rest| rest.split('"').next())
            .expect("引擎应返回至少一个模型 ID");
        let body = format!(
            "{{\"model\":\"{}\",\"messages\":[{{\"role\":\"user\",\"content\":\"hi\"}}],\"stream\":true,\"max_tokens\":4}}",
            model
        );
        let stream = request(format!(
            "POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: http://tauri.localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        ));
        assert!(stream.starts_with("HTTP/1.1 200"), "stream head: {}", &stream[..stream.len().min(300)]);
        assert!(stream.contains("data: "), "stream body: {}", &stream[..stream.len().min(800)]);
        println!("ninfer proxy cors/stream ok: {}", &stream[..stream.len().min(500)]);
    }
}
