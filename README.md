用 DOM 句柄驱动 DSH 右上角的网易云音乐卡片，**不依赖 vendor 插件的内部实现**。

原做法是给 `node_modules/dsh-netease-music` 打补丁，升级一次全丢。现在改成认卡片自己
暴露的东西：`.nm-card`、`button[aria-label="下一首"]`、`input.nm-range`……

## 提供什么

- 一个对话工具 `netease_music`：`play` / `search` / `pause` / `next` / `prev` / `volume` / `status` / `open` / `close`
  —— 你在对话框里说「放一首许嵩的庐州月」，走的就是它
- 两个遥控器 owner 注册到 `dsh-remote-hub`：媒体键与左右切歌

## 已知取舍

- 点歌是「填搜索框 → 回车 → 等新结果行出现 → 点第一行」，因为卡片的回车只搜索不播放
- 卡片的 `ended` 会让 vendor 用「账号最近播放」覆盖队列，这是 vendor 的行为，本插件不介入

## 安装

```powershell
plugin_manager install_bundle target=<这个目录的绝对路径>
```

需要先装 [dsh-remote-hub](https://github.com/lingr7/dsh-remote-hub) 才能接遥控器（工具部分可独立使用）。
