# Zotero Import

LLM Wiki can import local Zotero library attachments into the current project's raw sources. The importer talks to Zotero on the local machine, copies supported files into the project, and queues them for the normal source ingest pipeline.

## Requirements

- Zotero is installed on the same computer as LLM Wiki.
- The Better BibTeX for Zotero extension is installed and enabled.
- Zotero's local HTTP endpoint is available at the default local address used by Better BibTeX and Zotero (`127.0.0.1:23119`).
- The Zotero attachments you want to import are available on disk. If an attachment only exists in cloud storage, sync or download it in Zotero first.

## Supported Content

The importer currently imports:

- PDF attachments.
- Markdown attachments (`.md` and `.markdown`).
- Zotero child notes, converted to Markdown.

Generated source files are written under:

```text
<project>/raw/sources/zotero/<citation-or-title-folder>/
```

LLM Wiki also writes an import manifest to:

```text
<project>/.llm-wiki/zotero-import.json
```

The manifest is project-local state and should not be committed unless your project intentionally tracks generated local import metadata.

## How To Use

1. Install Zotero and Better BibTeX for Zotero.
2. Open Zotero at least once and confirm Better BibTeX is enabled.
3. In Zotero, make sure attachment files are available locally. For synced libraries, open or download the attachment first if needed.
4. Open LLM Wiki and select the target project.
5. Go to the Sources view.
6. Click the `Zotero` import button.
7. Wait for the completion dialog. It reports scanned items, imported attachments, imported notes, already-present files, missing local files, and queued ingest tasks.
8. Let the normal ingest queue finish. Imported PDFs and Markdown notes then become available as regular raw sources.

If Zotero is not already running, LLM Wiki tries to start it from the default platform install location:

- Windows: `C:\Program Files\Zotero\zotero.exe`
- macOS: `/Applications/Zotero.app/Contents/MacOS/zotero`
- Linux: `zotero` from `PATH`

## Behavior

- Existing imported files are not copied again.
- Destination names include the Zotero attachment key, so repeated imports are stable.
- Old Zotero-generated metadata Markdown files are removed by default because metadata Markdown import is disabled. Zotero notes are preserved.
- Missing local attachments are skipped and counted in the completion dialog.
- Only local Zotero data is read. The importer does not require a Zotero web API key.

## Troubleshooting

If the import cannot connect to Zotero, open Zotero manually and try again. Also confirm Better BibTeX is installed and Zotero's local endpoint is not blocked by firewall or proxy software.

If many files are reported as missing on disk, open Zotero and download or sync those attachments locally, then rerun the import.

If a source was already imported, rerunning the import should report it as already present instead of copying a duplicate.
