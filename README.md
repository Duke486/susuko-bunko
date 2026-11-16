# スス子文庫（Susuko Bunko）

自托管同步的轻小说 / 漫画阅读器。书、合集和阅读进度都放在你自己的服务器上，Windows、安卓和浏览器看到的是同一个书架。

- **账号**：登录自己服务器上的账号，多端同步；不登录也能在本机完整使用，登录后可以把本机书库一键上传。可以换头像、改昵称、改密码
- **书架**：立体书架（默认，书本沿弧线摆开，可拖、甩、循环，书脊取封面主色）/ 封面 / 列表三种视图；自建合集、在读 / 已读完 / 未分类、搜索（书名、作者、画师、出版社）、多选整理；底部“继续阅读”浮条
- **主题色**：六种预设、自选颜色、从图片取色、跟随在读的书的封面；整套界面色调跟着变，深浅色各一套
- **图书详情**：封面、作者、插画、出版社、系列卷号、简介（导入时从 EPUB 读取，可自己改）、评分、书评、阅读时长
- **系列与卷号**：导入时自动识别；同系列叠成一本，点开按卷号排列；也可以多选后“设为系列”批量编号
- **小说阅读**：横排左右翻页（浮现 / 滑动 / 淡入动画，书页跟手，宽屏双页）、上下滚动、竖排；字号、行距、页边距、段落间距、字体、配色；改排版时文字有过渡动画；目录、进度条；按住插画放大
- **划线与批注**：长按选字 → 复制、划线（四种颜色）、批注、查词、翻译、问助手、从这里朗读；书签和整页笔记；“摘录与批注”页按书汇总，可回到原文
- **阅读助手**：接 OpenAI 兼容接口（OpenAI、DeepSeek、通义、Kimi、Ollama 等），查词、翻译（可设默认目标语言）、提问；提示词可以改；可经服务器转发
- **听书**：系统语音（免费）或接口语音；一句一句读并高亮，自动翻页、自动进下一章；可调语速
- **统计**：每本书读了多久，按天 / 周 / 月的统计页
- **漫画**：翻页（默认日漫右翻，宽屏双页）或下拉长条
- **同步**：书籍文件、进度、合集、书签批注、书评、阅读时长。没下载的书边读边加载；读过或手动下载的书存在本机，离线也能读
- **安卓**：音量键翻页、系统语音朗读（由原生层提供）

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
| `SHIORI_KEY` | 必填 | 邀请码，至少 8 位。注册账号时要填，防止别人在你的服务器上开账号 |
| `OPEN_SIGNUP` | 不设 | 设为 `1` 时注册不需要邀请码 |
| `PORT` | `8787` | 监听端口 |
| `HOST` | `127.0.0.1` | 只监听本机，对外由 nginx 转发 |
| `DATA_DIR` | `server/data` | 书、封面和 `db.json` 的存放位置，备份这个目录即可 |
| `MAX_BOOK_MB` | `2048` | 单本书的大小上限 |

长期运行用 `server/shiori.service`（systemd），对外访问用 `server/nginx.conf.example` 配 HTTPS 反向代理。**请务必走 HTTPS**：密码和登录凭证是随请求发送的，而且安卓默认不允许应用访问明文 HTTP。

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

**从 0.4 升级到 0.5**：服务端改成了账号制。覆盖文件重启后，用客户端“注册账号”（邀请码就是原来的 SHIORI_KEY），**第一个注册的账号会自动接管原来的整个书库**。旧版客户端在升级前仍可用 SHIORI_KEY 访问这个账号。

用新的 `app/` 和 `server/server.js` 覆盖旧文件后重启服务即可，`DATA_DIR` 里的数据不用动，环境变量也没变（仍然是 `SHIORI_KEY`）。

## 关于云母效果

Windows 11 的客户端使用系统自带的云母（Mica）材质做窗口背景；Windows 10、安卓和网页版没有这个系统材质，用半透明毛玻璃模拟。

## 已知限制

- 文字不能选中复制，所以笔记是“记在某一页上”，不能划线高亮某一句；没有全文搜索。
- 竖排模式只能翻页，不能上下滚动，也没有双页。
- 只支持无 DRM 的 EPUB；不支持 PDF、MOBI、TXT、RAR/CBR。
- 单用户设计：一个密钥对应一个书架。
- 超过 4GB 的 ZIP64 压缩包不支持。
