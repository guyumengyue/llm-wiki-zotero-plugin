import { describe, expect, it } from "vitest"
import {
  attachmentDestPath,
  buildZoteroMetadataMarkdown,
  buildZoteroNoteMarkdown,
  extractZoteroItemKey,
  fileUrlToPath,
  isImportableAttachment,
  isMarkdownFileAttachment,
  isPdfAttachment,
  isZoteroGeneratedMetadataMarkdown,
  isZoteroNoteAttachment,
  parseZoteroItemRef,
  sanitizeZoteroPathSegment,
  zoteroItemFolderName,
  zoteroNoteToMarkdown,
  type ZoteroItem,
} from "@/lib/zotero-import"

const ITEM: ZoteroItem = {
  itemKey: "ABC123",
  citationKey: "smith2024wiki",
  title: "A Study of LLM Wiki",
  creators: ["Ada Smith", "Lin Chen"],
  year: "2024",
  doi: "10.1234/example",
  url: "https://example.test/paper",
  abstract: "A short abstract.",
  itemType: "journalArticle",
  raw: {},
}

describe("zotero-import", () => {
  it("sanitizes path segments for Windows-safe raw source folders", () => {
    expect(sanitizeZoteroPathSegment('bad<name>:"|?*')).toBe("bad_name______")
    expect(sanitizeZoteroPathSegment("con")).toBe("_con")
    expect(sanitizeZoteroPathSegment("   ")).toBe("zotero-item")
  })

  it("builds stable Zotero item folder names with the citation key visible", () => {
    const first = zoteroItemFolderName(ITEM)
    const second = zoteroItemFolderName(ITEM)
    expect(first).toBe(second)
    expect(first).toMatch(/^smith2024wiki-/)
  })

  it("writes metadata markdown as an ingestable raw source", () => {
    const markdown = buildZoteroMetadataMarkdown(ITEM, [
      {
        itemKey: "ATT1",
        title: "paper.pdf",
        path: "C:/Zotero/storage/ABC/paper.pdf",
        mimeType: "application/pdf",
        raw: {},
      },
    ])

    expect(markdown).toContain("source_provider: zotero")
    expect(markdown).toContain("citation_key: \"smith2024wiki\"")
    expect(markdown).toContain("# A Study of LLM Wiki")
    expect(markdown).toContain("- Ada Smith")
    expect(markdown).toContain("- paper.pdf (C:/Zotero/storage/ABC/paper.pdf)")
  })

  it("extracts Zotero item keys from Better BibTeX item ids", () => {
    expect(extractZoteroItemKey("http://zotero.org/users/123456/items/I9WHTVKB")).toBe("I9WHTVKB")
    expect(extractZoteroItemKey("VGMXGJA4")).toBe("VGMXGJA4")
  })

  it("parses library references from Better BibTeX search records", () => {
    expect(
      parseZoteroItemRef({
        id: "http://zotero.org/users/123456/items/I9WHTVKB",
        citekey: "",
      }),
    ).toEqual({
      libraryType: "user",
      libraryId: "123456",
      itemKey: "I9WHTVKB",
    })
  })

  it("converts Zotero file URLs into local paths", () => {
    expect(
      fileUrlToPath(
        "file:///C:/Users/example/Zotero/storage/WIZSRIVC/example%20paper.pdf",
      ),
    ).toBe("C:/Users/example/Zotero/storage/WIZSRIVC/example paper.pdf")
  })

  it("detects PDF attachments only", () => {
    expect(
      isPdfAttachment({
        path: "C:/Zotero/storage/ABC/paper.pdf",
        title: "paper.pdf",
        mimeType: "application/pdf",
      }),
    ).toBe(true)
    expect(
      isPdfAttachment({
        path: "C:/Zotero/storage/ABC/note.txt",
        title: "note.txt",
        mimeType: "text/plain",
      }),
    ).toBe(false)
  })

  it("detects markdown file attachments and Zotero notes", () => {
    expect(
      isMarkdownFileAttachment({
        path: "C:/Zotero/storage/ABC/notes.md",
        title: "notes.md",
        mimeType: "text/plain",
      }),
    ).toBe(true)
    expect(isZoteroNoteAttachment({ content: "A short note" })).toBe(true)
    expect(
      isImportableAttachment({
        content: "inline",
        title: "note",
        itemKey: "N1",
      } as never),
    ).toBe(true)
  })

  it("converts Zotero note HTML to plain markdown text", () => {
    expect(zoteroNoteToMarkdown("<p>Hello<br/>World</p>")).toContain("Hello")
    expect(zoteroNoteToMarkdown("plain note")).toBe("plain note")
  })

  it("builds note markdown with zotero frontmatter", () => {
    const md = buildZoteroNoteMarkdown(ITEM, {
      itemKey: "NOTE1",
      title: "My note",
      content: "Body text",
    })
    expect(md).toContain("zotero_note_key:")
    expect(md).toContain("Body text")
  })

  it("recognizes generated metadata markdown for cleanup", () => {
    const metadata = buildZoteroMetadataMarkdown(ITEM, [])
    expect(isZoteroGeneratedMetadataMarkdown(metadata)).toBe(true)
    expect(
      isZoteroGeneratedMetadataMarkdown(
        buildZoteroNoteMarkdown(ITEM, { itemKey: "N1", title: "n", content: "x" }),
      ),
    ).toBe(false)
  })

  it("builds stable PDF destination paths for deduplication", () => {
    const dest = attachmentDestPath("D:/project", "smith2024wiki-abc123", {
      path: "C:/Zotero/storage/ATT1/paper.pdf",
      title: "paper.pdf",
      itemKey: "ATT1",
    })
    expect(dest).toBe("D:/project/raw/sources/zotero/smith2024wiki-abc123/paper-ATT1.pdf")
  })
})
