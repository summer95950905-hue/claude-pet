# deskpet — 狐獴桌宠 MVP α

四只狐獴盯着你的 Claude Code 会话。占位形象用 emoji，先跑通链路。

## 角色

| 狐獴    | 占位道具 | 触发                                       |
| ------- | -------- | ------------------------------------------ |
| Scout   | 🔭       | 所有 Claude Code 事件，呈现会话状态        |
| Knox    | 🔔       | `Notification` hook（等待确认）            |
| Bubbles | 💧       | 本地计时器（默认 45 分钟提醒一次喝水）     |
| Pip     | 🎉       | `Stop` hook（任务完成时撒花，30 秒去重）   |

## 跑起来

```bash
cd /Users/ryan/deskpet
npm install        # 装 electron
npm run install-hooks   # 往 ~/.claude/settings.json 注入 hooks（自动备份）
npm start          # 启动桌宠
```

启动后右下角会出现 4 只狐獴，菜单栏图标可以「Show/Hide」「Simulate」「Quit」。
没有 Claude Code 也能用菜单里的 Simulate 项测各状态。

## 卸载 hooks

```bash
npm run uninstall-hooks
```

会还原回 `~/.claude/settings.json` 中 deskpet 注入前的状态。
原始备份在 `~/.claude/settings.json.deskpet-backup`。

## 架构

```
Claude Code session
    └── hooks (Notification / Stop / PreToolUse / ...)
          └── curl POST → http://127.0.0.1:8765/event  (X-Hook: <event>)
                └── Electron main → IPC → renderer
                      └── state machine → 4 meerkats
```

- `main.js` — Electron 主进程，透明置顶窗口 + HTTP 接收器 + 菜单栏图标
- `preload.js` — IPC 桥
- `renderer/` — 4 只狐獴 + 状态机 + 动画
- `hooks/install-hooks.js` — settings.json 注入 / 卸载

## 已知 MVP α 限制

- 形象是 emoji，β 阶段换像素 sprite / Lottie
- 点 Knox 暂时只显示气泡，还没接 macOS terminal focus（AppleScript 待补）
- Stale 阈值固定 60 秒，喝水间隔固定 45 分钟，settings 面板待做
- 只追最近一个 Claude Code 会话（多会话 v2.1+）
- 没做高风险命令识别，所有 `Notification` 一律提醒

## 调试

- 手动触发：右键菜单栏 → Simulate
- 看 hook 是否落到 server：`curl -X POST -H 'X-Hook: Stop' http://127.0.0.1:8765/event`
- 看 hooks 是否装上：`cat ~/.claude/settings.json | grep deskpet-hook`
