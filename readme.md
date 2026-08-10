# LanTool

> 一个由 Vibe Coding 构建的局域网工具

集成了以下功能：

- 💬 即时聊天
- 📁 文件传输
- 📋 剪贴板同步
- 🔗 网页推送

## 🚀 在线体验

👉 [https://eatmango233.github.io/LanTool/](https://eatmango233.github.io/LanTool/)

## 🔧 工作原理

LanTool 使用 [LocalSend](https://localsend.org) 的 WebSocket 服务器进行设备配对，因此配对时需要能够访问公网。

## 📱 配对方式

支持两种配对方式：

- 扫描二维码
- 输入配对码

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
