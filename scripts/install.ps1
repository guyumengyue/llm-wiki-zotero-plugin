param(
  [Parameter(Mandatory = $true)]
  [string]$LlmWikiPath
)

$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$target = Resolve-Path $LlmWikiPath
$pluginFiles = Join-Path $root "plugin-files"
$patch = Join-Path $root "patches\llm-wiki-zotero-integration.patch"

if (!(Test-Path (Join-Path $target "package.json")) -or !(Test-Path (Join-Path $target "src-tauri\Cargo.toml"))) {
  throw "The target path does not look like an llm_wiki checkout: $target"
}

Get-ChildItem -Path $pluginFiles -Recurse -File | ForEach-Object {
  $relative = $_.FullName.Substring((Resolve-Path $pluginFiles).Path.Length).TrimStart('\', '/')
  $dest = Join-Path $target $relative
  New-Item -ItemType Directory -Force (Split-Path $dest -Parent) | Out-Null
  Copy-Item $_.FullName $dest -Force
  Write-Host "Copied $relative"
}

Push-Location $target
try {
  git apply --check $patch
  git apply $patch
  Write-Host "Applied Zotero integration patch."
} finally {
  Pop-Location
}

Write-Host "LLM Wiki Zotero import plugin installed."
