# DeskTopToDoList · 桌面待办看板

一个可固定在 Windows 桌面上的待办小工具：文字待办 + 图片卡片混排，**图片里的 DDL 会自动识别成带提醒的待办**。基于 Electron，数据全部本地存储，不联网、不需要 API Key。

## 功能

- **固定桌面**：一键在「窗口置顶」和「贴桌面层（不遮挡其他窗口）」之间切换
- **文字待办**：直接编辑、勾选完成、设置截止时间
- **图片卡片**：点 🖼 选图，或直接把图片**拖进窗口**；支持多张
- **图片 OCR 自动识别 DDL**：
  - 用 Windows 自带 OCR 离线识别图中文字（中英文均可）
  - 从文字里甄别出真正带日期/时间的待办，过滤页码、地点等噪音
  - 对日程表类图片，用坐标把每门课/事件和它左侧的日期精确配对
  - 识别结果以清单形式弹出，**默认全选、可直接改文字和时间**，确认后导入成文字待办
- **到点提醒**：Windows 桌面通知（提前 10 分钟 + 到点各一次），临近截止卡片变红显示倒计时
- **紧凑清单**：新内容追加到末尾，不再顶掉旧内容；图片可折叠显示
- 拖动标题栏移动窗口、拖右下角缩放，位置和尺寸自动记忆
- 系统托盘常驻，可设开机自启

## 启动

需要 Node.js（v16+）。

```bash
npm install
npm start
```

Windows 上也可直接双击 **`启动看板.bat`**（它会清掉可能干扰 Electron 的环境变量）。

打包成 exe：

```bash
npm install -g electron-builder
npx electron-builder --win
```

## 数据

所有数据存在 `%APPDATA%/desktop-todo-board/` 下：

- `board.json` — 看板内容（文字、图片卡片、识别结果）
- `settings.json` — 窗口位置、尺寸、固定模式
- `images/` — 你添加的图片副本
- `notified.json` — 已提醒记录（避免重复提醒）

## 实现要点

- `main.js` — Electron 主进程：窗口管理、图层切换、托盘、通知、IPC、文件存储
- `preload.js` — 安全的 contextBridge IPC 桥
- `renderer/` — 界面与交互：`app.js` 含 DDL 解析、OCR 候选甄别、坐标日期配对
- `ocr.ps1` / `ocr-digit.ps1` — 调用 Windows WinRT OCR；对大号孤立日期数字用「裁剪缩小 + 拼接文本行」二次识别
- `desktop-layer.ps1` — 通过 P/Invoke 把窗口挂到 Explorer 的 WorkerW（贴桌面）或解除（置顶）

## 已知限制

- 仅 Windows（依赖 WinRT OCR 与 WorkerW 桌面层）
- OCR 精度取决于图片清晰度；识别结果都可手动修改
- 日期识别对「日程表 + 左侧日期列」这类版式做了专门优化，其他版式可能需手动校正

## License

MIT
