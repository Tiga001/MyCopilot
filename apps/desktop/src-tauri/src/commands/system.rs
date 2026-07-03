use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::process::Command;
use url::Url;

#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    let normalized_url = normalize_external_url(&url)?;
    open_with_default_browser(&normalized_url)
}

fn normalize_external_url(input: &str) -> Result<String, String> {
    let input = input.trim();
    if input.is_empty() {
        return Err("URL 不能为空。".to_string());
    }

    let parsed = Url::parse(input).map_err(|error| format!("URL 无效：{error}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("只允许打开 http:// 或 https:// 链接。".to_string());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("URL 不能包含用户名或密码。".to_string());
    }

    let host = parsed
        .host_str()
        .ok_or_else(|| "URL 缺少 host。".to_string())?
        .trim()
        .to_ascii_lowercase();
    if host == "localhost" || host.ends_with(".localhost") {
        return Err("不允许打开 localhost 链接。".to_string());
    }
    if host == "metadata.google.internal" {
        return Err("不允许打开云元数据地址。".to_string());
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        if is_blocked_ip(ip) {
            return Err("不允许打开本地、私有、链路本地或组播 IP 链接。".to_string());
        }
    }

    Ok(parsed.to_string())
}

fn is_blocked_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_blocked_ipv4(ip),
        IpAddr::V6(ip) => is_blocked_ipv6(ip),
    }
}

fn is_blocked_ipv4(ip: Ipv4Addr) -> bool {
    ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_multicast()
        || ip.is_unspecified()
        || ip.octets()[0] == 0
        || ip.octets()[0] == 127
        || ip.octets()[0] == 169 && ip.octets()[1] == 254
        || ip.octets()[0] == 100 && (64..=127).contains(&ip.octets()[1])
}

fn is_blocked_ipv6(ip: Ipv6Addr) -> bool {
    ip.is_loopback()
        || ip.is_multicast()
        || ip.is_unspecified()
        || is_unique_local_ipv6(ip)
        || is_unicast_link_local_ipv6(ip)
}

fn is_unique_local_ipv6(ip: Ipv6Addr) -> bool {
    (ip.segments()[0] & 0xfe00) == 0xfc00
}

fn is_unicast_link_local_ipv6(ip: Ipv6Addr) -> bool {
    (ip.segments()[0] & 0xffc0) == 0xfe80
}

fn open_with_default_browser(url: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(url)
            .spawn()
            .map_err(|error| format!("无法打开链接：{error}"))?;
    }

    #[cfg(target_os = "windows")]
    {
        Command::new("rundll32")
            .arg("url.dll,FileProtocolHandler")
            .arg(url)
            .spawn()
            .map_err(|error| format!("无法打开链接：{error}"))?;
    }

    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(url)
            .spawn()
            .map_err(|error| format!("无法打开链接：{error}"))?;
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = url;
        return Err("当前平台暂不支持打开外部链接。".to_string());
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::normalize_external_url;

    #[test]
    fn allows_public_http_urls() {
        let url = normalize_external_url("https://example.com/path").unwrap();
        assert_eq!(url, "https://example.com/path");
    }

    #[test]
    fn rejects_local_urls() {
        assert!(normalize_external_url("http://localhost:3000").is_err());
        assert!(normalize_external_url("http://127.0.0.1").is_err());
        assert!(normalize_external_url("http://10.0.0.2").is_err());
    }
}
