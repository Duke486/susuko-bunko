# スス子文庫（Susuko Bunko）
[![下载 Windows 版](https://img.shields.io/badge/下载-Windows%20版-0078D4?style=for-the-badge&logo=windows)](https://github.com/TimeyearsShine/susuko-bunko/releases/latest/download/SusukoBunko-Setup.exe)

[![下载安卓版](https://img.shields.io/badge/下载-安卓%20APK-3DDC84?style=for-the-badge&logo=android)](https://github.com/TimeyearsShine/susuko-bunko/releases/latest/download/SusukoBunko.apk)
自托管同步的轻小说 / 漫画阅读器。书、合集和阅读进度都放在你自己的服务器上，Windows、安卓和浏览器看到的是同一个书架。

- **格式**：EPUB（含插画）、CBZ / ZIP 漫画
- **小说**：横排左右翻页，宽屏自动双页；字号、行距、页边距、字体、四种纸张；目录、进度条、章内链接。日文竖排书会被强制转成横排
- **漫画**：翻页（默认日漫右翻，宽屏双页）或下拉长条
- **书架**：自建合集（一本书可以放进多个合集）、在读 / 未分类、搜索、排序、多选整理
- **系列与卷号**：导入时自动从 EPUB 信息或书名里识别；同系列叠成一本，点开按卷号排列；也可以多选后“设为系列”批量编号
- **同步**：书籍文件 + 进度 + 合集。没下载的书边读边加载，不用等整本下完；读过或手动下载的书存在本机，离线也能读，联网后进度自动补传

## 目录结构

```
app/         客户端界面（纯 HTML/CSS/JS，没有构建步骤）
server/      同步服务端（Node.js，零依赖，单文件）
src-tauri/   Windows / 安卓的原生外壳（Tauri 2）
```

三端共用 `app/` 这一份界面：服务端直接托管它（浏览器访问），Tauri 把它打包成原生应用。

## 1. 部署服务端（Ubuntu）

需要 Node.js 18 以上，不用 `npm install`。

```bash
sudo mkdir -p /opt/shiori && sudo cp -r app server /opt/shiori/
cd /opt/shiori
SHIORI_KEY=一串足够长的随机密钥 node server/server.js
```

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `SHIORI_KEY` | 必填 | 访问密钥，至少 8 位，客户端连接时填写 |
| `PORT` | `8787` | 监听端口 |
| `HOST` | `127.0.0.1` | 只监听本机，对外由 nginx 转发 |
| `DATA_DIR` | `server/data` | 书、封面和 `db.json` 的存放位置，备份这个目录即可 |
| `MAX_BOOK_MB` | `2048` | 单本书的大小上限 |

长期运行用 `server/shiori.service`（systemd），对外访问用 `server/nginx.conf.example` 配 HTTPS 反向代理。**请务必走 HTTPS**：密钥是随请求头发送的，而且安卓默认不允许应用访问明文 HTTP。

部署好之后，用浏览器打开 `https://你的域名/` 就是网页版，填入密钥即可使用。

## 2. 打包客户端（推荐：让 GitHub 代劳）

不想在自己电脑上装 Rust 和 Android Studio 的话：把整个项目推到一个 GitHub 仓库（私有的也行），打开仓库的 **Actions → 打包客户端 → Run workflow**。跑完后在运行页面底部下载 `windows-installer`（安装包）和 `android-apk`。安卓签名的设置方法写在 `.github/workflows/build.yml` 开头。

下面两节是在自己电脑上打包的方法。

## 2a. 在本机打包 Windows 客户端

准备：[Rust](https://rustup.rs)、Node.js、Visual Studio C++ 生成工具（WebView2 在 Win10/11 上自带）。

```bash
npm install
npm run dev            # 开发调试
npm run build:windows  # 安装包在 src-tauri/target/release/bundle/nsis/
```

## 2b. 在本机打包安卓客户端

准备：Android Studio（SDK + NDK）、JDK 17，并按 [Tauri 的安卓环境说明](https://tauri.app/start/prerequisites/#android) 设置 `ANDROID_HOME`、`NDK_HOME`。

```bash
rustup target add aarch64-linux-android armv7-linux-androideabi
npm install
npx tauri icon src-tauri/app-icon.png   # 生成各尺寸图标（含安卓）
npx tauri android init
npm run build:android                    # APK 在 src-tauri/gen/android/app/build/outputs/apk/
```

正式安装需要给 APK 签名，见 Tauri 文档的 Android 签名一节。嫌麻烦的话，安卓上也可以直接用 Chrome 打开网页版，选“添加到主屏幕”。

## 同步是怎么工作的

- 服务器是唯一的数据源。导入一本书时，客户端在本地读出书名、作者和封面，再把文件上传；相同文件（按 SHA-256）不会重复保存。
- 打开一本没下载的书时，客户端只向服务器要正在读的那部分（每块 512KB），所以网速慢也能很快翻开；空闲时再在后台把整本补齐存到本机（可在设置里关掉）。
- 进度按“最后阅读的时间”为准：每次翻页先写本机，几秒后推到服务器；离线时攒着，联网后补传。打开一本书前会先拉一次最新进度。
- 合集、改名、删除需要联网才能操作。

## 升级服务端

用新的 `app/` 和 `server/server.js` 覆盖旧文件后重启服务即可，`DATA_DIR` 里的数据不用动，环境变量也没变（仍然是 `SHIORI_KEY`）。

## 已知限制

- 文字不能选中复制，没有书签、批注和全文搜索。
- 只支持无 DRM 的 EPUB；不支持 PDF、MOBI、TXT、RAR/CBR。
- 单用户设计：一个密钥对应一个书架。
- 超过 4GB 的 ZIP64 压缩包不支持。
