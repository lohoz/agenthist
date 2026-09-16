# Build and package AgentHist Desktop

[English](#english) · [简体中文](#简体中文)

## English

The repository contains both the Node.js CLI and the Electron GUI. Use Node.js 24 (the exact CI version is in `.node-version`), npm, and Git. Packaged desktop users do not need Node.js; continuing a conversation requires the corresponding Agent and an interactive terminal.

### Install and run

```bash
git clone --branch ui https://github.com/lohoz/agenthist.git
cd agenthist
npm ci
npm run desktop:dev
```

For CLI development:

```bash
npm run build
node .build/src/cli/main.js --help
npm link
agenthist doctor
```

`npm run build` compiles the shared core, Electron preload and renderer. `npm run build:icons` generates PNG/ICO icons from `build/icon.svg`; generated icons, `.build/`, `node_modules/` and `release/` are not committed. `npm run desktop:start` reuses the existing build.

### Native packaging

Run each command on its target operating system. On macOS install Xcode Command Line Tools (`xcode-select --install`). On Ubuntu/Debian install `rpm`, `libarchive-tools` and the Electron desktop runtime libraries; AppImage execution may require FUSE 2. A graphical session is required for interactive use.

| Host | Command | Output in `release/` |
| --- | --- | --- |
| Windows x64 | `npm run desktop:dist:win` | `AgentHist-<version>-x64-Setup.exe`, `AgentHist-<version>-x64-Portable.exe` |
| macOS Apple Silicon | `npm run desktop:dist:mac -- --arm64` | `AgentHist-<version>-macOS-arm64.dmg`, `.zip` |
| macOS Intel | `npm run desktop:dist:mac -- --x64` | `AgentHist-<version>-macOS-x64.dmg`, `.zip` |
| Linux x64 | `npm run desktop:dist:linux -- --x64` | `AgentHist-<version>-Linux-x64.AppImage`, `.deb`, `.rpm` |
| Linux ARM64 | `npm run desktop:dist:linux -- --arm64` | `AgentHist-<version>-Linux-arm64.AppImage`, `.deb`, `.rpm` |

`npm run desktop:pack` builds only an unpacked application for the current host. For other architectures, install dependencies and build on a native runner of that architecture. Do not copy an installed Electron distribution between platforms. macOS DMG creation requires macOS; the release workflow uses separate native runners rather than pretending to create a DMG on Windows. See [electron-builder architecture](https://www.electron.build/v26/docs/architecture/) and [GitHub-hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

Electron 44 requires macOS 13 or later; Windows packages target Windows 10/11 x64. Linux packages are built on Ubuntu 24.04 for x64 and ARM64. See the [Electron 44 release notes](https://www.electronjs.org/blog/electron-44-0) for runtime support.

### Install the packages

- Windows: run Setup, or launch the Portable EXE from a writable location.
- macOS: open the matching DMG and copy AgentHist to Applications. This community release is not Apple-notarized; macOS may require approval in Privacy & Security after verifying the download source.
- Debian/Ubuntu: `sudo apt install ./AgentHist-<version>-Linux-x64.deb`.
- Fedora: `sudo dnf install ./AgentHist-<version>-Linux-x64.rpm`.
- AppImage: `chmod +x AgentHist-<version>-Linux-x64.AppImage`, then run it as your regular user. Replace `x64` with `arm64` when needed.

Release builds are unsigned unless a maintainer supplies signing configuration. Do not describe unsigned packages as signed or notarized. For a signed macOS build, override `mac.identity` and `mac.hardenedRuntime`, configure entitlements and notarization credentials following [electron-builder code signing](https://www.electron.build/code-signing.html). Keep all certificates and credentials outside Git.

### Verification and releases

```bash
npm run verify
npm run smoke:package
npm run desktop:dist
node scripts/smoke-desktop-launch.mjs
```

On Linux CI, run the last command with `xvfb-run -a`. It verifies a packaged app using isolated, empty Agent roots; normal launches do not enable the debugging port used by this test. Windows also has `npm run test:e2e` and `npm run smoke:desktop-artifacts` for deeper UI, installer, and rollback coverage.

The `Release` workflow builds Windows x64, macOS x64/ARM64, and Linux x64/ARM64. It verifies the version tag, runs source and package tests, builds native packages, and launches the unpacked application. Only after every platform succeeds does it publish binaries, a `git archive` source ZIP, and `SHA256SUMS.txt`. It does not publish to npm. The source archive contains committed source and documentation only; binaries are Release assets.

## 简体中文

本仓库同时提供 CLI 和 Electron GUI。开发需要 Node.js 24、npm 和 Git，CI 的准确版本见 `.node-version`。安装包已自带 Electron，无需用户安装 Node.js；继续对话仍需安装对应 Agent 和终端。

### 从源码运行

```bash
git clone --branch ui https://github.com/lohoz/agenthist.git
cd agenthist
npm ci
npm run desktop:dev
```

CLI 开发可执行 `npm run build`，然后运行 `node .build/src/cli/main.js --help`；也可通过 `npm link` 使用本地 `agenthist` 命令。

### 各平台构建与打包

请在目标系统中构建。macOS 先执行 `xcode-select --install` 安装命令行工具；Ubuntu/Debian 需要 `rpm`、`libarchive-tools` 和 Electron 的桌面运行库，运行 AppImage 可能需要 FUSE 2。

| 系统 | 命令 | 产物 |
| --- | --- | --- |
| Windows x64 | `npm run desktop:dist:win` | Setup.exe、Portable.exe |
| macOS Apple Silicon | `npm run desktop:dist:mac -- --arm64` | arm64 DMG、应用 ZIP |
| macOS Intel | `npm run desktop:dist:mac -- --x64` | x64 DMG、应用 ZIP |
| Linux x64 | `npm run desktop:dist:linux -- --x64` | AppImage、DEB、RPM |
| Linux ARM64 | `npm run desktop:dist:linux -- --arm64` | AppImage、DEB、RPM |

所有产物输出到 `release/`。`npm run desktop:pack` 只生成当前系统的解包目录。跨架构应使用对应的原生构建环境；不要把 Windows 的 Electron 安装目录复制给 macOS/Linux。DMG 需要在 macOS 中生成。

Windows 支持 Windows 10/11 x64；macOS 需要 13 或更新版本；Linux 发布包使用 Ubuntu 24.04 构建。选择与机器架构一致的文件。Windows 安装版运行 Setup，免安装版直接运行 Portable；macOS 把 DMG 中的应用拖入 Applications；DEB/RPM 分别用 `apt install ./文件.deb` / `dnf install ./文件.rpm` 安装。

当前社区包默认未签名，macOS 未做 Apple 公证，系统可能显示来源确认提示。校验来源与 `SHA256SUMS.txt` 后再按系统提示允许运行；签名证书和凭据不得提交到仓库。

### 验证与发布

`npm run verify` 检查类型、构建、核心和界面测试以及 CLI；`npm run smoke:package` 验证安装后的 CLI 包；`node scripts/smoke-desktop-launch.mjs` 验证打包应用启动（Linux CI 使用 `xvfb-run -a`）。Windows 还提供 `npm run test:e2e` 和 `npm run smoke:desktop-artifacts`。

推送与 `package.json` 版本匹配的 `v*` 标签后，GitHub Actions 会分别在各平台构建，全部通过后发布 Release。Release 包含二进制安装包、由已提交文件生成的源码 ZIP 和 SHA-256 校验清单，不会自动发布 npm 包。仓库仅保留源码、测试、构建脚本、锁文件和脱敏文档资源。
