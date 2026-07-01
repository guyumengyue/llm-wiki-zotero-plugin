# LLM Wiki Zotero Import Plugin

[中文说明 / Chinese README](README_CN.md)

This repository contains a small Zotero import plugin/overlay for [nashsu/llm_wiki](https://github.com/nashsu/llm_wiki). It adds a Zotero button to the LLM Wiki Sources view so local Zotero PDFs, Markdown attachments, and Zotero notes can be copied into `raw/sources/zotero/` and queued for the normal LLM Wiki ingest flow.

The code is packaged as an overlay rather than a fork of the full project. Only the Zotero-specific files, integration patch, and usage documentation are included.

## What It Adds

- Tauri commands for starting Zotero, calling Better BibTeX RPC, and reading Zotero's local API.
- Automatic Zotero executable discovery from:
  - an explicit path passed by code,
  - the `ZOTERO_EXECUTABLE` environment variable,
  - common platform install locations,
  - `PATH`.
- Better BibTeX availability detection through the local `api.ready` RPC call.
- A frontend import pipeline that imports PDF attachments, Markdown attachments, and Zotero child notes.
- A Sources view `Zotero` import button.
- English and Chinese UI strings.
- Focused unit tests for Zotero path parsing, item refs, attachment filtering, and note conversion.

## Requirements

- A current checkout of [nashsu/llm_wiki](https://github.com/nashsu/llm_wiki). This overlay was prepared against upstream commit `c03c6be` / release `v0.5.4`.
- Zotero installed locally.
- Better BibTeX for Zotero installed and enabled.
- Zotero local API available at the default local port `127.0.0.1:23119`.

No Zotero web API key is required. The plugin reads local Zotero/Better BibTeX endpoints only.

## Install Into LLM Wiki

From this repository root, run:

```powershell
.\scripts\install.ps1 -LlmWikiPath "C:\path\to\llm_wiki"
```

Or on macOS/Linux:

```bash
bash scripts/install.sh /path/to/llm_wiki
```

The installer copies the files under `plugin-files/` into the matching paths in the LLM Wiki checkout, then applies `patches/llm-wiki-zotero-integration.patch` with `git apply`.

After installing, run the normal project checks in the LLM Wiki checkout, for example:

```bash
npm test -- zotero-import
cargo test --manifest-path src-tauri/Cargo.toml zotero
```

The Rust Better BibTeX live test is marked ignored because it requires a local Zotero session.

## Usage

1. Install Zotero and Better BibTeX for Zotero.
2. Open Zotero once and confirm Better BibTeX is enabled.
3. Ensure the attachments you want to import are downloaded locally in Zotero.
4. Start LLM Wiki and open the target project.
5. Open the Sources view.
6. Click `Zotero`.
7. Wait for the completion summary. Imported files are written under `raw/sources/zotero/` and queued for ingest.

See [docs/zotero-import.md](docs/zotero-import.md) for more detail.

## Privacy Notes

This repository intentionally does not include personal Zotero library data, user IDs, attachment paths, API keys, project data, generated import manifests, or local build artifacts. Test data uses generic examples only.
