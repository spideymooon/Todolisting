# TodoList — 极简桌面 TodoList

一个 Windows 桌面端的极简待办应用：看板式三列布局、全局捕获条、定时提醒（系统通知 + 微信推送）、桌面小组件，数据全部存本地。

> Electron + React 19 + TypeScript + SQLite（WASM），零原生编译依赖。

![tech](https://img.shields.io/badge/Electron-44-blue) ![tech](https://img.shields.io/badge/React-19-61dafb) ![tech](https://img.shields.io/badge/TypeScript-5.9-3178c6) ![tech](https://img.shields.io/badge/SQLite-WASM-green)

## 功能特性

### 任务管理
- **看板三列**：待办池 / 今日待完成 / 今日已完成，dnd-kit 拖拽跨列
- **四个列表页**：看板 / 全部任务 / 已完成 / 已逾期，任务搜索（标题 + 备注，防抖 + LIKE 转义）
- **任务编辑器**：备注、提醒时刻、快捷捕获

### 提醒与通知
- **提醒调度器**：每分钟 tick，到点触发；**每条任务计划只发送一次**（plan_key UNIQUE + upsert 幂等 + 单实例锁 + 崩溃恢复，四道防线）
- **Windows 桌面通知**：带 AppUserModelID 归组，点击通知定位任务
- **PushPlus 微信推送**：设置页扫码引导获取 Token，群组编码支持，失败可手动重发
- **提醒日志**：独立弹窗查看全部发送记录（待发/已发送/失败/跳过/取消），失败项一键重发

### 桌面集成
- **全局捕获条**：常驻屏幕顶部的小输入条，随时记录
- **桌面小组件**：透明挂件显示今日任务，支持置顶、五档透明度、位置记忆，与主窗实时同步
- **系统托盘**：常驻、品牌图标、快捷操作；关窗默认隐藏到托盘
- **开机启动**：设置内开关，与注册表状态双向同步

### 体验
- **无边框窗口**：自绘标题栏，保留 Aero Snap / 双击最大化 / DPI 缩放
- **深色主题**：跟随系统 / 浅色 / 深色 三档（nativeTheme.themeSource）
- **品牌图标**：单张源图生成窗口 / 任务栏 / 托盘 / exe 图标（`scripts/gen-icons.mjs`）
- **存储目录自定义**：设置页一键迁移数据文件

## 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 桌面框架 | Electron 44 | 主进程 / 渲染进程 / preload 三层隔离 |
| UI | React 19 + Zustand 5 | 无 Redux，轻量状态 |
| 构建 | electron-vite (Vite 7) | 主进程 / preload / 渲染统一构建 |
| 数据库 | node-sqlite3-wasm | SQLite 编译为 WASM，**零 node-gyp**，真实 `.sqlite` 文件 |
| 拖拽 | @dnd-kit/core | 看板跨列拖拽 |
| 测试 | Vitest | 领域逻辑单测（迁移 / 仓储 / 提醒调度等） |
| 打包 | electron-builder | NSIS 安装包 + 免安装版 |

架构设计详见 [docs/00-架构设计.md](docs/00-架构设计.md)（含 19 个章节的实施记录与踩坑笔记）。

## 本地开发

```bash
# 环境：Node 18+（推荐 22）
npm install

# 开发模式（带 HMR）
npm run dev

# 类型检查 / 单元测试
npm run typecheck
npm test

# 构建 + 打 Windows 安装包（输出到 dist/）
npm run dist
```

> 国内网络打包时如遇 NSIS 资源下载失败：
> `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`

## 项目结构

```
src/
├── main/                 # 主进程
│   ├── core/             #   数据库连接 / 迁移 / 任务仓储（纯领域层，不碰 Electron）
│   ├── services/         #   设置 / 提醒调度 / Windows 通知 / PushPlus
│   ├── system/           #   托盘 / AUMID 注册
│   ├── widgets/          #   桌面小组件窗口
│   └── ipc/              #   IPC 注册
├── preload/              # contextBridge 暴露的受控 API
├── renderer/
│   ├── main-window/      # 主窗：看板 / 列表 / 搜索 / 设置 / 编辑器
│   ├── widgets/          # 小组件渲染层
│   └── shared/           # 公共样式（浅/深色 Token）与 store
└── shared/               # 主-渲染共享类型与 IPC 常量
```

## 隐私

所有数据（任务、设置、Token）只保存在本机 SQLite，不上传任何服务器；PushPlus 推送经其官方 API 发送到你自己的微信。

## License

MIT
