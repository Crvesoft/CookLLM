use serde::Serialize;
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
};

use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::config::{read_config, AppConfig};
use crate::now_ms;
use crate::system::{
    build_net_client, direct_client, hf_mirror_url, probe_local_proxy, proxied_client,
    with_ms_net_fallback, with_net_fallback, HF_UA,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiskUsage {
    path: String,
    total_bytes: u64,
    free_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HuggingFaceModel {
    id: String,
    author: String,
    name: String,
    downloads: u64,
    likes: u64,
    updated_at: String,
    tags: Vec<String>,
    /// 已有 .gguf 文件总数（-1 表示未查询）
    gguf_count: i64,
    /// 供列表页展示的推荐量化文件名（可能为空）
    sample_quant: Option<String>,
    /// 从模型名/标签解析出的参数量（十亿单位；解析失败为 None）
    parameters_b: Option<f64>,
    /// 从量化标签解析出的比特位（如 Q4_K_M → 4、IQ3_M → 3；无法识别为 None）
    quant_bits: Option<i32>,
    /// 模型所属社区（"hf" 或 "ms"）
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HuggingFaceFile {
    name: String,
    size_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HfDownloadResult {
    path: String,
    size_bytes: u64,
}

/* ==================== 阶段四：社区探索（HuggingFace & 魔塔社区 热门 / 搜索 / 下载） ==================== */

const HF_API_BASE: &str = "https://huggingface.co/api";
const HF_DL_BASE: &str = "https://huggingface.co";
const MS_OPENAPI_BASE: &str = "https://modelscope.cn/openapi/v1";
const MS_API_BASE: &str = "https://www.modelscope.cn/api/v1";
const MS_DL_BASE: &str = "https://www.modelscope.cn";

fn hf_repo_id(repo: &str) -> String {
    repo.trim().trim_end_matches('/').to_string()
}

/// 仓库名转安全目录名（社区探索下载的本地根目录名）。
fn hf_repo_dir_name(repo: &str) -> String {
    let id = hf_repo_id(repo);
    let last = id.rsplit('/').next().unwrap_or(&id);
    let sanitized: String = last
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '_' })
        .collect();
    if sanitized.is_empty() { "model".into() } else { sanitized }
}


/// 带标准浏览器 UA 的 HF 请求
fn hf_send(client: &reqwest::blocking::Client, url: &str) -> Result<reqwest::blocking::Response, reqwest::Error> {
    client
        .get(url)
        .header("user-agent", HF_UA)
        .timeout(std::time::Duration::from_secs(30))
        .send()
}

/// 处理 HF 响应：状态码检查 + JSON 解析
fn hf_response_json(response: reqwest::blocking::Response) -> Result<serde_json::Value, String> {
    if !response.status().is_success() {
        let code = response.status().as_u16();
        let message = match code {
            429 => "HuggingFace API 触发限流（HTTP 429），请稍后重试".to_string(),
            403 => "HuggingFace API 拒绝访问（HTTP 403）".to_string(),
            _ => format!("HuggingFace API 返回 HTTP {}", code),
        };
        return Err(message);
    }
    response.json().map_err(|error| format!("解析 HuggingFace API 响应失败：{}", error))
}

/// 查询 HF API：多通道自动兜底（配置代理 → 直连 → 本机代理端口 → hf-mirror 镜像）
fn fetch_hf_json(client: &reqwest::blocking::Client, url: &str) -> Result<serde_json::Value, String> {
    with_net_fallback(client, url, true, |client, url| {
        hf_response_json(hf_send(client, url).map_err(|error| error.to_string())?)
    })
    .map_err(|errors| format!("HuggingFace 连接失败（{}）。请在「设置 → 网络与代理」选择手动代理（Clash 端口 7897 / V2rayN 10809）后重试", errors.join("；")))
}

/// 处理 ModelScope 响应：状态码检查 + JSON 解析与错误提示提取
fn ms_response_json(response: reqwest::blocking::Response) -> Result<serde_json::Value, String> {
    let status = response.status();
    if !status.is_success() {
        let code = status.as_u16();
        let body_text = response.text().unwrap_or_default();
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&body_text) {
            if let Some(msg) = val.get("message").or_else(|| val.get("Message")).and_then(|v| v.as_str()) {
                return Err(format!("ModelScope 提示（HTTP {}）：{}", code, msg));
            }
        }
        let message = match code {
            429 => "ModelScope API 触发限流（HTTP 429），请稍后重试".to_string(),
            403 => "ModelScope API 拒绝访问（HTTP 403）".to_string(),
            _ => format!("ModelScope API 返回 HTTP {}", code),
        };
        return Err(message);
    }
    response.json().map_err(|error| format!("解析 ModelScope API 响应失败：{}", error))
}

/// 查询 ModelScope API：多通道自动兜底（直连 → 配置网络 → 本机代理端口）
fn fetch_ms_json(client: &reqwest::blocking::Client, url: &str) -> Result<serde_json::Value, String> {
    with_ms_net_fallback(client, url, |client, url| {
        ms_response_json(hf_send(client, url).map_err(|error| error.to_string())?)
    })
    .map_err(|errors| format!("ModelScope 连接失败（{}）", errors.join("；")))
}

/// 从文本集合中提取所有量化比特位集合（支持 GGUF 与 NInfer 多样化量化格式）
pub(crate) fn extract_quant_bits_set(sources: &[String]) -> std::collections::HashSet<i32> {
    let mut bits = std::collections::HashSet::new();
    for text in sources {
        let upper = text.to_uppercase();
        // 1-bit: ternary / 1.58bit / ptq1 / bonsai / 1-bit
        if upper.contains("TERNARY")
            || upper.contains("1.58BIT")
            || upper.contains("1.58-BIT")
            || upper.contains("1.58B")
            || upper.contains("PTQ1")
            || upper.contains("BONSAI")
            || upper.contains("1-BIT")
            || upper.contains("1BIT")
        {
            bits.insert(1);
        }

        // 2-bit: pq2 / 2-bit / iq2
        if upper.contains("PQ2")
            || upper.contains("2-BIT")
            || upper.contains("2BIT")
            || upper.contains("IQ2")
        {
            bits.insert(2);
        }

        // 3-bit: iq3 / gsq / 3-bit
        if upper.contains("IQ3")
            || upper.contains("GSQ")
            || upper.contains("3-BIT")
            || upper.contains("3BIT")
        {
            bits.insert(3);
        }

        // 4-bit: nvfp4 / nf4 / w4a4 / fp4 / int4 / 4-bit
        if upper.contains("NVFP4")
            || upper.contains("NF4")
            || upper.contains("W4A4")
            || upper.contains("FP4")
            || upper.contains("INT4")
            || upper.contains("4-BIT")
            || upper.contains("4BIT")
        {
            bits.insert(4);
        }

        // 5-bit: 5-bit
        if upper.contains("5-BIT") || upper.contains("5BIT") {
            bits.insert(5);
        }

        // 6-bit: 6-bit
        if upper.contains("6-BIT") || upper.contains("6BIT") {
            bits.insert(6);
        }

        // 8-bit: fp8 / int8 / w8a8 / 8-bit (排除 1.58bit 误命中)
        if upper.contains("FP8")
            || upper.contains("INT8")
            || upper.contains("W8A8")
            || (!upper.contains("1.58") && (upper.contains("8-BIT") || upper.contains("8BIT")))
        {
            bits.insert(8);
        }

        // 16-bit: bf16 / fp16 / f16 / fp32 / f32 / 16-bit
        if upper.contains("BF16")
            || upper.contains("FP16")
            || upper.contains("16-BIT")
            || upper.contains("16BIT")
        {
            bits.insert(16);
        }

        // 细粒度 Q / IQ token 解析（如 Q4_K_M, IQ3_S, Q8_0 等）
        for token in upper.split(|c: char| !c.is_ascii_alphanumeric()) {
            if token.starts_with('Q') && token.len() > 1 {
                if let Ok(digits) = token[1..].chars().take(2).collect::<String>().parse::<i32>() {
                    if (1..=8).contains(&digits) {
                        bits.insert(digits);
                    }
                }
            }
            if let Some(rest) = token.strip_prefix("IQ") {
                if let Ok(digits) = rest.chars().take(1).collect::<String>().parse::<i32>() {
                    if (1..=8).contains(&digits) {
                        bits.insert(digits);
                    }
                }
            }
            if matches!(token, "F16" | "BF16" | "FP16" | "FP32" | "F32") {
                bits.insert(16);
            }
        }
    }
    bits
}

/// 提取代表性量化比特位（优先常见主力量化位）
pub(crate) fn extract_primary_quant_bits(sources: &[String]) -> Option<i32> {
    let all = extract_quant_bits_set(sources);
    if all.is_empty() {
        return None;
    }
    for &preferred in &[4, 3, 2, 1, 5, 6, 8, 16] {
        if all.contains(&preferred) {
            return Some(preferred);
        }
    }
    all.into_iter().next()
}

/// 拉取候选模型并按量化位过滤（服务端二次过滤：HF filter 不支持按 bit 查询）。
/// 有量化过滤时放大 limit，循环翻页直到凑满目标数量或 API 返回空，保证分页语义正确。
fn fetch_models_filtered(client: &reqwest::blocking::Client, base: &str, format_filter: Option<&str>, limit: usize, skip: Option<usize>, quants: Option<Vec<i32>>) -> Result<Vec<HuggingFaceModel>, String> {
    let wanted = limit;
    if let Some(bits) = quants {
        if !bits.is_empty() {
            let mut seen = std::collections::HashSet::new();
            let mut collected: Vec<HuggingFaceModel> = Vec::new();
            let mut cursor = skip.unwrap_or(0);
            let page = (wanted * 4).clamp(50, 100);
            // 最多 20 页，避免极端情况死循环
            for _ in 0..20 {
                let mut url = format!("{}&limit={}&skip={}", base, page, cursor);
                match format_filter {
                    Some("gguf") => url.push_str("&filter=gguf"),
                    Some("ninfer") => url.push_str("&filter=ninfer"),
                    _ => {}
                }
                let value = fetch_hf_json(client, &url)?;
                let items = value.as_array().ok_or("HuggingFace API 返回格式异常")?;
                let mut any = false;
                for value in items {
                    if let Some(mut model) = hf_model_from_value(value) {
                        any = true;
                        let sources = std::iter::once(model.id.clone())
                            .chain(model.tags.iter().cloned())
                            .chain(std::iter::once(model.sample_quant.clone().unwrap_or_default()))
                            .collect::<Vec<_>>();
                        let all_bits = extract_quant_bits_set(&sources);
                        let matches_quant = bits.iter().any(|b| all_bits.contains(b));
                        if matches_quant && seen.insert(model.id.clone()) {
                            if let Some(&first_matched) = bits.iter().find(|b| all_bits.contains(b)) {
                                model.quant_bits = Some(first_matched);
                            }
                            collected.push(model);
                            if collected.len() >= wanted {
                                return Ok(collected);
                            }
                        }
                    }
                }
                if !any || items.len() < page {
                    break;
                }
                cursor += page;
            }
            return Ok(collected);
        }
    }
    // 无量化过滤：原有单页逻辑
    let mut url = format!("{}&limit={}", base, wanted);
    if let Some(page_skip) = skip {
        url.push_str(&format!("&skip={}", page_skip));
    }
    match format_filter {
        Some("gguf") => url.push_str("&filter=gguf"),
        Some("ninfer") => url.push_str("&filter=ninfer"),
        _ => {}
    }
    let value = fetch_hf_json(client, &url)?;
    let items = value.as_array().ok_or("HuggingFace API 返回格式异常")?;
    Ok(items.iter().filter_map(hf_model_from_value).collect::<Vec<_>>())
}

fn hf_model_from_value(value: &serde_json::Value) -> Option<HuggingFaceModel> {
    let id = value.get("id").and_then(|value| value.as_str())?.to_string();
    if id.is_empty() {
        return None;
    }
    let author = id.split('/').next().unwrap_or("").to_string();
    let name = value
        .get("modelId")
        .and_then(|value| value.as_str())
        .or_else(|| value.get("id").and_then(|value| value.as_str()))
        .unwrap_or(&id)
        .to_string();
    let tags: Vec<String> = value
        .get("tags")
        .and_then(|value| value.as_array())
        .map(|items| items.iter().filter_map(|tag| tag.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let gated = value
        .get("gated")
        .map(|value| match value {
            serde_json::Value::Bool(flag) => *flag,
            serde_json::Value::String(text) => text != "false",
            _ => false,
        })
        .unwrap_or(false);
    let sample_quant = tags
        .iter()
        .find(|tag| tag.to_lowercase().contains(".gguf") || tag.to_lowercase().contains(".ninfer"))
        .cloned()
        .or_else(|| {
            [
                "NVFP4", "NF4", "W4A4", "IQ3_S", "IQ3_XXS", "GSQ", "PQ2", "IQ2_S",
                "TERNARY", "1.58BIT", "PTQ1", "BONSAI", "FP8", "INT8", "BF16", "FP16",
                "Q4_K_M", "Q5_K_M", "Q8_0", "Q6_K", "Q4_0", "Q4_1", "Q5_0", "Q5_1",
                "Q2_K", "Q3_K_M", "Q3_K_S", "Q3_K_L", "RK8V4", "RK4V4", "RK4V4-E8", "RK2V4-E8", "K8V4",
            ]
            .iter()
            .find(|candidate| tags.iter().any(|tag| tag.to_uppercase().contains(**candidate)) || id.to_uppercase().contains(**candidate))
            .map(|value| value.to_string())
        });
    // 参数量：优先取形如 0.5B / 7B / 14B / 32B / 70B 的数字（名称或标签中最靠前的匹配）。
    let parameter_sources = std::iter::once(id.clone())
        .chain(tags.iter().cloned())
        .collect::<Vec<_>>();
    let parameters_b = parameter_sources
        .iter()
        .filter_map(|text| {
            regex_like_parameter(text).or_else(|| {
                // 兜底：把 "14b-instruct" 等小写串也纳入匹配
                regex_like_parameter(&text.to_lowercase())
            })
        })
        .next();
    // 量化比特位：从 id / 标签 / 推荐量化名中提取代表性比特位
    let quant_sources = std::iter::once(id.clone())
        .chain(tags.iter().cloned())
        .chain(std::iter::once(sample_quant.clone().unwrap_or_default()))
        .collect::<Vec<_>>();
    let quant_bits = extract_primary_quant_bits(&quant_sources);
    Some(HuggingFaceModel {
        id,
        author,
        name,
        downloads: value.get("downloads").and_then(|value| value.as_u64()).unwrap_or(0),
        likes: value.get("likes").and_then(|value| value.as_u64()).unwrap_or(0),
        updated_at: value.get("lastModified").and_then(|value| value.as_str()).unwrap_or("").to_string(),
        tags,
        gguf_count: -1,
        sample_quant: if gated { None } else { sample_quant },
        parameters_b,
        quant_bits,
        source: Some("hf".into()),
    })
}

/// 从文本中提取参数量（十亿）：匹配 "7b"、"14b"、"0.5b"、"32b" 等；返回最先出现且 <= 1000B 的值。
fn regex_like_parameter(text: &str) -> Option<f64> {
    let lower = text.to_lowercase();
    let bytes = lower.as_bytes();
    let mut start: Option<usize> = None;
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b.is_ascii_digit() || b == b'.' {
            if start.is_none() {
                start = Some(i);
            }
        } else {
            // 'b' 紧跟数字串尾部时视为参数量（"7b" / "0.5b"）；
            // 其余字符一律重置数字起点（"2.5-14b" 应命中 14 而非报错）。
            if b == b'b' {
                if let Some(from) = start {
                    let candidate = &lower[from..i];
                    if let Ok(value) = candidate.parse::<f64>() {
                        if value > 0.0 && value <= 1000.0 {
                            return Some(value);
                        }
                    }
                }
            }
            start = None;
        }
        i += 1;
    }
    None
}

/// 解析魔塔社区（ModelScope）OpenAPI 模型条目为 HuggingFaceModel 统一结构
fn ms_model_from_value(value: &serde_json::Value) -> Option<HuggingFaceModel> {
    let id = value.get("id").and_then(|v| v.as_str())?.to_string();
    if id.is_empty() {
        return None;
    }
    let author = id.split('/').next().unwrap_or("").to_string();
    let name = value
        .get("display_name")
        .and_then(|v| v.as_str())
        .unwrap_or(&id)
        .to_string();
    let tags: Vec<String> = value
        .get("tags")
        .and_then(|v| v.as_array())
        .map(|items| items.iter().filter_map(|t| t.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let sample_quant = tags
        .iter()
        .find(|tag| tag.to_lowercase().contains(".gguf") || tag.to_lowercase().contains(".ninfer"))
        .cloned()
        .or_else(|| {
            [
                "NVFP4", "NF4", "W4A4", "IQ3_S", "IQ3_XXS", "GSQ", "PQ2", "IQ2_S",
                "TERNARY", "1.58BIT", "PTQ1", "BONSAI", "FP8", "INT8", "BF16", "FP16",
                "Q4_K_M", "Q5_K_M", "Q8_0", "Q6_K", "Q4_0", "Q4_1", "Q5_0", "Q5_1",
                "Q2_K", "Q3_K_M", "Q3_K_S", "Q3_K_L", "RK8V4", "RK4V4", "RK4V4-E8", "RK2V4-E8", "K8V4",
            ]
            .iter()
            .find(|candidate| tags.iter().any(|tag| tag.to_uppercase().contains(**candidate)) || id.to_uppercase().contains(**candidate))
            .map(|v| v.to_string())
        });
    let raw_params = value.get("params").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let parameters_b = if raw_params > 10_000_000.0 {
        Some((raw_params / 1_000_000_000.0 * 100.0).round() / 100.0)
    } else {
        let parameter_sources = std::iter::once(id.clone()).chain(tags.iter().cloned()).collect::<Vec<_>>();
        parameter_sources.iter().filter_map(|text| regex_like_parameter(text).or_else(|| regex_like_parameter(&text.to_lowercase()))).next()
    };
    let quant_sources = std::iter::once(id.clone())
        .chain(tags.iter().cloned())
        .chain(std::iter::once(sample_quant.clone().unwrap_or_default()))
        .collect::<Vec<_>>();
    let quant_bits = extract_primary_quant_bits(&quant_sources);
    Some(HuggingFaceModel {
        id,
        author,
        name,
        downloads: value.get("downloads").and_then(|v| v.as_u64()).unwrap_or(0),
        likes: value.get("likes").and_then(|v| v.as_u64()).unwrap_or(0),
        updated_at: value.get("last_modified").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        tags,
        gguf_count: -1,
        sample_quant,
        parameters_b,
        quant_bits,
        source: Some("ms".into()),
    })
}

/// 拉取魔塔社区候选模型并按量化位过滤（服务端按 search 查询，若指定 quants 则按比特位二次过滤）。
fn ms_fetch_models_filtered(
    client: &reqwest::blocking::Client,
    search: Option<&str>,
    sort: Option<&str>,
    format_filter: Option<&str>,
    limit: usize,
    skip: Option<usize>,
    quants: Option<Vec<i32>>,
) -> Result<Vec<HuggingFaceModel>, String> {
    let wanted = limit;
    let ms_sort = match sort {
        Some("downloads") => "downloads",
        Some("likes") => "likes",
        Some("last_modified") | Some("lastModified") | Some("updated") => "last_modified",
        _ => "default",
    };
    let raw_search = search.unwrap_or("").trim();
    let mut effective_search = raw_search.to_string();
    if format_filter == Some("gguf") {
        if !effective_search.to_lowercase().contains("gguf") {
            if effective_search.is_empty() {
                effective_search = "gguf".to_string();
            } else {
                effective_search = format!("{} gguf", effective_search);
            }
        }
    } else if format_filter == Some("ninfer") {
        if !effective_search.to_lowercase().contains("ninfer") {
            if effective_search.is_empty() {
                effective_search = "ninfer".to_string();
            } else {
                effective_search = format!("{} ninfer", effective_search);
            }
        }
    }

    let is_ninfer = format_filter == Some("ninfer") || effective_search.to_lowercase().contains("ninfer");

    if let Some(bits) = quants {
        if !bits.is_empty() {
            // 注意：对于 NINFER 格式模型，魔搭社区仓库与标签非 q{bit} 命名（为 NVFP4 / Ternary / PQ2 / GSQ 等），
            // 若向 search 追加 q{bit} 会导致 ModelScope OpenAPI 布尔 AND 搜索命中 0 条记录！
            // 故仅在非 NINFER（如 GGUF）场景下向 search 追加 q{bit}，NINFER 场景在客户端内存中精准过滤。
            if !is_ninfer {
                let quant_tokens: Vec<String> = bits.iter().map(|b| format!("q{}", b)).collect();
                let search_lower = effective_search.to_lowercase();
                let has_quant_in_search = quant_tokens.iter().any(|qt| search_lower.contains(qt));
                if !has_quant_in_search {
                    if effective_search.is_empty() {
                        effective_search = quant_tokens.join(" ");
                    } else {
                        effective_search = format!("{} {}", effective_search, quant_tokens.join(" "));
                    }
                }
            }

            let mut seen = std::collections::HashSet::new();
            let mut collected: Vec<HuggingFaceModel> = Vec::new();
            // ModelScope openapi 的 page_size 最大不得超过 50！
            let page_size = 50usize;
            let mut page_number = (skip.unwrap_or(0) / page_size) + 1;
            for _ in 0..15 {
                let mut url = reqwest::Url::parse(&format!("{}/models", MS_OPENAPI_BASE))
                    .map_err(|e| format!("构建请求 URL 失败：{}", e))?;
                url.query_pairs_mut()
                    .append_pair("page_size", &page_size.to_string())
                    .append_pair("page_number", &page_number.to_string())
                    .append_pair("sort", ms_sort);
                if !effective_search.is_empty() {
                    url.query_pairs_mut().append_pair("search", &effective_search);
                }
                let value = fetch_ms_json(client, url.as_str())?;
                let items = value.get("data").and_then(|d| d.get("models")).and_then(|m| m.as_array())
                    .ok_or_else(|| "ModelScope API 返回格式异常".to_string())?;
                let mut any = false;
                for item in items {
                    if let Some(mut model) = ms_model_from_value(item) {
                        any = true;
                        let sources = std::iter::once(model.id.clone())
                            .chain(model.tags.iter().cloned())
                            .chain(std::iter::once(model.sample_quant.clone().unwrap_or_default()))
                            .collect::<Vec<_>>();
                        let all_bits = extract_quant_bits_set(&sources);
                        let matches_quant = bits.iter().any(|b| all_bits.contains(b));
                        if matches_quant && seen.insert(model.id.clone()) {
                            if let Some(&first_matched) = bits.iter().find(|b| all_bits.contains(b)) {
                                model.quant_bits = Some(first_matched);
                            }
                            collected.push(model);
                            if collected.len() >= wanted {
                                return Ok(collected);
                            }
                        }
                    }
                }
                if !any || items.len() < page_size {
                    break;
                }
                page_number += 1;
            }
            return Ok(collected);
        }
    }

    // ModelScope openapi 的 page_size 最大不得超过 50
    let page_size = wanted.clamp(1, 50);
    let page_number = (skip.unwrap_or(0) / page_size) + 1;
    let mut url = reqwest::Url::parse(&format!("{}/models", MS_OPENAPI_BASE))
        .map_err(|e| format!("构建请求 URL 失败：{}", e))?;
    url.query_pairs_mut()
        .append_pair("page_size", &page_size.to_string())
        .append_pair("page_number", &page_number.to_string())
        .append_pair("sort", ms_sort);
    if !effective_search.is_empty() {
        url.query_pairs_mut().append_pair("search", &effective_search);
    }
    let value = fetch_ms_json(client, url.as_str())?;
    let items = value.get("data").and_then(|d| d.get("models")).and_then(|m| m.as_array())
        .ok_or_else(|| "ModelScope API 返回格式异常".to_string())?;
    Ok(items.iter().filter_map(ms_model_from_value).collect())
}

/// 本周 HuggingFace 热门模型（sort=trending）；支持格式筛选（全部 / 仅 GGUF / 仅 NINFER）。
#[tauri::command]
pub(crate) async fn hf_trending(app: AppHandle, limit: Option<usize>, gguf_only: Option<bool>, format_filter: Option<String>, skip: Option<usize>, sort: Option<String>, quants: Option<Vec<i32>>) -> Result<Vec<HuggingFaceModel>, String> {
    let config = read_config(&app)?;
    let network = config.network.clone().unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        let client = build_net_client(&network)?;
        let base = format!("{}/models?sort=trendingScore&direction=-1&expand[]=lastModified&expand[]=downloads&expand[]=likes", HF_API_BASE);
        let base = if let Some(sort_by) = sort {
            base.replace("sort=trendingScore", &format!("sort={}", sort_by))
        } else {
            base
        };
        let effective_filter = format_filter.as_deref().or_else(|| {
            if gguf_only.unwrap_or(false) { Some("gguf") } else { None }
        });
        fetch_models_filtered(&client, &base, effective_filter, limit.unwrap_or(12), skip, quants)
    })
    .await
    .map_err(|error| format!("获取热门榜单任务中断：{}", error))?
}

/// 搜索 HuggingFace 模型（关键词 / 组织名）；支持格式筛选。
#[tauri::command]
pub(crate) async fn hf_search(app: AppHandle, query: String, limit: Option<usize>, gguf_only: Option<bool>, format_filter: Option<String>, skip: Option<usize>, sort: Option<String>, quants: Option<Vec<i32>>) -> Result<Vec<HuggingFaceModel>, String> {
    let config = read_config(&app)?;
    let network = config.network.clone().unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        let client = build_net_client(&network)?;
        let effective_filter = format_filter.as_deref().or_else(|| {
            if gguf_only.unwrap_or(false) { Some("gguf") } else { None }
        });
        let mut url = reqwest::Url::parse(&format!("{}/models", HF_API_BASE)).map_err(|error| format!("构建请求 URL 失败：{}", error))?;
        let search_text = query.trim();
        let effective_search = if search_text.is_empty() && effective_filter == Some("ninfer") {
            "ninfer"
        } else {
            search_text
        };
        if !effective_search.is_empty() {
            url.query_pairs_mut().append_pair("search", effective_search);
        }
        url.query_pairs_mut()
            .append_pair("sort", sort.as_deref().unwrap_or("trendingScore"))
            .append_pair("expand[]", "lastModified")
            .append_pair("expand[]", "downloads")
            .append_pair("expand[]", "likes")
            .append_pair("direction", "-1");
        let base = url.as_str().to_string();
        fetch_models_filtered(&client, &base, effective_filter, limit.unwrap_or(30), skip, quants)
    })
    .await
    .map_err(|error| format!("搜索任务中断：{}", error))?
}

/// 列出仓库 main 分支的文件列表（递归，按文件名排序）；
/// format_filter 为 "gguf" 时仅保留 .gguf，为 "ninfer" 时仅保留 .ninfer，
/// 为 "all" 或 None 时不按格式过滤（仅保留普通文件，排除目录）。
#[tauri::command]
pub(crate) async fn hf_list_files(
    app: AppHandle,
    repo: String,
    format_filter: Option<String>,
) -> Result<Vec<HuggingFaceFile>, String> {
    let config = read_config(&app)?;
    let network = config.network.clone().unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        let client = build_net_client(&network)?;
        let base = hf_repo_id(&repo);
        let url = format!("{}/models/{}/tree/main?recursive=true&expand=false", HF_API_BASE, base);
        let value = fetch_hf_json(&client, &url)?;
        let items = value.as_array().ok_or("HuggingFace API 返回格式异常")?;
        let filter_mode = format_filter.as_deref().unwrap_or("all").trim().to_lowercase();
        let mut files: Vec<HuggingFaceFile> = items
            .iter()
            .filter_map(|item| {
                let kind = item.get("type").and_then(|value| value.as_str()).unwrap_or("");
                if kind != "file" {
                    return None;
                }
                let name = item.get("path").and_then(|value| value.as_str())?;
                let lower = name.to_lowercase();
                match filter_mode.as_str() {
                    "gguf" => {
                        if !lower.ends_with(".gguf") {
                            return None;
                        }
                    }
                    "ninfer" => {
                        if !lower.ends_with(".ninfer") {
                            return None;
                        }
                    }
                    _ => {
                        // "all" 或其他：不过滤文件扩展名
                    }
                }
                let size = item.get("size").and_then(|value| value.as_u64()).unwrap_or(0);
                Some(HuggingFaceFile { name: name.to_string(), size_bytes: size })
            })
            .collect();
        files.sort_by(|left, right| left.name.cmp(&right.name));
        Ok(files)
    })
    .await
    .map_err(|error| format!("获取文件列表任务中断：{}", error))?
}

/// 本周魔塔社区热门模型（sort=default）；支持格式筛选（全部 / 仅 GGUF / 仅 NINFER）。
#[tauri::command]
pub(crate) async fn ms_trending(
    app: AppHandle,
    limit: Option<usize>,
    gguf_only: Option<bool>,
    format_filter: Option<String>,
    skip: Option<usize>,
    sort: Option<String>,
    quants: Option<Vec<i32>>,
) -> Result<Vec<HuggingFaceModel>, String> {
    let config = read_config(&app)?;
    let network = config.network.clone().unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        let client = build_net_client(&network)?;
        let effective_filter = format_filter.as_deref().or_else(|| {
            if gguf_only.unwrap_or(false) { Some("gguf") } else { None }
        });
        ms_fetch_models_filtered(&client, None, sort.as_deref(), effective_filter, limit.unwrap_or(12), skip, quants)
    })
    .await
    .map_err(|error| format!("获取魔塔社区热门榜单任务中断：{}", error))?
}

/// 搜索魔塔社区模型（关键词 / 组织名）；支持格式筛选。
#[tauri::command]
pub(crate) async fn ms_search(
    app: AppHandle,
    query: String,
    limit: Option<usize>,
    gguf_only: Option<bool>,
    format_filter: Option<String>,
    skip: Option<usize>,
    sort: Option<String>,
    quants: Option<Vec<i32>>,
) -> Result<Vec<HuggingFaceModel>, String> {
    let config = read_config(&app)?;
    let network = config.network.clone().unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        let client = build_net_client(&network)?;
        let effective_filter = format_filter.as_deref().or_else(|| {
            if gguf_only.unwrap_or(false) { Some("gguf") } else { None }
        });
        ms_fetch_models_filtered(&client, Some(&query), sort.as_deref(), effective_filter, limit.unwrap_or(30), skip, quants)
    })
    .await
    .map_err(|error| format!("魔塔社区搜索任务中断：{}", error))?
}

/// 列出魔塔社区仓库中的文件列表（递归，按文件名排序）；
/// format_filter 为 "gguf" 时仅保留 .gguf，为 "ninfer" 时仅保留 .ninfer，
/// 为 "all" 或 None 时不按格式过滤（排除目录）。
#[tauri::command]
pub(crate) async fn ms_list_files(
    app: AppHandle,
    repo: String,
    format_filter: Option<String>,
) -> Result<Vec<HuggingFaceFile>, String> {
    let config = read_config(&app)?;
    let network = config.network.clone().unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        let client = build_net_client(&network)?;
        let base = hf_repo_id(&repo);
        let url = format!("{}/models/{}/repo/files?Revision=master&Recursive=True", MS_API_BASE, base);
        let value = fetch_ms_json(&client, &url)?;
        let files_array = value.get("Data").and_then(|d| d.get("Files")).and_then(|f| f.as_array())
            .ok_or_else(|| "魔塔社区返回文件列表格式异常".to_string())?;
        let filter_mode = format_filter.as_deref().unwrap_or("all").trim().to_lowercase();
        let mut files: Vec<HuggingFaceFile> = files_array
            .iter()
            .filter_map(|item| {
                // 排除目录（ModelScope 中 Type 为 "tree" 的是目录，"blob" 是文件）
                let item_type = item.get("Type").and_then(|v| v.as_str()).unwrap_or("");
                if item_type == "tree" {
                    return None;
                }
                let path = item.get("Path").and_then(|v| v.as_str()).or_else(|| item.get("Name").and_then(|v| v.as_str()))?;
                let lower = path.to_lowercase();
                match filter_mode.as_str() {
                    "gguf" => {
                        if !lower.ends_with(".gguf") {
                            return None;
                        }
                    }
                    "ninfer" => {
                        if !lower.ends_with(".ninfer") {
                            return None;
                        }
                    }
                    _ => {
                        // "all" 或其他：不过滤文件扩展名
                    }
                }
                let size_bytes = item.get("Size").and_then(|v| v.as_u64()).unwrap_or(0);
                Some(HuggingFaceFile {
                    name: path.to_string(),
                    size_bytes,
                })
            })
            .collect();
        files.sort_by(|left, right| left.name.cmp(&right.name));
        Ok(files)
    })
    .await
    .map_err(|error| format!("获取魔塔社区文件列表任务中断：{}", error))?
}

/// 计算目标下载路径并防目录逃逸（仅允许文件名中的普通路径段）。
fn model_download_dest(root: &Path, repo: &str, file: &str) -> Result<PathBuf, String> {
    use std::path::Component;
    let repo_dir = root.join(hf_repo_dir_name(repo));
    let mut out = repo_dir.clone();
    for component in Path::new(file).components() {
        match component {
            Component::Normal(segment) => out.push(segment),
            _ => return Err(format!("文件名包含非法路径：{}", file)),
        }
    }
    if !out.starts_with(&repo_dir) {
        return Err("非法下载路径".into());
    }
    Ok(out)
}

/// 单个下载任务的独立控制器：取消 / 暂停标志按任务隔离（每个 taskId 一份），
/// 不再使用进程级全局标志，避免「取消一个任务 = 全部取消 / 全部暂停」的串扰。
#[derive(Default)]
struct DownloadTaskControl {
    cancel: AtomicBool,
    pause: AtomicBool,
}

/// 下载任务注册表：taskId -> 任务控制器。
/// 前端每次发起下载携带唯一 taskId；取消 / 暂停 / 删除只操作自己那把控制器，
/// 同时多个下载任务可并行推进互不干扰。
#[derive(Clone, Default)]
pub(crate) struct DownloadRegistry(Arc<Mutex<HashMap<String, Arc<DownloadTaskControl>>>>);

impl DownloadRegistry {
    /// 注册（或重置）一个任务控制器，返回该任务的 Arc 引用。
    fn register(&self, task_id: &str) -> Arc<DownloadTaskControl> {
        let slot = Arc::new(DownloadTaskControl::default());
        if let Ok(mut guard) = self.0.lock() {
            guard.insert(task_id.to_string(), slot.clone());
        }
        slot
    }

    /// 按 taskId 取控制器；不存在（任务已结束 / 未注册）返回 None。
    fn slot(&self, task_id: &str) -> Option<Arc<DownloadTaskControl>> {
        self.0.lock().ok()?.get(task_id).cloned()
    }

    /// 校验 controller 仍是该 taskId 当前注册的控制器。
    /// 用于下载循环自检：若自己已被新一轮下载接管（register 覆盖）或被摘除（unregister），
    /// 说明自己已成孤儿循环，应立即退出，否则暂停 / 取消永远送不到它手上。
    fn is_current(&self, task_id: &str, controller: &Arc<DownloadTaskControl>) -> bool {
        self.0.lock().ok()
            .and_then(|guard| guard.get(task_id).map(|slot| Arc::ptr_eq(slot, controller)))
            .unwrap_or(false)
    }

    /// 摘除控制器，但仅当注册表里的仍是 controller 本人时才摘。
    /// 无条件的 unregister 在「新循环接管旧循环」时会误删新循环的控制器，让它变成新的孤儿。
    fn unregister_if_current(&self, task_id: &str, controller: &Arc<DownloadTaskControl>) {
        if let Ok(mut guard) = self.0.lock() {
            if guard.get(task_id).map(|slot| Arc::ptr_eq(slot, controller)).unwrap_or(false) {
                guard.remove(task_id);
            }
        }
    }

    /// 移除任务控制器（下载循环结束 / 前端删除任务后调用）。
    fn unregister(&self, task_id: &str) {
        if let Ok(mut guard) = self.0.lock() {
            guard.remove(task_id);
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelDownloadProgress {
    task_id: String,
    repo: String,
    file: String,
    phase: String,
    percent: u32,
    downloaded: u64,
    total: u64,
    speed_bps: u64,
    message: String,
}

/// 模型下载命令的结构化错误：前端按 code 分支，不再匹配中文消息。
#[derive(Debug, Clone, Serialize)]
pub(crate) struct DownloadCommandError {
    code: &'static str,
    message: String,
}

impl DownloadCommandError {
    fn from_message(message: String) -> Self {
        if message == "下载任务已被接管" {
            return Self { code: "download_taken_over", message };
        }
        if message == "下载已取消" {
            return Self { code: "download_cancelled", message };
        }
        if message == "下载已暂停" {
            return Self { code: "download_paused", message };
        }
        if let Some(detail) = message.strip_prefix("HF_GATED_NEED_TOKEN::") {
            return Self { code: "hf_gated_need_token", message: detail.to_string() };
        }
        if let Some(detail) = message.strip_prefix("HF_GATED_NO_PERMISSION::") {
            return Self { code: "hf_gated_no_permission", message: detail.to_string() };
        }
        Self { code: "download_failed", message }
    }
}

impl From<String> for DownloadCommandError {
    fn from(message: String) -> Self {
        Self::from_message(message)
    }
}

#[cfg(test)]
mod download_error_tests {
    use super::DownloadCommandError;

    #[test]
    fn maps_download_lifecycle_errors() {
        assert_eq!(DownloadCommandError::from_message("下载任务已被接管".into()).code, "download_taken_over");
        assert_eq!(DownloadCommandError::from_message("下载已取消".into()).code, "download_cancelled");
        assert_eq!(DownloadCommandError::from_message("下载已暂停".into()).code, "download_paused");
    }

    #[test]
    fn strips_gated_prefix_and_keeps_other_messages() {
        let gated = DownloadCommandError::from_message("HF_GATED_NEED_TOKEN::需要授权".into());
        assert_eq!(gated.code, "hf_gated_need_token");
        assert_eq!(gated.message, "需要授权");

        let unknown = DownloadCommandError::from_message("网络中断".into());
        assert_eq!(unknown.code, "download_failed");
        assert_eq!(unknown.message, "网络中断");
    }
}

fn emit_model_progress(app: &AppHandle, task_id: &str, repo: &str, file: &str, phase: &str, percent: u32, downloaded: u64, total: u64, speed: u64, message: impl Into<String>) {
    let _ = app.emit("model-download-progress", ModelDownloadProgress {
        task_id: task_id.into(),
        repo: repo.into(),
        file: file.into(),
        phase: phase.into(),
        percent: percent.min(100),
        downloaded,
        total,
        speed_bps: speed,
        message: message.into(),
    });
}

/// 取消指定下载任务：仅中止该 taskId 对应的下载循环，不影响其他任务。
#[tauri::command]
pub(crate) fn hf_cancel_download(state: State<DownloadRegistry>, task_id: String) -> Result<(), String> {
    if let Some(slot) = state.slot(&task_id) {
        slot.cancel.store(true, Ordering::Relaxed);
        slot.pause.store(false, Ordering::Relaxed);
    }
    Ok(())
}

/// 暂停指定下载任务（保留 .part 断点文件，前端「继续」时重新发起并断点续传），仅影响该 taskId。
#[tauri::command]
pub(crate) fn hf_pause_download(state: State<DownloadRegistry>, task_id: String) -> Result<(), String> {
    if let Some(slot) = state.slot(&task_id) {
        slot.pause.store(true, Ordering::Relaxed);
    }
    Ok(())
}

/// 清除 / 摘除指定任务的控制器（前端重新发起下载或删除任务时调用，防止残留标志影响下一轮）。
#[tauri::command]
pub(crate) fn hf_clear_download(state: State<DownloadRegistry>, task_id: String) -> Result<(), String> {
    state.unregister(&task_id);
    Ok(())
}

/// 删除本地文件（下载管理中「取消任务并删除缓存」用）。
/// 出于防御只允许删除模型库目录内的目标，拒绝任意路径的删除请求。
#[tauri::command]
pub(crate) fn remove_local_file(app: AppHandle, path: String) -> Result<(), String> {
    let target = PathBuf::from(path.trim());
    if !target.exists() {
        return Ok(());
    }
    let config = read_config(&app)?;
    let root = models_root(&app, &config)?;
    // 双方都 canonicalize（解析相对段与大小写差异）后再比较前缀，避免绕过
    let canonical_target = target.canonicalize().map_err(|error| error.to_string())?;
    let canonical_root = root.canonicalize().unwrap_or(root);
    if !canonical_target.starts_with(&canonical_root) {
        return Err(format!("拒绝删除模型库目录之外的路径：{}", path));
    }
    if target.is_dir() {
        fs::remove_dir_all(&target).map_err(|error| format!("删除目录失败：{}", error))
    } else {
        fs::remove_file(&target).map_err(|error| format!("删除文件失败：{}", error))
    }
}

/// 在系统资源管理器中定位并选中文件（文件不存在时打开其所在目录）。
#[tauri::command]
pub(crate) fn reveal_in_folder(path: String) -> Result<(), String> {
    let target = PathBuf::from(path.trim());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let args = if target.is_dir() {
            vec![target.to_string_lossy().to_string()]
        } else if target.exists() {
            vec!["/select,".to_string(), target.to_string_lossy().to_string()]
        } else if let Some(parent) = target.parent().filter(|dir| dir.exists()) {
            vec![parent.to_string_lossy().to_string()]
        } else {
            return Err(format!("路径不存在：{}", path));
        };
        std::process::Command::new("explorer")
            .args(&args)
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|error| format!("打开资源管理器失败：{}", error))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = target;
        return Err("该功能仅支持 Windows".into());
    }
    Ok(())
}

/// 下载 HF 文件：多通道自动兜底（配置代理 → 直连 → 本地探测代理 → hf-mirror 镜像）。
/// 返回 (客户端, 实际 URL, 是否已降级)。
fn download_hf_with_fallback(config_client: &reqwest::blocking::Client, url: &str) -> Result<(reqwest::blocking::Client, String), String> {
    // 只要某通道连接成功（含 4xx 授权类）就返回该通道；由调用者处理状态码
    let attempt = |client: &reqwest::blocking::Client, url: &str| -> Result<(reqwest::blocking::Client, String), String> {
        let response = client
            .get(url)
            .header("user-agent", HF_UA)
            .timeout(std::time::Duration::from_secs(30))
            .send()
            .map_err(|error| error.to_string())?;
        drop(response);
        Ok((client.clone(), url.to_string()))
    };
    with_net_fallback(config_client, url, true, attempt)
        .map_err(|_| "无法访问 HuggingFace（配置代理 / 直连 / 本地代理 / hf-mirror 镜像均失败）".to_string())
}

/// 下载魔塔社区文件：多通道自动兜底（直连 → 配置网络 → 本地探测代理）。
/// 返回 (客户端, 实际 URL)。
fn download_ms_with_fallback(config_client: &reqwest::blocking::Client, url: &str) -> Result<(reqwest::blocking::Client, String), String> {
    let attempt = |client: &reqwest::blocking::Client, url: &str| -> Result<(reqwest::blocking::Client, String), String> {
        let response = client
            .get(url)
            .header("user-agent", HF_UA)
            .timeout(std::time::Duration::from_secs(30))
            .send()
            .map_err(|error| error.to_string())?;
        drop(response);
        Ok((client.clone(), url.to_string()))
    };
    with_ms_net_fallback(config_client, url, attempt)
        .map_err(|_| "无法访问魔塔社区（直连 / 配置网络 / 本地代理均失败）".to_string())
}

/// 判断下载 URL 是否属于 HuggingFace（官方站或 hf-mirror 镜像），决定是否附加 Token。
fn is_hf_url(url: &str) -> bool {
    url.starts_with(HF_DL_BASE) || url.contains("hf-mirror.com")
}

/// 验证 Hugging Face Token（/whoami-v2），成功返回绑定的用户名。
#[tauri::command]
pub(crate) async fn hf_whoami(app: AppHandle, token: String) -> Result<String, String> {
    let config = read_config(&app)?;
    let network = config.network.clone().unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || verify_hf_token(build_net_client(&network)?, token))
        .await
        .map_err(|error| format!("验证任务中断：{}", error))?
}

/// 多通道自动兜底验证 HF Token（配置代理 → 直连 → 本地探测代理 → hf-mirror 镜像），与 fetch_hf_json 的通道顺序一致。
fn verify_hf_token(config_client: reqwest::blocking::Client, token: String) -> Result<String, String> {
    let url = format!("{}/whoami-v2", HF_API_BASE);
    // 任一通道到达服务端（含 4xx 授权类）即视为通道成功并返回确定性结果；仅连接失败才降级到下一通道
    let outcome = with_net_fallback::<Result<String, String>>(&config_client, &url, true, |client, url| {
        hf_token_once(client, url, &token).ok_or_else(|| "连接失败".to_string())
    });
    match outcome {
        Ok(result) => result,
        Err(errors) => Err(format!(
            "无法连接 HuggingFace（{}）。请在「设置 → 网络与代理」选择手动代理后重试",
            errors.join("；")
        )),
    }
}

/// 在指定通道发送一次 whoami-v2 验证请求：到达响应（含 4xx 授权类）返回 Some(最终结果)，连接失败返回 None。
fn hf_token_once(client: &reqwest::blocking::Client, url: &str, token: &str) -> Option<Result<String, String>> {
    let response = client
        .get(url)
        .header("user-agent", HF_UA)
        .bearer_auth(token.trim())
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .ok()?;
    if !response.status().is_success() {
        return Some(Err(format!("Token 无效或已过期（HTTP {}）", response.status().as_u16())));
    }
    let json: serde_json::Value = match response.json() {
        Ok(value) => value,
        Err(error) => return Some(Err(format!("解析响应失败：{}", error))),
    };
    let name = json.get("name").and_then(|value| value.as_str()).unwrap_or("").to_string();
    if name.is_empty() {
        return Some(Err("未能在响应中解析出用户名".into()));
    }
    Some(Ok(name))
}

/* ==================== HF 作者头像（社区探索模型 logo） ==================== */

/// 作者头像会话级内存缓存：author -> data URI；None 表示已尝试但不可用（本会话不再重试）。
fn avatar_cache() -> &'static Mutex<HashMap<String, Option<String>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 标准 base64（RFC 4648，含填充）：仅用于头像 data URI，避免为此引入新依赖。
fn base64_encode(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let triple = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let bits = ((triple[0] as u32) << 16) | ((triple[1] as u32) << 8) | triple[2] as u32;
        out.push(TABLE[(bits >> 18) as usize & 63] as char);
        out.push(TABLE[(bits >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(bits >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[bits as usize & 63] as char } else { '=' });
    }
    out
}

/// 单通道解析作者头像的 CDN 地址：先按组织查询，404 再按用户查询。
/// mirror=true 时把 huggingface.co 替换为 hf-mirror.com（cdn-avatars 子域同样有镜像）。
fn hf_resolve_avatar_url(client: &reqwest::blocking::Client, author: &str, mirror: bool) -> Result<String, String> {
    for kind in ["organizations", "users"] {
        let url = format!("{}/{}/{}/avatar", HF_API_BASE, kind, author);
        let target = if mirror { hf_mirror_url(&url).unwrap_or(url) } else { url };
        if let Ok(response) = hf_send(client, &target) {
            if !response.status().is_success() {
                continue; // 404：该作者不属于此类身份，换下一种再试
            }
            if let Ok(value) = response.json::<serde_json::Value>() {
                if let Some(avatar) = value.get("avatarUrl").and_then(|v| v.as_str()) {
                    if !avatar.is_empty() {
                        return Ok(avatar.to_string());
                    }
                }
            }
        }
    }
    Err("该作者没有公开头像".into())
}

/// 经通道下载头像图片，返回 (MIME, 字节)；非图片响应或超过 2MB 视为失败。
fn hf_fetch_avatar_image(client: &reqwest::blocking::Client, url: &str, mirror: bool) -> Result<(String, Vec<u8>), String> {
    let target = if mirror { hf_mirror_url(url).unwrap_or_else(|| url.to_string()) } else { url.to_string() };
    let response = hf_send(client, &target).map_err(|error| error.to_string())?;
    let status = response.status();
    let mime = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    if !status.is_success() {
        return Err(format!("HTTP {}", status.as_u16()));
    }
    if !mime.starts_with("image/") {
        return Err(format!("响应不是图片（{}）", if mime.is_empty() { "未知类型" } else { &mime }));
    }
    let bytes = response.bytes().map_err(|error| error.to_string())?;
    if bytes.len() > 2 * 1024 * 1024 {
        return Err("头像文件超过 2MB".into());
    }
    Ok((mime, bytes.to_vec()))
}

/// 获取 HuggingFace 作者（组织 / 用户）头像并转为 data URI 返回，前端 <img> 直接渲染。
/// 复用模型列表的四通道兜底（配置代理 → 直连 → 本地代理 → hf-mirror 镜像）；
/// 按作者缓存，拉不到时返回 Ok(None)，前端回退到 "HF" 文字徽章。
#[tauri::command]
pub(crate) async fn hf_avatar(app: AppHandle, author: String) -> Result<Option<String>, String> {
    let author = author.trim().trim_start_matches('@').to_string();
    if author.is_empty() || author.len() > 120 || !author.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')) {
        return Ok(None);
    }
    if let Some(cached) = avatar_cache().lock().map_err(|_| "头像缓存不可用")?.get(&author) {
        return Ok(cached.clone());
    }
    let config = read_config(&app)?;
    let network = config.network.clone().unwrap_or_default();
    let cache_key = author.clone();
    let fetched = tauri::async_runtime::spawn_blocking(move || {
        let author = cache_key.as_str();
        let mut channels: Vec<(reqwest::blocking::Client, bool)> = Vec::new();
        if let Ok(client) = build_net_client(&network) {
            channels.push((client, false));
        }
        channels.push((direct_client().clone(), false));
        if let Some(proxy_url) = probe_local_proxy() {
            if let Ok(proxied) = proxied_client(&proxy_url) {
                channels.push((proxied, false));
            }
        }
        channels.push((direct_client().clone(), true)); // 镜像通道
        let mut errors: Vec<String> = Vec::new();
        for (client, mirror) in &channels {
            match hf_resolve_avatar_url(client, author, *mirror) {
                Ok(cdn_url) => match hf_fetch_avatar_image(client, &cdn_url, *mirror) {
                    Ok((mime, bytes)) => return Ok(Some(format!("data:{};base64,{}", mime, base64_encode(&bytes)))),
                    Err(error) => errors.push(error),
                },
                Err(error) => errors.push(error),
            }
        }
        Err(format!("头像获取失败：{}", errors.join("；")))
    })
    .await
    .map_err(|error| format!("获取头像任务中断：{}", error))?;
    let data_uri = fetched.ok().flatten();
    avatar_cache().lock().map_err(|_| "头像缓存不可用")?.insert(author, data_uri.clone());
    Ok(data_uri)
}

/// 魔搭（ModelScope）作者头像会话级内存缓存：author -> data URI；None 表示已尝试但不可用。
fn ms_avatar_cache() -> &'static Mutex<HashMap<String, Option<String>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 从魔搭组织主页 HTML 提取头像 CDN URL
fn extract_ms_avatar_url_from_html(html: &str) -> Option<String> {
    for prefix in ["https://resources.modelscope.cn/avatar/", "https://resouces.modelscope.cn/avatar/"] {
        let mut search_from = 0;
        while let Some(rel_start) = html[search_from..].find(prefix) {
            let start = search_from + rel_start;
            let rest = &html[start..];
            let end = rest.find(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == '<' || c == '>' || c == '\\').unwrap_or(rest.len());
            let candidate = &rest[..end];
            let lower = candidate.to_lowercase();
            if (lower.ends_with(".jpg") || lower.ends_with(".jpeg") || lower.ends_with(".png") || lower.ends_with(".webp"))
                && !lower.contains("default-avatar")
            {
                return Some(candidate.to_string());
            }
            search_from = start + prefix.len();
        }
    }
    None
}

/// 解析魔搭作者（组织 / 用户）头像的公开 CDN 地址：
/// 1. 优先尝试组织主页（GET https://modelscope.cn/organization/{author}）；
/// 2. 备选尝试用户个人 API（GET https://modelscope.cn/api/v1/users/{author}）。
fn ms_resolve_avatar_url(client: &reqwest::blocking::Client, author: &str) -> Result<String, String> {
    // 1. 组织主页
    let org_url = format!("https://modelscope.cn/organization/{}", author);
    if let Ok(resp) = client.get(&org_url).header(reqwest::header::USER_AGENT, HF_UA).send() {
        if resp.status().is_success() {
            if let Ok(html) = resp.text() {
                if let Some(avatar_url) = extract_ms_avatar_url_from_html(&html) {
                    return Ok(avatar_url);
                }
            }
        }
    }

    // 2. 用户 API
    let user_url = format!("https://modelscope.cn/api/v1/users/{}", author);
    if let Ok(resp) = client.get(&user_url).header(reqwest::header::USER_AGENT, HF_UA).send() {
        if resp.status().is_success() {
            if let Ok(val) = resp.json::<serde_json::Value>() {
                if let Some(av) = val.get("Data").and_then(|d| d.get("Avatar")).and_then(|v| v.as_str()) {
                    if !av.is_empty() && !av.contains("default-avatar") {
                        return Ok(av.to_string());
                    }
                }
            }
        }
    }

    Err("该作者没有公开魔搭头像".into())
}

/// 经网络下载魔搭头像图片，返回 (MIME, 字节)；非图片响应或超过 2MB 视为失败。
fn ms_fetch_avatar_image(client: &reqwest::blocking::Client, url: &str) -> Result<(String, Vec<u8>), String> {
    let response = client.get(url).header(reqwest::header::USER_AGENT, HF_UA).send().map_err(|e| e.to_string())?;
    let status = response.status();
    let mime = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    if !status.is_success() {
        return Err(format!("HTTP {}", status.as_u16()));
    }
    if !mime.starts_with("image/") {
        return Err(format!("响应不是图片（{}）", if mime.is_empty() { "未知类型" } else { &mime }));
    }
    let bytes = response.bytes().map_err(|e| e.to_string())?;
    if bytes.len() > 2 * 1024 * 1024 {
        return Err("头像文件超过 2MB".into());
    }
    Ok((mime, bytes.to_vec()))
}

/// 获取魔搭（ModelScope）作者（组织 / 用户）头像并转为 data URI 返回，前端 <img> 直接渲染。
/// 国内直连优先 + 本地代理兜底；按作者缓存，拉不到时返回 Ok(None)，前端回退到 ModelScope 官方 Logo。
#[tauri::command]
pub(crate) async fn ms_avatar(app: AppHandle, author: String) -> Result<Option<String>, String> {
    let author = author.trim().trim_start_matches('@').to_string();
    if author.is_empty() || author.len() > 120 || !author.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')) {
        return Ok(None);
    }
    if let Some(cached) = ms_avatar_cache().lock().map_err(|_| "头像缓存不可用")?.get(&author) {
        return Ok(cached.clone());
    }
    let config = read_config(&app)?;
    let network = config.network.clone().unwrap_or_default();
    let cache_key = author.clone();
    let fetched = tauri::async_runtime::spawn_blocking(move || {
        let author = cache_key.as_str();
        let mut channels: Vec<reqwest::blocking::Client> = Vec::new();
        // 直连（国内最快）
        channels.push(direct_client().clone());
        // 配置网络通道
        if let Ok(client) = build_net_client(&network) {
            channels.push(client);
        }
        // 本地探测代理
        if let Some(proxy_url) = probe_local_proxy() {
            if let Ok(proxied) = proxied_client(&proxy_url) {
                channels.push(proxied);
            }
        }
        let mut errors: Vec<String> = Vec::new();
        for client in &channels {
            match ms_resolve_avatar_url(client, author) {
                Ok(cdn_url) => match ms_fetch_avatar_image(client, &cdn_url) {
                    Ok((mime, bytes)) => return Ok(Some(format!("data:{};base64,{}", mime, base64_encode(&bytes)))),
                    Err(error) => errors.push(error),
                },
                Err(error) => errors.push(error),
            }
        }
        Err(format!("魔搭头像获取失败：{}", errors.join("；")))
    })
    .await
    .map_err(|error| format!("获取魔搭头像任务中断：{}", error))?;
    let data_uri = fetched.ok().flatten();
    ms_avatar_cache().lock().map_err(|_| "头像缓存不可用")?.insert(author, data_uri.clone());
    Ok(data_uri)
}

/// HF / 直链下载共用的传输核心：带鉴权发起请求 → 状态检查（gated 错误协议）→
/// （可选）Range 断点续传 → 流式落盘（200ms 节流进度 + 速度平滑 + 每任务独立的取消/暂停处理）。
/// allow_resume：HF 仓库下载启用「文件已存在直接返回」与 Range 续传；直链下载行为保持原样（false）。
#[allow(clippy::too_many_arguments)]
fn hf_transfer_loop(
    app: &AppHandle,
    registry: &DownloadRegistry,
    task: &Arc<DownloadTaskControl>,
    task_id: &str,
    repo_label: &str,
    file_label: &str,
    net_client: &reqwest::blocking::Client,
    url: &str,
    hf_token: &str,
    dest: &Path,
    allow_resume: bool,
) -> Result<u64, String> {
    use std::io::{Read as _, Write as _};
    let mut request = net_client.get(url).timeout(std::time::Duration::from_secs(3600));
    if !hf_token.is_empty() && is_hf_url(url) {
        request = request.bearer_auth(hf_token);
    }
    let mut response = request.send().map_err(|error| format!("下载失败：{}", error))?;
    if !response.status().is_success() {
        let code = response.status().as_u16();
        if code == 401 || code == 403 {
            if hf_token.trim().is_empty() {
                return Err("HF_GATED_NEED_TOKEN::该模型需要授权（gated），请在设置中配置 Hugging Face Token".into());
            }
            return Err("HF_GATED_NO_PERMISSION::该模型无访问权限，请前往网页端同意模型许可协议后重试".into());
        }
        if code == 404 {
            return Err("文件不存在或仓库未公开（HTTP 404）".into());
        }
        return Err(format!("下载失败：HTTP {}", code));
    }
    let mut full_total: u64 = response.content_length().unwrap_or(0);
    // 已完整下载过：直接返回，不重复走网络（仅断点续传路径启用）
    if allow_resume && dest.exists() && full_total > 0 {
        let existing_len = fs::metadata(dest).map(|meta| meta.len()).unwrap_or(0);
        if existing_len >= full_total {
            emit_model_progress(app, task_id, repo_label, file_label, "done", 100, existing_len, full_total, 0, "文件已存在");
            return Ok(existing_len);
        }
    }

    // 断点续传：目标已存在则携带 Range 续传；服务器忽略 Range（返回 200）时从头覆盖
    let mut downloaded: u64 = 0;
    if allow_resume && dest.exists() {
        downloaded = fs::metadata(dest).map(|meta| meta.len()).unwrap_or(0);
    }
    let mut file_handle: fs::File;
    if downloaded > 0 {
        let range = format!("bytes={}-", downloaded);
        let mut ranged_request = net_client.get(url).header("range", &range).timeout(std::time::Duration::from_secs(3600));
        if !hf_token.is_empty() && is_hf_url(url) {
            ranged_request = ranged_request.bearer_auth(hf_token);
        }
        let ranged = ranged_request.send().map_err(|error| format!("下载失败：{}", error))?;
        if ranged.status().as_u16() == 206 {
            response = ranged;
            file_handle = fs::OpenOptions::new().append(true).create(true).open(dest).map_err(|error| format!("打开下载文件失败：{}", error))?;
        } else if ranged.status().is_success() {
            response = ranged;
            downloaded = 0;
            if let Some(total) = response.content_length() {
                full_total = total;
            }
            file_handle = fs::File::create(dest).map_err(|error| format!("创建下载文件失败：{}", error))?;
        } else {
            return Err(format!("下载失败：HTTP {}", ranged.status()));
        }
    } else {
        file_handle = fs::File::create(dest).map_err(|error| format!("创建下载文件失败：{}", error))?;
    }

    let mut buffer = [0u8; 128 * 1024];
    let start_ms = now_ms();
    let mut last_emit_ms = start_ms;
    let mut last_speed_ms = start_ms;
    let mut last_speed_bytes = downloaded;
    let mut current_speed: u64 = 0;
    loop {
        // 孤儿循环自检：自己已不是该 taskId 注册的控制器（被新一轮下载接管或已摘除）→ 立即退出，
        // 否则暂停 / 取消标志永远送不到这个循环，它会带着过期进度一直下载
        if !registry.is_current(task_id, task) {
            drop(file_handle);
            return Err("下载任务已被接管".into());
        }
        if task.cancel.load(Ordering::Relaxed) {
            drop(file_handle);
            let _ = fs::remove_file(dest);
            let _ = fs::remove_file(dest.with_extension("part"));
            emit_model_progress(app, task_id, repo_label, file_label, "cancelled", 0, 0, 0, 0, "下载已取消");
            return Err("下载已取消".into());
        }
        if task.pause.load(Ordering::Relaxed) {
            // 暂停：保留 .part 断点文件（前端「继续」时按 Range 续传），清掉暂停标志
            task.pause.store(false, Ordering::Relaxed);
            file_handle.flush().ok();
            drop(file_handle);
            let part = dest.with_extension("part");
            let _ = fs::remove_file(&part);
            let _ = fs::rename(dest, &part);
            emit_model_progress(app, task_id, repo_label, file_label, "paused", 0, downloaded, full_total, 0, "已暂停，剩余部分保留在 .part 断点文件");
            return Err("下载已暂停".into());
        }
        let count = response.read(&mut buffer).map_err(|error| format!("下载中断：{}", error))?;
        if count == 0 {
            break;
        }
        file_handle.write_all(&buffer[..count]).map_err(|error| format!("写入下载文件失败：{}", error))?;
        downloaded += count as u64;
        let now = now_ms();
        let speed_dt = now.saturating_sub(last_speed_ms);
        if speed_dt >= 500 {
            let bytes_delta = downloaded.saturating_sub(last_speed_bytes);
            let instant = bytes_delta * 1000 / speed_dt;
            current_speed = if current_speed == 0 { instant } else { (current_speed * 3 + instant * 7) / 10 };
            last_speed_ms = now;
            last_speed_bytes = downloaded;
        }
        if now.saturating_sub(last_emit_ms) >= 200 {
            let percent = if full_total > 0 { ((downloaded as f64 / full_total as f64) * 100.0) as u32 } else { 0 };
            emit_model_progress(app, task_id, repo_label, file_label, "download", percent, downloaded, full_total, current_speed, format!("{downloaded}/{full_total}"));
            last_emit_ms = now;
        }
    }
    file_handle.flush().map_err(|error| error.to_string())?;
    emit_model_progress(app, task_id, repo_label, file_label, "done", 100, downloaded, full_total, 0, "下载完成");
    Ok(downloaded)
}

/// 下载 HuggingFace 仓库中的指定文件到模型存储目录（流式 + 进度事件 + 断点续传）。
/// task_id：前端为每次下载生成的唯一标识；取消 / 暂停只作用于该任务自己的控制器。
#[tauri::command]
pub(crate) async fn hf_download(app: AppHandle, state: State<'_, DownloadRegistry>, repo: String, file: String, task_id: String) -> Result<HfDownloadResult, DownloadCommandError> {
    let config = read_config(&app)?;
    let network = config.network.clone().unwrap_or_default();
    let hf_token = config.hf_token.clone().unwrap_or_default();
    let root = models_root(&app, &config)?;
    let registry = state.inner().clone();
    let task = registry.register(&task_id);
    let loop_registry = registry.clone();
    let cleanup_task = task.clone();
    let closure_task_id = task_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let client = build_net_client(&network)?;
        let dest = model_download_dest(&root, &repo, &file)?;
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("创建下载目录失败：{}", error))?;
        }
        // 恢复上次暂停留下的 .part 断点文件（暂停时 dest 被改名 dest.part，先改回以便断点续传）
        let part_path = dest.with_extension("part");
        if !dest.exists() && part_path.exists() {
            let _ = fs::rename(&part_path, &dest);
        }
        let url = format!("{}/{}/resolve/main/{}", HF_DL_BASE, hf_repo_id(&repo), file);
        emit_model_progress(&app, &closure_task_id, &repo, &file, "download", 0, 0, 0, 0, "开始下载");
        // 多通道兜底：配置代理 → 直连 → 本机代理端口 → hf-mirror 镜像（浏览器常走 TUN / 软路由透明代理）
        let (net_client, effective_url) = download_hf_with_fallback(&client, &url)?;
        let size_bytes = hf_transfer_loop(&app, &loop_registry, &task, &closure_task_id, &repo, &file, &net_client, &effective_url, &hf_token, &dest, true)?;
        Ok(HfDownloadResult {
            path: dest.to_string_lossy().to_string(),
            size_bytes,
        })
    })
    .await;
    // 无论成功失败都摘除控制器（若已被新一轮下载接管则保留新循环的控制器）
    registry.unregister_if_current(&task_id, &cleanup_task);
    match result {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(message)) => Err(DownloadCommandError::from_message(message)),
        Err(error) => Err(DownloadCommandError::from_message(format!("下载任务中断：{}", error))),
    }
}

/// 下载魔塔社区仓库中的指定文件到模型存储目录（流式 + 进度事件 + 断点续传）。
/// task_id：前端为每次下载生成的唯一标识；取消 / 暂停只作用于该任务自己的控制器。
#[tauri::command]
pub(crate) async fn ms_download(app: AppHandle, state: State<'_, DownloadRegistry>, repo: String, file: String, task_id: String) -> Result<HfDownloadResult, DownloadCommandError> {
    let config = read_config(&app)?;
    let network = config.network.clone().unwrap_or_default();
    let root = models_root(&app, &config)?;
    let registry = state.inner().clone();
    let task = registry.register(&task_id);
    let loop_registry = registry.clone();
    let cleanup_task = task.clone();
    let closure_task_id = task_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let client = build_net_client(&network)?;
        let dest = model_download_dest(&root, &repo, &file)?;
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("创建下载目录失败：{}", error))?;
        }
        // 恢复上次暂停留下的 .part 断点文件
        let part_path = dest.with_extension("part");
        if !dest.exists() && part_path.exists() {
            let _ = fs::rename(&part_path, &dest);
        }
        let url = format!("{}/api/v1/models/{}/repo?Revision=master&FilePath={}", MS_DL_BASE, hf_repo_id(&repo), file);
        emit_model_progress(&app, &closure_task_id, &repo, &file, "download", 0, 0, 0, 0, "开始下载");
        // 多通道兜底：直连 → 配置网络 → 本地代理
        let (net_client, effective_url) = download_ms_with_fallback(&client, &url)?;
        let size_bytes = hf_transfer_loop(&app, &loop_registry, &task, &closure_task_id, &repo, &file, &net_client, &effective_url, "", &dest, true)?;
        Ok(HfDownloadResult {
            path: dest.to_string_lossy().to_string(),
            size_bytes,
        })
    })
    .await;
    registry.unregister_if_current(&task_id, &cleanup_task);
    match result {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(message)) => Err(DownloadCommandError::from_message(message)),
        Err(error) => Err(DownloadCommandError::from_message(format!("下载任务中断：{}", error))),
    }
}


/// 从任意直链 URL 下载文件到模型存储目录（流式 + 进度事件）。
/// task_id：前端生成的唯一任务标识，取消 / 暂停只作用于该任务。
#[tauri::command]
pub(crate) async fn hf_download_url(app: AppHandle, state: State<'_, DownloadRegistry>, url: String, task_id: String) -> Result<HfDownloadResult, DownloadCommandError> {
    let config = read_config(&app)?;
    let network = config.network.clone().unwrap_or_default();
    let hf_token = config.hf_token.clone().unwrap_or_default();
    let root = models_root(&app, &config)?;
    let registry = state.inner().clone();
    let task = registry.register(&task_id);
    let loop_registry = registry.clone();
    let cleanup_task = task.clone();
    let closure_task_id = task_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let client = build_net_client(&network)?;
        let raw_name = url.rsplit('/').next().filter(|name| !name.trim().is_empty()).unwrap_or("model.gguf").trim().to_string();
        let file_name: String = raw_name
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '_' })
            .collect();
        let file_name = if file_name.to_lowercase().ends_with(".gguf") { file_name } else { format!("{}.gguf", file_name) };
        let dest = root.join(&file_name);
        // 恢复上次暂停留下的 .part 断点文件
        let part_path = dest.with_extension("part");
        if !dest.exists() && part_path.exists() {
            let _ = fs::rename(&part_path, &dest);
        }
        let repo_id = "direct-url";
        emit_model_progress(&app, &closure_task_id, repo_id, &file_name, "download", 0, 0, 0, 0, "开始下载");
        // 多通道兜底：配置代理 → 直连 → 本机代理端口 → hf-mirror 镜像
        let (net_client, effective_url) = download_hf_with_fallback(&client, &url)?;
        let size_bytes = hf_transfer_loop(&app, &loop_registry, &task, &closure_task_id, repo_id, &file_name, &net_client, &effective_url, &hf_token, &dest, false)?;
        Ok(HfDownloadResult {
            path: dest.to_string_lossy().to_string(),
            size_bytes,
        })
    })
    .await;
    registry.unregister_if_current(&task_id, &cleanup_task);
    match result {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(message)) => Err(DownloadCommandError::from_message(message)),
        Err(error) => Err(DownloadCommandError::from_message(format!("下载任务中断：{}", error))),
    }
}

/// 查询模型存储目录的可用空间（Windows 走 GetDiskFreeSpaceExW；其他平台返回 0）。
fn free_disk_space(path: &Path) -> (u64, u64) {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        unsafe {
            let mut free_avail: u64 = 0;
            let mut total: u64 = 0;
            let rc = GetDiskFreeSpaceExW(wide.as_ptr(), &mut free_avail, &mut total, std::ptr::null_mut());
            if rc == 0 { (0, 0) } else { (total, free_avail) }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        (0, 0)
    }
}

/// 读取当前模型存储目录与剩余空间（缺省目录首次访问自动创建）。
#[tauri::command]
pub(crate) fn get_models_dir(app: AppHandle) -> Result<DiskUsage, String> {
    let config = read_config(&app)?;
    let root = models_root(&app, &config)?;
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let (total, free) = free_disk_space(&root);
    Ok(DiskUsage {
        path: root.to_string_lossy().to_string(),
        total_bytes: total,
        free_bytes: free,
    })
}

/// 选择模型存储目录：校验可写（写入探针文件），不直接持久化（由前端保存配置）。
#[tauri::command]
pub(crate) fn pick_models_dir(app: AppHandle) -> Result<String, String> {
    let Some(file_path) = app.dialog().file().blocking_pick_folder() else {
        return Ok(String::new());
    };
    let Some(folder) = file_path.as_path() else {
        return Ok(String::new());
    };
    let probe = folder.join(".cookllm_write_test");
    let writable = fs::write(&probe, b"ok").is_ok();
    if !writable {
        return Err("所选目录不可写，请更换目录".into());
    }
    let _ = fs::remove_file(&probe);
    Ok(folder.to_string_lossy().to_string())
}

/// 模型存储根目录：优先用户配置的自定义目录，其次应用数据目录下的 models（首次访问自动创建）。
fn models_root(app: &AppHandle, config: &AppConfig) -> Result<PathBuf, String> {
    if let Some(dir) = config.models_dir.as_deref().filter(|path| !path.trim().is_empty()) {
        return Ok(PathBuf::from(dir.trim()));
    }
    let directory = app.path().app_data_dir().map_err(|error| error.to_string())?;
    let path = directory.join("models");
    fs::create_dir_all(&path).map_err(|error| format!("创建模型目录失败：{}", error))?;
    Ok(path)
}
