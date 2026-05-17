# claude-pet — 狐獴桌宠

四只狐獴（Scout / Knox / Bubbles / Pip）实时盯着你的 Claude Code 会话，把 hook 事件画成桌面动画。

## 角色

| 狐獴    | 占位道具 | 触发                                       |
| ------- | -------- | ------------------------------------------ |
| Scout   | 🔭       | 所有 Claude Code 事件，呈现会话状态        |
| Knox    | 🔔       | `Notification` hook（等待确认）            |
| Bubbles | 💧       | 本地计时器（默认 45 分钟提醒一次喝水）     |
| Pip     | 🎉       | `Stop` hook（任务完成时撒花，30 秒去重）   |

## 安装

两种方式任选。装好之后还得跑一次 hook 注入（B 方式自带），才能让 Claude Code 把事件推到 pet。

### A. 从 GitHub Release 下载 .app（仅 macOS）

1. 打开 [Releases](https://github.com/summer95950905-hue/claude-pet/releases)，按机型挑文件下载：
   - Apple Silicon (M1/M2/M3/M4)：`claude-pet-<version>-arm64.dmg`
   - Intel Mac：`claude-pet-<version>.dmg`
   - 不想用 dmg 的话 `*-mac.zip` 也是同一个 .app。
2. 打开 .dmg，把 **claude-pet.app** 拖进 `/Applications`。
3. 首次启动：在 Finder 里**右键 → 打开 → 确认打开**（应用未签名，需手动绕过 Gatekeeper，只需一次）。
4. 注入 Claude Code hooks：当前版本还没把这一步做进托盘菜单，需要单独跑一下：
   ```bash
   curl -fsSL https://raw.githubusercontent.com/summer95950905-hue/claude-pet/main/hooks/install-hooks.js | node
   ```
   或者下载 `hooks/install-hooks.js` 后 `node install-hooks.js` 执行。脚本会自动备份 `~/.claude/settings.json` 到 `~/.claude/settings.json.deskpet-backup`。

### B. 从源码运行（开发 / 自己改）

需要本机有 Node 18+。

```bash
git clone git@github.com:summer95950905-hue/claude-pet.git
cd claude-pet
npm install
npm run install-hooks   # 注入 hooks 到 ~/.claude/settings.json（自动备份）
npm start               # 启动桌宠
```

启动后右下角出现 4 只狐獴。托盘图标可以 Show/Hide、切尺寸、退出。

## 卸载 hooks

```bash
# 源码方式
npm run uninstall-hooks

# 或仅有 install-hooks.js 时
node hooks/install-hooks.js --uninstall
```

会还原回 `~/.claude/settings.json` 中 claude-pet 注入前的状态。原始备份在 `~/.claude/settings.json.deskpet-backup`。

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
