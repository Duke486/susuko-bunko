//! 百度网盘设备直连：只按服务器给的短时效 CDN 地址读取一段字节。
//!
//! 安全约束：
//! - 只访问百度的下载域名（含跳转后的每一跳），不能被当成通用代理；
//! - 地址里出现 access_token 就拒绝（长期令牌只留在服务器）；
//! - 不打印、不保存任何地址；出错信息里也去掉地址，只留状态码。

use std::time::Duration;

use reqwest::header::{CONTENT_RANGE, RANGE, USER_AGENT};
use reqwest::{redirect, StatusCode, Url};

const BAIDU_UA: &str = "pan.baidu.com";
const MAX_CHUNK: u64 = 16 * 1024 * 1024; // 一次最多取 16MB，网页那边按 512KB 一块来要

fn host_allowed(url: &Url) -> bool {
    if url.scheme() != "https" && url.scheme() != "http" {
        return false;
    }
    let host = match url.host_str() {
        Some(h) => h.to_ascii_lowercase(),
        None => return false,
    };
    ["baidu.com", "baidupcs.com", "bcebos.com", "bdstatic.com"]
        .iter()
        .any(|d| host == *d || host.ends_with(&format!(".{d}")))
}

fn carries_token(url: &Url) -> bool {
    url.query_pairs().any(|(k, _)| k.eq_ignore_ascii_case("access_token"))
}

pub struct Http(reqwest::Client);

impl Http {
    pub fn new() -> Self {
        let policy = redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 {
                attempt.error("too many redirects")
            } else if host_allowed(attempt.url()) && !carries_token(attempt.url()) {
                attempt.follow()
            } else {
                attempt.stop()
            }
        });
        let client = reqwest::Client::builder()
            .redirect(policy)
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(60))
            .build()
            .expect("http client");
        Http(client)
    }
}

/// 读取 [start, end]（都含）这一段。返回原始字节；网页那边拿到的是 ArrayBuffer。
/// 错误只是一个短代码 + 状态码，例如 "status:403"、"range"、"host"、"net"。
#[tauri::command]
pub async fn cloud_range(
    http: tauri::State<'_, Http>,
    url: String,
    start: u64,
    end: u64,
) -> Result<tauri::ipc::Response, String> {
    let parsed = Url::parse(&url).map_err(|_| "url".to_string())?;
    if !host_allowed(&parsed) || carries_token(&parsed) {
        return Err("host".into());
    }
    if end < start || end - start + 1 > MAX_CHUNK {
        return Err("size".into());
    }
    let res = http
        .0
        .get(parsed)
        .header(USER_AGENT, BAIDU_UA)
        .header(RANGE, format!("bytes={start}-{end}"))
        .send()
        .await
        .map_err(|e| if e.is_timeout() { "timeout".to_string() } else { "net".to_string() })?;

    let status = res.status();
    if status.is_redirection() {
        // 跳去了不认识的地方：不跟，交给服务器转发
        return Err("host".into());
    }
    if status != StatusCode::PARTIAL_CONTENT {
        // 200 说明对方忽略了 Range，数据对不上号，宁可回退也不要错位
        return Err(format!("status:{}", status.as_u16()));
    }
    // 核对返回的确实是要的那一段，防止随机跳页时拼错
    let ok_range = res
        .headers()
        .get(CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("bytes "))
        .and_then(|v| v.split('/').next())
        .and_then(|v| v.split_once('-'))
        .map(|(a, _)| a.trim().parse::<u64>().ok() == Some(start))
        .unwrap_or(false);
    if !ok_range {
        return Err("range".into());
    }
    let bytes = res.bytes().await.map_err(|_| "net".to_string())?;
    let want = end - start + 1;
    if bytes.len() as u64 > want || bytes.is_empty() {
        return Err("range".into());
    }
    Ok(tauri::ipc::Response::new(bytes.to_vec()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hosts() {
        let ok = |s: &str| host_allowed(&Url::parse(s).unwrap());
        assert!(ok("https://d.pcs.baidu.com/file/x"));
        assert!(ok("https://allall01.baidupcs.com/file/x?sign=1"));
        assert!(!ok("https://evil.com/?h=baidu.com"));
        assert!(!ok("https://baidu.com.evil.com/x"));
        assert!(!ok("file:///etc/passwd"));
        assert!(carries_token(&Url::parse("https://d.pcs.baidu.com/f?a=1&access_token=x").unwrap()));
    }
}
