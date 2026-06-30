use std::env;
use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

const DEFAULT_RPC_URL: &str = "http://127.0.0.1:23119/better-bibtex/json-rpc";
const DEFAULT_LOCAL_API_BASE: &str = "http://127.0.0.1:23119";

#[tauri::command]
pub async fn zotero_start(executable_path: Option<String>) -> Result<String, String> {
    let path = find_zotero_executable(executable_path).ok_or_else(|| {
        "Zotero executable was not found. Install Zotero, add it to PATH, or set ZOTERO_EXECUTABLE."
            .to_string()
    })?;

    Command::new(&path)
        .spawn()
        .map_err(|e| format!("Failed to start Zotero at '{}': {e}", path.display()))?;

    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn zotero_bbt_rpc(
    method: String,
    params: Vec<serde_json::Value>,
    rpc_url: Option<String>,
) -> Result<serde_json::Value, String> {
    let url = rpc_url
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_RPC_URL.to_string());

    call_zotero_bbt_rpc(&method, params, &url).await
}

#[tauri::command]
pub async fn zotero_local_api_get(path: String) -> Result<serde_json::Value, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Zotero local API path must not be empty".to_string());
    }

    let url = if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else {
        let suffix = if trimmed.starts_with('/') {
            trimmed.to_string()
        } else {
            format!("/{trimmed}")
        };
        format!("{DEFAULT_LOCAL_API_BASE}{suffix}")
    };

    let client = reqwest::Client::builder()
        .http1_only()
        .no_proxy()
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .get(&url)
        .header("Accept", "application/json")
        .header("Connection", "close")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;

    if !status.is_success() {
        return Err(format!(
            "Zotero local API GET {url} returned HTTP {}: {text}",
            status.as_u16()
        ));
    }

    serde_json::from_str(&text).map_err(|e| format!("Invalid JSON from Zotero local API: {e}"))
}

async fn call_zotero_bbt_rpc(
    method: &str,
    params: Vec<serde_json::Value>,
    url: &str,
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .http1_only()
        .no_proxy()
        .build()
        .map_err(|e| e.to_string())?;

    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "method": method,
        "params": params,
        "id": timestamp_millis(),
    });
    let body_str = serde_json::to_string(&body).map_err(|e| e.to_string())?;

    let response = client
        .post(url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .header("Connection", "close")
        .body(body_str)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;

    if !status.is_success() {
        return Err(format!(
            "Zotero Better BibTeX RPC method {method} returned HTTP {}: {text}",
            status.as_u16()
        ));
    }

    let json: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("Invalid JSON from Zotero Better BibTeX: {e}"))?;

    if let Some(error) = json.get("error") {
        let message = error
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("Unknown Better BibTeX RPC error");
        return Err(message.to_string());
    }

    Ok(json.get("result").cloned().unwrap_or(serde_json::Value::Null))
}

fn timestamp_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[ignore = "requires Zotero with Better BibTeX running on the local machine"]
    async fn zotero_bbt_rpc_production_path_succeeds() {
        let result = call_zotero_bbt_rpc("api.ready", vec![], DEFAULT_RPC_URL).await;
        assert!(result.is_ok(), "{result:?}");
        let value = result.expect("result");
        assert!(value.get("betterbibtex").is_some(), "unexpected: {value}");
    }

}

fn find_zotero_executable(explicit_path: Option<String>) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Some(path) = explicit_path.filter(|value| !value.trim().is_empty()) {
        candidates.push(PathBuf::from(path));
    }
    if let Ok(path) = env::var("ZOTERO_EXECUTABLE") {
        if !path.trim().is_empty() {
            candidates.push(PathBuf::from(path));
        }
    }

    candidates.extend(default_zotero_candidates());
    candidates.extend(path_candidates(if cfg!(target_os = "windows") {
        "zotero.exe"
    } else {
        "zotero"
    }));

    candidates.into_iter().find(|path| path.is_file())
}

fn path_candidates(binary_name: &str) -> Vec<PathBuf> {
    env::var_os("PATH")
        .map(|paths| env::split_paths(&paths).map(|dir| dir.join(binary_name)).collect())
        .unwrap_or_default()
}

fn default_zotero_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    #[cfg(target_os = "windows")]
    {
        for var_name in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
            if let Ok(base) = env::var(var_name) {
                candidates.push(PathBuf::from(base).join("Zotero").join("zotero.exe"));
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        candidates.push(PathBuf::from("/Applications/Zotero.app/Contents/MacOS/zotero"));
    }

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        candidates.push(PathBuf::from("/usr/bin/zotero"));
        candidates.push(PathBuf::from("/usr/local/bin/zotero"));
        candidates.push(PathBuf::from("/opt/zotero/zotero"));
    }

    candidates
}
