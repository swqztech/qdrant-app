# Qdrant Viewer

Qdrant 桌面客户端（Electron + Vite + React）

基于 **Electron + electron-vite + React**，由原 Vite React Web 客户端改写为桌面应用。

## 使用

1. 安装依赖：`npm install`
2. 启动方式任选其一：
   - 双击桌面快捷方式 **Qdrant Viewer**（若没有，运行 `create-desktop-shortcut.bat`）
   - 双击 `start.bat`
   - 或命令行：`npm run dev`

- 渲染进程（开发）：Vite / Electron 窗口（端口 4356）
- 主进程内嵌 API：`http://127.0.0.1:4357`
