# LanTool

> 一个由 Vibe Coding 构建的局域网工具，采用 **Material Design 3 (MD3)** 设计风格，界面简洁流畅。

集成了以下功能：

- 💬 即时聊天
- 📁 文件传输
- 📋 剪贴板同步
- 🔗 网页推送

## 🚀 在线体验

👉 [https://eatmango233.github.io/LanTool/](https://eatmango233.github.io/LanTool/)

## 🔧 工作原理

LanTool 使用 [LocalSend](https://localsend.org) 的 WebSocket 服务器进行设备发现与配对。

## 📱 配对方式

提供两种配对方式，适应不同场景：

- **🔗 自动配对（推荐）**  
  通过 LocalSend 的 WebSocket 服务器自动发现同一局域网内的设备，无需手动输入，一键连接。

- **🔢 手动配对**  
  扫描二维码或输入配对码进行连接，适用于自动发现失败或需要精确指定设备的场景。

## 🏗️ 项目结构

```
LanTool/
├── index.html          # 主页面
├── manifest.json       # PWA 配置
├── sw.js               # Service Worker（离线支持）
├── js/                 # JavaScript 源码
├── style/              # 样式文件
└── LICENSE             # MIT 许可证
```

## 📄 许可证

[MIT](LICENSE)
