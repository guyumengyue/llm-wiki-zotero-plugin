import {
  copyFile,
  createDirectory,
  deleteFile,
  fileExists,
  getFileMd5,
  listDirectory,
  readFile,
  writeFileAtomic,
} from "@/commands/fs"
import type { FileNode } from "@/types/wiki"
import { callZoteroBbtRpc, callZoteroLocalApi, startZotero } from "@/commands/zotero"
import type { WikiProject } from "@/types/wiki"
import type { LlmConfig } from "@/stores/wiki-store"
import { getFileName, normalizePath } from "@/lib/path-utils"
import { enqueueSourceIngest } from "@/lib/source-lifecycle"
import { refreshProjectFileTree } from "@/lib/project-file-tree-refresh"

export interface ZoteroImportOptions {
  rpcUrl?: string
  zoteroExecutablePath?: string
  startIfUnavailable?: boolean
  copyAttachments?: boolean
  /** When false (default), skip metadata markdown and only import PDF attachments. */
  importMetadata?: boolean
}

export interface ZoteroImportSummary {
  itemsFound: number
  metadataFilesWritten: number
  metadataFilesRemoved: number
  attachmentsImported: number
  attachmentsAlreadyPresent: number
  attachmentsSkipped: number
  attachmentsMissingOnDisk: number
  notesImported: number
  ingestQueued: number
  errors: string[]
}

export interface ZoteroItem {
  itemKey: string
  citationKey: string
  title: string
  creators: string[]
  year?: string
  doi?: string
  url?: string
  abstract?: string
  itemType?: string
  libraryType?: "user" | "group"
  libraryId?: string
  raw: Record<string, unknown>
}

interface ZoteroAttachment {
  itemKey: string
  title: string
  path?: string
  /** Inline Zotero note HTML/plain text (no file on disk). */
  content?: string
  mimeType?: string
  raw: Record<string, unknown>
}

const DEFAULT_RPC_URL = "http://127.0.0.1:23119/better-bibtex/json-rpc"
const ZOTERO_READY_TIMEOUT_MS = 45_000
const ZOTERO_IMPORT_ROOT = "zotero"
const RESERVED_WINDOWS_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
])

async function callZotero<T>(
  method: string,
  params: unknown[] = [],
  rpcUrl = DEFAULT_RPC_URL,
): Promise<T> {
  const result = await callZoteroBbtRpc(method, params, rpcUrl)
  return result as T
}

function shouldStartZotero(err: unknown): boolean {
  const msg = String(err).toLowerCase()
  if (/returned http [45]\d{2}/.test(msg)) return false
  if (msg.includes("connection refused") || msg.includes("actively refused")) return true
  if (msg.includes("failed to connect") || msg.includes("error sending request")) return true
  if (msg.includes("timed out") || msg.includes("timeout")) return true
  return false
}

async function ensureZoteroReady(options: ZoteroImportOptions): Promise<void> {
  const rpcUrl = options.rpcUrl ?? DEFAULT_RPC_URL
  try {
    await callZotero("api.ready", [], rpcUrl)
    return
  } catch (firstErr) {
    if (!options.startIfUnavailable) {
      throw betterBibtexUnavailableError(firstErr)
    }
    if (!shouldStartZotero(firstErr)) {
      await waitForZoteroReady(rpcUrl)
      return
    }
  }

  await startZotero(options.zoteroExecutablePath)
  await waitForZoteroReady(rpcUrl)
}

async function waitForZoteroReady(rpcUrl: string): Promise<void> {
  const deadline = Date.now() + ZOTERO_READY_TIMEOUT_MS
  let lastError: unknown = null
  while (Date.now() < deadline) {
    try {
      await callZotero("api.ready", [], rpcUrl)
      return
    } catch (err) {
      lastError = err
      await new Promise((resolve) => setTimeout(resolve, 800))
    }
  }
  throw betterBibtexUnavailableError(lastError)
}

function betterBibtexUnavailableError(err: unknown): Error {
  const detail = err instanceof Error ? err.message : err != null ? String(err) : ""
  const suffix = detail ? ` ${detail}` : ""
  return new Error(
    `Could not connect to Zotero Better BibTeX at ${DEFAULT_RPC_URL}.${suffix} Make sure Zotero is running and the Better BibTeX extension is installed.`,
  )
}

function stringField(record: Record<string, unknown>, names: string[]): string | undefined {
  for (const name of names) {
    const value = record[name]
    if (typeof value === "string" && value.trim()) return value.trim()
    if (typeof value === "number") return String(value)
  }
  return undefined
}

function arrayField(record: Record<string, unknown>, names: string[]): unknown[] {
  for (const name of names) {
    const value = record[name]
    if (Array.isArray(value)) return value
  }
  return []
}

function creatorName(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null
  if (!value || typeof value !== "object") return null
  const record = value as Record<string, unknown>
  const name = stringField(record, ["name", "fullName"])
  if (name) return name
  const first = stringField(record, ["firstName", "given"]) ?? ""
  const last = stringField(record, ["lastName", "family"]) ?? ""
  return `${first} ${last}`.trim() || null
}

export function extractZoteroItemKey(idOrKey: string): string | undefined {
  const trimmed = idOrKey.trim()
  const fromUri = trimmed.match(/\/items\/([A-Z0-9]{8})\b/i)
  if (fromUri) return fromUri[1].toUpperCase()
  if (/^[A-Z0-9]{8}$/i.test(trimmed)) return trimmed.toUpperCase()
  return undefined
}

export function parseZoteroItemRef(
  record: Record<string, unknown>,
): Pick<ZoteroItem, "itemKey" | "libraryType" | "libraryId"> | null {
  const id = stringField(record, ["id"])
  if (id) {
    const user = id.match(/\/users\/(\d+)\/items\/([A-Z0-9]{8})\b/i)
    if (user) {
      return { libraryType: "user", libraryId: user[1], itemKey: user[2].toUpperCase() }
    }
    const group = id.match(/\/groups\/(\d+)\/items\/([A-Z0-9]{8})\b/i)
    if (group) {
      return { libraryType: "group", libraryId: group[1], itemKey: group[2].toUpperCase() }
    }
  }

  const key = stringField(record, ["itemKey", "key", "item_key"])
  const itemKey = key ? extractZoteroItemKey(key) : undefined
  if (!itemKey) return null
  return { itemKey }
}

export function fileUrlToPath(href: string): string | undefined {
  if (!href.startsWith("file:")) return undefined
  try {
    const url = new URL(href)
    let path = decodeURIComponent(url.pathname)
    if (/^\/[A-Za-z]:\//.test(path)) {
      path = path.slice(1)
    }
    return normalizePath(path)
  } catch {
    return undefined
  }
}

function zoteroItemApiBase(item: Pick<ZoteroItem, "libraryType" | "libraryId" | "itemKey">): string | null {
  if (!item.libraryId) return null
  if (item.libraryType === "group") {
    return `/api/groups/${item.libraryId}/items/${item.itemKey}`
  }
  return `/api/users/${item.libraryId}/items/${item.itemKey}`
}

function normalizeZoteroItem(value: unknown, fallbackIndex: number): ZoteroItem | null {
  if (!value || typeof value !== "object") return null
  const record = value as Record<string, unknown>
  const ref = parseZoteroItemRef(record)
  const itemKey = ref?.itemKey
  const citationKey =
    stringField(record, [
      "citationKey",
      "citekey",
      "citeKey",
      "citation_key",
      "citation-key",
    ]) ?? ""
  if (!itemKey && !citationKey) return null

  const creators = arrayField(record, ["creators", "creator", "authors", "author"])
    .map(creatorName)
    .filter((name): name is string => Boolean(name))

  const date = stringField(record, ["date", "year", "issued"])
  return {
    itemKey: itemKey ?? `zotero-item-${fallbackIndex + 1}`,
    citationKey,
    title: stringField(record, ["title", "shortTitle"]) ?? citationKey ?? itemKey ?? "Zotero item",
    creators,
    year: extractYear(date),
    doi: stringField(record, ["DOI", "doi"]),
    url: stringField(record, ["url", "URL"]),
    abstract: stringField(record, ["abstractNote", "abstract"]),
    itemType: stringField(record, ["itemType", "type"]),
    libraryType: ref?.libraryType,
    libraryId: ref?.libraryId,
    raw: record,
  }
}

function normalizeAttachment(value: unknown, fallbackIndex: number): ZoteroAttachment | null {
  if (!value || typeof value !== "object") return null
  const record = value as Record<string, unknown>
  const path = stringField(record, ["path", "localPath", "filename", "file"])
  return {
    itemKey: stringField(record, ["itemKey", "key", "attachmentKey"]) ?? `attachment-${fallbackIndex + 1}`,
    title: stringField(record, ["title", "name"]) ?? getFileName(path ?? "") ?? `attachment-${fallbackIndex + 1}`,
    path,
    mimeType: stringField(record, ["mimeType", "contentType"]),
    raw: record,
  }
}

function extractYear(value?: string): string | undefined {
  const match = value?.match(/\b(1[5-9]\d{2}|20\d{2}|21\d{2})\b/)
  return match?.[1]
}

function stableSuffix(input: string): string {
  let hash = 2166136261
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36).slice(0, 7)
}

export function sanitizeZoteroPathSegment(input: string): string {
  let value = input
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim()
  if (!value) value = "zotero-item"

  const stem = value.split(".")[0]?.toLowerCase() ?? value.toLowerCase()
  if (RESERVED_WINDOWS_NAMES.has(stem)) {
    value = `_${value}`
  }
  return value.slice(0, 96)
}

export function zoteroItemFolderName(item: Pick<ZoteroItem, "citationKey" | "itemKey" | "title">): string {
  const base = sanitizeZoteroPathSegment(item.citationKey || item.title || item.itemKey)
  return `${base}-${stableSuffix(item.itemKey)}`
}

export function isPdfAttachment(
  attachment: Pick<ZoteroAttachment, "path" | "title" | "mimeType" | "content">,
): boolean {
  if (attachment.content) return false
  const mime = attachment.mimeType?.toLowerCase() ?? ""
  if (mime.includes("pdf")) return true
  const name = (attachment.path ?? attachment.title).toLowerCase()
  return name.endsWith(".pdf")
}

export function isMarkdownFileAttachment(
  attachment: Pick<ZoteroAttachment, "path" | "title" | "mimeType" | "content">,
): boolean {
  if (attachment.content) return false
  const mime = attachment.mimeType?.toLowerCase() ?? ""
  if (mime.includes("markdown") || mime === "text/plain") {
    const name = (attachment.path ?? attachment.title).toLowerCase()
    if (name.endsWith(".md") || name.endsWith(".markdown")) return true
  }
  const name = (attachment.path ?? attachment.title).toLowerCase()
  return name.endsWith(".md") || name.endsWith(".markdown")
}

export function isZoteroNoteAttachment(
  attachment: Pick<ZoteroAttachment, "content">,
): boolean {
  return Boolean(attachment.content?.trim())
}

export function isImportableAttachment(
  attachment: Pick<ZoteroAttachment, "path" | "title" | "mimeType" | "content">,
): boolean {
  return (
    isPdfAttachment(attachment) ||
    isMarkdownFileAttachment(attachment) ||
    isZoteroNoteAttachment(attachment)
  )
}

export function zoteroNoteToMarkdown(noteHtml: string): string {
  const trimmed = noteHtml.trim()
  if (!trimmed.includes("<")) return trimmed
  return trimmed
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

export function buildZoteroNoteMarkdown(
  item: Pick<ZoteroItem, "itemKey" | "citationKey" | "title">,
  attachment: Pick<ZoteroAttachment, "itemKey" | "title" | "content">,
): string {
  const body = zoteroNoteToMarkdown(attachment.content ?? "")
  const lines = [
    "---",
    "source_provider: zotero",
    `zotero_item_key: ${JSON.stringify(item.itemKey)}`,
    `zotero_note_key: ${JSON.stringify(attachment.itemKey)}`,
    `citation_key: ${JSON.stringify(item.citationKey)}`,
    `title: ${JSON.stringify(attachment.title || item.title)}`,
    "---",
    "",
    body,
    "",
  ]
  return lines.join("\n")
}

export function isZoteroGeneratedMetadataMarkdown(content: string): boolean {
  const head = content.slice(0, 600)
  if (!/^---\r?\n[\s\S]*source_provider:\s*zotero\r?\n[\s\S]*---/.test(head)) return false
  if (head.includes("zotero_note_key:")) return false
  return head.includes("zotero_item_key:")
}

export function attachmentDestPath(
  projectPath: string,
  itemFolder: string,
  attachment: Pick<ZoteroAttachment, "path" | "title" | "itemKey" | "content">,
): string | null {
  if (attachment.content) {
    const stem = sanitizeZoteroPathSegment(attachment.title || "note")
    const fileName = `${stem}-${sanitizeZoteroPathSegment(attachment.itemKey)}.md`
    return `${projectPath}/raw/sources/${ZOTERO_IMPORT_ROOT}/${itemFolder}/${fileName}`
  }
  if (!attachment.path) return null
  const sourcePath = normalizePath(attachment.path)
  const originalName = getFileName(sourcePath) || sanitizeZoteroPathSegment(attachment.title)
  const dot = originalName.lastIndexOf(".")
  const stem = dot > 0 ? originalName.slice(0, dot) : originalName
  const ext = dot > 0 ? originalName.slice(dot) : ""
  const fileName = `${sanitizeZoteroPathSegment(stem)}-${sanitizeZoteroPathSegment(attachment.itemKey)}${ext}`
  return `${projectPath}/raw/sources/${ZOTERO_IMPORT_ROOT}/${itemFolder}/${fileName}`
}

function markdownList(values: string[]): string {
  if (values.length === 0) return "- None"
  return values.map((value) => `- ${value}`).join("\n")
}

export function buildZoteroMetadataMarkdown(
  item: ZoteroItem,
  attachments: ZoteroAttachment[],
): string {
  const lines = [
    "---",
    "source_provider: zotero",
    `zotero_item_key: ${JSON.stringify(item.itemKey)}`,
    `citation_key: ${JSON.stringify(item.citationKey)}`,
    `title: ${JSON.stringify(item.title)}`,
    item.year ? `year: ${JSON.stringify(item.year)}` : null,
    item.doi ? `doi: ${JSON.stringify(item.doi)}` : null,
    item.url ? `url: ${JSON.stringify(item.url)}` : null,
    "---",
    "",
    `# ${item.title}`,
    "",
    `Citation key: ${item.citationKey}`,
    "",
    "## Authors",
    "",
    markdownList(item.creators),
    "",
    "## Metadata",
    "",
    `- Zotero item key: ${item.itemKey}`,
    item.itemType ? `- Item type: ${item.itemType}` : null,
    item.year ? `- Year: ${item.year}` : null,
    item.doi ? `- DOI: ${item.doi}` : null,
    item.url ? `- URL: ${item.url}` : null,
    "",
    "## Abstract",
    "",
    item.abstract?.trim() || "No abstract available.",
    "",
    "## Attachments",
    "",
    attachments.length === 0
      ? "- None"
      : attachments.map((attachment) => `- ${attachment.title}${attachment.path ? ` (${attachment.path})` : ""}`).join("\n"),
    "",
  ].filter((line): line is string => line !== null)

  return `${lines.join("\n").trimEnd()}\n`
}

async function listZoteroItems(rpcUrl: string): Promise<ZoteroItem[]> {
  const result = await callZotero<unknown>(
    "item.search",
    [
      [
        ["itemType", "isNot", "annotation"],
      ],
    ],
    rpcUrl,
  )

  const values = Array.isArray(result) ? result : Object.values((result ?? {}) as Record<string, unknown>)
  return values
    .map(normalizeZoteroItem)
    .filter((item): item is ZoteroItem => Boolean(item))
}

async function resolveCitationKeys(items: ZoteroItem[], rpcUrl: string): Promise<void> {
  const missing = items.filter((item) => !item.citationKey && /^[A-Z0-9]{8}$/i.test(item.itemKey))
  if (missing.length === 0) return

  const keys = missing.map((item) => item.itemKey)
  try {
    const result = await callZotero<Record<string, string | null>>("item.citationkey", [keys], rpcUrl)
    for (const item of missing) {
      const resolved = result[item.itemKey]
      if (typeof resolved === "string" && resolved.trim()) {
        item.citationKey = resolved.trim()
      }
    }
  } catch (err) {
    console.warn("[zotero-import] failed to resolve citation keys:", err)
  }
}

async function listBbtAttachments(citationKey: string, rpcUrl: string): Promise<ZoteroAttachment[]> {
  const result = await callZotero<unknown>("item.attachments", [citationKey], rpcUrl)
  const values = Array.isArray(result) ? result : Object.values((result ?? {}) as Record<string, unknown>)
  return values
    .map(normalizeAttachment)
    .filter((attachment): attachment is ZoteroAttachment => Boolean(attachment))
}

function attachmentFromApiRecord(value: unknown, fallbackIndex: number): ZoteroAttachment | null {
  if (!value || typeof value !== "object") return null
  const record = value as Record<string, unknown>
  const data = record.data
  const links = record.links
  const dataRecord = data && typeof data === "object" ? (data as Record<string, unknown>) : {}
  const linksRecord = links && typeof links === "object" ? (links as Record<string, unknown>) : {}
  const enclosure = linksRecord.enclosure
  const enclosureRecord =
    enclosure && typeof enclosure === "object" ? (enclosure as Record<string, unknown>) : {}
  const href = stringField(enclosureRecord, ["href"])
  const path = href ? fileUrlToPath(href) : undefined
  const itemKey = stringField(record, ["key"]) ?? stringField(dataRecord, ["key"])
  const title =
    stringField(dataRecord, ["filename", "title"]) ??
    stringField(enclosureRecord, ["title"]) ??
    getFileName(path ?? "") ??
    `attachment-${fallbackIndex + 1}`

  if (!path) return null
  return {
    itemKey: itemKey ?? `attachment-${fallbackIndex + 1}`,
    title,
    path,
    mimeType: stringField(dataRecord, ["contentType"]) ?? stringField(enclosureRecord, ["type"]),
    raw: record,
  }
}

function noteFromApiRecord(value: unknown, fallbackIndex: number): ZoteroAttachment | null {
  if (!value || typeof value !== "object") return null
  const record = value as Record<string, unknown>
  const data = record.data
  const dataRecord = data && typeof data === "object" ? (data as Record<string, unknown>) : {}
  if (stringField(dataRecord, ["itemType"]) !== "note") return null
  const content = stringField(dataRecord, ["note"])
  if (!content) return null
  const itemKey = stringField(record, ["key"]) ?? stringField(dataRecord, ["key"])
  const title = stringField(dataRecord, ["title"]) ?? `note-${itemKey ?? fallbackIndex + 1}`
  return {
    itemKey: itemKey ?? `note-${fallbackIndex + 1}`,
    title,
    content,
    mimeType: "text/markdown",
    raw: record,
  }
}

async function listZoteroApiAttachments(item: ZoteroItem): Promise<ZoteroAttachment[]> {
  const base = zoteroItemApiBase(item)
  if (!base) return []

  try {
    if (item.itemType === "attachment") {
      const record = await callZoteroLocalApi(base)
      const attachment = attachmentFromApiRecord(record, 0)
      return attachment ? [attachment] : []
    }

    const children = await callZoteroLocalApi(`${base}/children`)
    const values = Array.isArray(children) ? children : []
    const childFiles = values
      .map(attachmentFromApiRecord)
      .filter((attachment): attachment is ZoteroAttachment => Boolean(attachment))
    const childNotes = values
      .map(noteFromApiRecord)
      .filter((attachment): attachment is ZoteroAttachment => Boolean(attachment))
    if (childFiles.length > 0 || childNotes.length > 0) {
      return [...childFiles, ...childNotes]
    }

    // Better BibTeX search omits itemType; standalone PDFs have no children.
    const record = await callZoteroLocalApi(base)
    const selfAttachment = attachmentFromApiRecord(record, 0)
    if (selfAttachment) return [selfAttachment]
    return []
  } catch (err) {
    console.warn(`[zotero-import] failed to load attachments via Zotero API for ${item.itemKey}:`, err)
    return []
  }
}

async function listZoteroAttachments(item: ZoteroItem, rpcUrl: string): Promise<ZoteroAttachment[]> {
  const fromApi = await listZoteroApiAttachments(item)
  const notes = fromApi.filter((attachment) => isZoteroNoteAttachment(attachment))
  const apiFiles = fromApi.filter((attachment) => attachment.path && !attachment.content)

  if (item.citationKey) {
    try {
      const bbt = await listBbtAttachments(item.citationKey, rpcUrl)
      if (bbt.length > 0) return [...bbt, ...notes]
    } catch (err) {
      console.warn(`[zotero-import] failed to load attachments for ${item.citationKey}:`, err)
    }
  }

  return [...apiFiles, ...notes]
}

async function importAttachment(
  projectPath: string,
  itemFolder: string,
  item: ZoteroItem,
  attachment: ZoteroAttachment,
): Promise<"copied" | "exists" | "missing"> {
  const destPath = attachmentDestPath(projectPath, itemFolder, attachment)
  if (!destPath) return "missing"

  if (await fileExists(destPath)) {
    return "exists"
  }

  const parent = destPath.slice(0, destPath.lastIndexOf("/"))
  if (parent) {
    await createDirectory(parent)
  }

  if (attachment.content) {
    await writeFileAtomic(destPath, buildZoteroNoteMarkdown(item, attachment))
    return "copied"
  }

  const sourcePath = normalizePath(attachment.path!)
  if (!(await fileExists(sourcePath))) {
    return "missing"
  }

  await copyFile(sourcePath, destPath)
  return "copied"
}

function flattenZoteroFiles(nodes: FileNode[]): FileNode[] {
  const out: FileNode[] = []
  for (const node of nodes) {
    if (node.is_dir && node.children) {
      out.push(...flattenZoteroFiles(node.children))
    } else if (!node.is_dir) {
      out.push(node)
    }
  }
  return out
}

async function cleanupZoteroMetadataMarkdown(
  projectPath: string,
  manifestItems: Record<string, ZoteroManifestItem>,
): Promise<number> {
  const seen = new Set<string>()
  let removed = 0

  for (const entry of Object.values(manifestItems)) {
    if (entry.metadataPath) {
      seen.add(normalizePath(entry.metadataPath))
    }
  }

  const zoteroRoot = `${projectPath}/raw/sources/${ZOTERO_IMPORT_ROOT}`
  try {
    const tree = await listDirectory(zoteroRoot, true)
    for (const node of flattenZoteroFiles(tree)) {
      if (!node.path.toLowerCase().endsWith(".md")) continue
      seen.add(normalizePath(node.path))
    }
  } catch {
    // zotero folder may not exist yet
  }

  for (const mdPath of seen) {
    try {
      const content = await readFile(mdPath)
      if (!isZoteroGeneratedMetadataMarkdown(content)) continue
      await deleteFile(mdPath)
      removed += 1
    } catch {
      // skip unreadable or already deleted paths
    }
  }

  return removed
}

interface ZoteroManifestItem {
  citationKey?: string
  title?: string
  metadataPath?: string
  attachments?: string[]
  attachmentHashes?: Record<string, string>
  sourceHashes?: Record<string, string>
}

async function loadZoteroManifest(manifestPath: string): Promise<Record<string, ZoteroManifestItem>> {
  try {
    const raw = await readFile(manifestPath)
    const parsed = JSON.parse(raw) as { items?: Record<string, ZoteroManifestItem> }
    return parsed.items ?? {}
  } catch {
    return {}
  }
}

export async function importZoteroLibrary(
  project: WikiProject,
  llmConfig: LlmConfig,
  options: ZoteroImportOptions = {},
): Promise<ZoteroImportSummary> {
  const rpcUrl = options.rpcUrl ?? DEFAULT_RPC_URL
  const copyAttachments = options.copyAttachments ?? true
  const importMetadata = options.importMetadata ?? false
  const projectPath = normalizePath(project.path)
  const manifestPath = `${projectPath}/.llm-wiki/zotero-import.json`
  const summary: ZoteroImportSummary = {
    itemsFound: 0,
    metadataFilesWritten: 0,
    metadataFilesRemoved: 0,
    attachmentsImported: 0,
    attachmentsAlreadyPresent: 0,
    attachmentsSkipped: 0,
    attachmentsMissingOnDisk: 0,
    notesImported: 0,
    ingestQueued: 0,
    errors: [],
  }

  await ensureZoteroReady({
    startIfUnavailable: true,
    ...options,
    rpcUrl,
  })

  const existingManifestItems = await loadZoteroManifest(manifestPath)
  summary.metadataFilesRemoved = await cleanupZoteroMetadataMarkdown(projectPath, existingManifestItems)
  for (const entry of Object.values(existingManifestItems)) {
    delete entry.metadataPath
  }

  const items = await listZoteroItems(rpcUrl)
  await resolveCitationKeys(items, rpcUrl)
  summary.itemsFound = items.length


  const importedPaths: string[] = []
  const manifest: Record<string, unknown> = {
    version: 2,
    importedAt: new Date().toISOString(),
    items: { ...existingManifestItems },
  }

  for (const item of items) {
    const allAttachments = await listZoteroAttachments(item, rpcUrl)
    const attachments = allAttachments.filter(isImportableAttachment)
    if (attachments.length === 0) continue

    const itemFolder = zoteroItemFolderName(item)
    const copiedAttachments: string[] = []
    const sourceHashes: Record<string, string> = {
      ...(existingManifestItems[item.itemKey]?.sourceHashes ?? {}),
    }

    if (importMetadata) {
      const itemDir = `${projectPath}/raw/sources/${ZOTERO_IMPORT_ROOT}/${itemFolder}`
      await createDirectory(itemDir)
      const metadataPath = `${itemDir}/${sanitizeZoteroPathSegment(item.citationKey || item.itemKey)}.md`
      await writeFileAtomic(metadataPath, buildZoteroMetadataMarkdown(item, attachments))
      importedPaths.push(metadataPath)
      summary.metadataFilesWritten += 1
    }

    if (copyAttachments) {
      for (const attachment of attachments) {
        const destPath = attachmentDestPath(projectPath, itemFolder, attachment)
        const isNote = isZoteroNoteAttachment(attachment)

        try {
          const result = await importAttachment(projectPath, itemFolder, item, attachment)
          if (result === "copied" && destPath) {
            copiedAttachments.push(destPath)
            importedPaths.push(destPath)
            if (isNote) {
              summary.notesImported += 1
            } else {
              summary.attachmentsImported += 1
            }
            if (!isNote && attachment.path) {
              try {
                const sourcePath = normalizePath(attachment.path)
                sourceHashes[attachment.itemKey] = await getFileMd5(sourcePath)
              } catch {
                // keep going without source hash
              }
            }
          } else if (result === "exists" && destPath) {
            copiedAttachments.push(destPath)
            summary.attachmentsAlreadyPresent += 1
          } else {
            summary.attachmentsSkipped += 1
            if (!isNote && attachment.path && !(await fileExists(normalizePath(attachment.path)))) {
              summary.attachmentsMissingOnDisk += 1
              if (summary.errors.length < 20) {
                summary.errors.push(`${item.itemKey}: file not found on disk: ${attachment.path}`)
              }
            }
          }
        } catch (err) {
          summary.attachmentsSkipped += 1
          if (summary.errors.length < 20) {
            summary.errors.push(`${item.itemKey}: failed to import ${attachment.title}: ${String(err)}`)
          }
        }
      }
    }

    const manifestItem: ZoteroManifestItem = {
      citationKey: item.citationKey,
      title: item.title,
      attachments: copiedAttachments,
      attachmentHashes: await attachmentHashes(copiedAttachments),
      sourceHashes,
    }
    if (importMetadata) {
      manifestItem.metadataPath = `${projectPath}/raw/sources/${ZOTERO_IMPORT_ROOT}/${itemFolder}/${sanitizeZoteroPathSegment(item.citationKey || item.itemKey)}.md`
    }
    ;(manifest.items as Record<string, ZoteroManifestItem>)[item.itemKey] = manifestItem
  }


  await writeFileAtomic(manifestPath, JSON.stringify(manifest, null, 2))

  const ingestPaths = importedPaths.filter((path) => /\.(pdf|md)$/i.test(path))
  const queued = await enqueueSourceIngest(project, ingestPaths, llmConfig, {
    sourceRoot: `${projectPath}/raw/sources/${ZOTERO_IMPORT_ROOT}`,
    rootContext: "Zotero",
  })
  summary.ingestQueued = queued.length
  await refreshProjectFileTree(projectPath, {
    projectId: project.id,
    bumpDataVersion: true,
  })

  return summary
}

async function attachmentHashes(paths: string[]): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {}
  for (const path of paths) {
    try {
      hashes[path] = await getFileMd5(path)
    } catch {
      hashes[path] = ""
    }
  }
  return hashes
}
