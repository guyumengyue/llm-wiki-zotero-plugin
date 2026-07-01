# LLM Wiki Zotero 导入插件

这是一个给 [nashsu/llm_wiki](https://github.com/nashsu/llm_wiki) 使用的 Zotero 导入插件覆盖包。它不是完整 fork，而是在原项目基础上增加 Zotero 导入能力：在 LLM Wiki 的“资料/Sources”页面增加 `Zotero` 按钮，把本机 Zotero 里的 PDF、Markdown 附件和 Zotero 笔记导入到当前项目的 `raw/sources/zotero/`，再进入 LLM Wiki 原本的提取队列。

本仓库只包含 Zotero 相关新增文件、集成补丁、安装脚本和使用说明，不包含个人 Zotero 数据、项目数据、账号 ID、API key 或本机隐私路径。

## 适用版本

本插件包基于 `nashsu/llm_wiki` 的 `v0.5.4` / commit `c03c6be` 制作。建议先使用同版本或接近版本的 LLM Wiki。

## 功能概览

- 自动检测 Zotero 是否运行。
- 如果 Zotero 未运行，自动尝试启动 Zotero。
- 通过 Better BibTeX 本地 RPC 获取 Zotero 条目和 citation key。
- 通过 Zotero 本地 API 读取附件和笔记信息。
- 导入 PDF 附件、Markdown 附件和 Zotero 子笔记。
- 导入后自动加入 LLM Wiki 的原始资料提取队列。
- 生成项目级导入记录：`<你的项目>/.llm-wiki/zotero-import.json`。

## 前置准备

### 1. 准备 LLM Wiki 源码目录

先克隆原项目：

```powershell
git clone https://github.com/nashsu/llm_wiki.git C:\work\llm_wiki
cd C:\work\llm_wiki
```

如果你已经有本地目录，只需要记住它的绝对路径，例如：

```text
C:\Users\your-name\Documents\llm_wiki
```

后面的 `-LlmWikiPath` 就填写这个目录。

### 2. 安装 Zotero

推荐从 Zotero 官网安装桌面版 Zotero。常见安装位置如下：

```text
Windows: C:\Program Files\Zotero\zotero.exe
macOS: /Applications/Zotero.app/Contents/MacOS/zotero
Linux: /usr/bin/zotero、/usr/local/bin/zotero、/opt/zotero/zotero，或 PATH 中的 zotero
```

插件会自动从这些位置查找 Zotero。你不需要把自己的真实 Zotero 路径写进仓库。

### 3. 安装 Better BibTeX for Zotero

这个插件依赖 Better BibTeX 提供的本地 JSON-RPC 能力。安装后打开 Zotero，确认 Better BibTeX 已启用。

默认连接地址是：

```text
http://127.0.0.1:23119/better-bibtex/json-rpc
```

正常情况下不需要手动配置这个地址。

## 安装到 LLM Wiki

### Windows 一键安装

在本插件仓库根目录运行：

```powershell
.\scripts\install.ps1 -LlmWikiPath "C:\work\llm_wiki"
```

请把 `C:\work\llm_wiki` 替换成你自己的 LLM Wiki 源码目录。

安装脚本会做两件事：

1. 把 `plugin-files/` 里的文件复制到 LLM Wiki 对应路径。
2. 使用 `git apply` 应用 `patches/llm-wiki-zotero-integration.patch`。

### macOS / Linux 安装

```bash
bash scripts/install.sh /path/to/llm_wiki
```

同样把 `/path/to/llm_wiki` 替换成你的 LLM Wiki 源码目录。

### 安装后新增/修改的主要路径

安装后，LLM Wiki 项目中会出现或修改这些文件：

```text
src-tauri/src/commands/zotero.rs
src/commands/zotero.ts
src/lib/zotero-import.ts
src/lib/zotero-import.test.ts
src-tauri/src/commands/mod.rs
src-tauri/src/lib.rs
src/components/sources/sources-view.tsx
src/i18n/en.json
src/i18n/zh.json
```

## Zotero 路径配置

默认不需要配置。插件启动 Zotero 时会按下面顺序寻找 `zotero.exe` 或 `zotero`：

1. 代码显式传入的路径。
2. 环境变量 `ZOTERO_EXECUTABLE`。
3. 系统常见安装位置。
4. 系统 `PATH`。

### Windows 自动查找位置

插件会尝试这些目录：

```text
%ProgramFiles%\Zotero\zotero.exe
%ProgramFiles(x86)%\Zotero\zotero.exe
%LOCALAPPDATA%\Zotero\zotero.exe
PATH 中的 zotero.exe
```

### 手动指定 Zotero 路径

如果你的 Zotero 安装在特殊位置，可以设置环境变量。

PowerShell 当前窗口临时设置：

```powershell
$env:ZOTERO_EXECUTABLE = "D:\Apps\Zotero\zotero.exe"
npm run tauri dev
```

Windows 用户级永久设置：

```powershell
[Environment]::SetEnvironmentVariable("ZOTERO_EXECUTABLE", "D:\Apps\Zotero\zotero.exe", "User")
```

设置永久环境变量后，请重新打开终端或重启开发环境。

macOS / Linux 临时设置：

```bash
export ZOTERO_EXECUTABLE="/Applications/Zotero.app/Contents/MacOS/zotero"
npm run tauri dev
```

## Zotero 附件路径要求

插件不会上传、记录或暴露你的 Zotero 附件原始路径到本仓库。运行时它只在本机读取 Zotero 返回的附件路径，然后把文件复制到当前 LLM Wiki 项目。

导入前请确认：

- Zotero 条目里的附件已经下载到本机。
- 如果附件来自 Zotero Sync，请先在 Zotero 中打开或下载附件。
- 如果附件只在云端，导入时会显示“本地文件不存在/Skipped”。

导入后的文件会进入当前 LLM Wiki 项目的这个目录：

```text
<LLM Wiki 项目路径>\raw\sources\zotero\<条目文件夹>\
```

例如你的知识库项目路径是：

```text
D:\wiki-projects\my-paper-wiki
```

那么 Zotero 文件会导入到：

```text
D:\wiki-projects\my-paper-wiki\raw\sources\zotero\
```

导入记录会写到：

```text
D:\wiki-projects\my-paper-wiki\.llm-wiki\zotero-import.json
```

这个文件是你的本地项目状态，不建议提交到公开仓库。

## 开发运行

在 LLM Wiki 项目目录中安装依赖并运行：

```powershell
cd C:\work\llm_wiki
npm install
npm run tauri dev
```

如果你使用的是已有项目，请按原项目 README 的方式启动。

## 使用流程

1. 打开 Zotero。
2. 确认 Better BibTeX 已启用。
3. 确认要导入的 PDF/Markdown 附件已经在本机。
4. 启动 LLM Wiki。
5. 打开或创建一个 LLM Wiki 项目。
6. 进入 `Sources` / `资料` 页面。
7. 点击 `Zotero` 按钮。
8. 等待完成提示。
9. 查看提示中的统计信息：
   - 扫描条目数量。
   - 导入附件数量。
   - 导入 Zotero 笔记数量。
   - 已存在文件数量。
   - 本机缺失附件数量。
   - 已加入提取队列数量。
10. 等待 LLM Wiki 的正常提取队列完成。

完成后，导入的 Zotero 资料会像普通原始资料一样参与 LLM Wiki 的解析和知识库构建。

## 验证安装

在 LLM Wiki 项目目录运行前端测试：

```powershell
npm.cmd exec vitest run src/lib/zotero-import.test.ts
```

运行 Rust 侧 Zotero 命令测试：

```powershell
cargo test --manifest-path src-tauri\Cargo.toml zotero
```

其中真实连接 Zotero / Better BibTeX 的 Rust 测试默认标记为 ignored，因为它需要本机正在运行 Zotero。

## 发布多平台版本

本仓库包含 GitHub Actions 工作流：

```text
.github/workflows/build-llm-wiki-zotero.yml
```

它会在 GitHub runner 中自动完成这些步骤：

1. 拉取本仓库的 Zotero 插件覆盖包。
2. 拉取 `nashsu/llm_wiki` 的指定版本，默认是 `v0.5.4`。
3. 把 `plugin-files/` 覆盖到 LLM Wiki 源码中。
4. 应用 `patches/llm-wiki-zotero-integration.patch`。
5. 在 Windows、Linux、macOS x64、macOS arm64 上构建 Tauri 包。
6. tag 发布时，把构建产物上传到 GitHub Release。

手动测试多平台构建：

```text
GitHub 仓库页面 -> Actions -> Build LLM Wiki Zotero Release -> Run workflow
```

正式发布：

```bash
git tag v0.5.4-zotero.1
git push origin v0.5.4-zotero.1
```

推送 `v*` tag 后，Actions 会自动创建 release，并附加 Windows、macOS、Linux 的安装包或便携包。

## 常见问题

### 点击 Zotero 后提示无法连接 Better BibTeX

请检查：

- Zotero 是否已经打开。
- Better BibTeX 是否已安装并启用。
- 本机安全软件或代理是否拦截 `127.0.0.1:23119`。

### 提示找不到 Zotero 可执行文件

说明自动查找失败。设置 `ZOTERO_EXECUTABLE`：

```powershell
$env:ZOTERO_EXECUTABLE = "你的 Zotero 安装目录\zotero.exe"
```

然后重新启动 LLM Wiki。

### 很多附件显示 missing on disk

这表示 Zotero 有附件记录，但文件没有下载到本机。请在 Zotero 中重新下载或同步附件，再重新点击 `Zotero` 导入。

### 重复点击导入会产生重复文件吗

通常不会。目标文件名包含 Zotero attachment key，重复导入时已存在文件会被统计为 already present。

### 可以不导入 PDF，只导入笔记吗

当前 UI 是统一导入 PDF、Markdown 附件和 Zotero 笔记。更细粒度的选项需要后续继续扩展。

## 隐私说明

本插件仓库不包含：

- Zotero 用户 ID。
- Zotero API key。
- Zotero 数据库。
- 你的论文、PDF 或笔记内容。
- 你的本机用户名路径。
- LLM Wiki 项目数据。
- `.llm-wiki/zotero-import.json` 运行时导入记录。

插件运行时只在你的本机访问 Zotero 本地端口和本地附件路径，不需要 Zotero Web API key。
