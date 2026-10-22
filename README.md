# herdr-agent-notifier

herdr 插件：记录 agent 完成（done）/需要输入（blocked）事件，**option+o（Alt+o）**
随时开关浮动通知列表，Enter 跳转到对应 pane。

替代 herdr 内置 toast 的两个痛点：toast 5 秒自动消失、点击常来不及。

## 交互设计（0.3.0）

- **默认不打开**——事件只写入状态文件，不弹任何东西
- **`Alt+o` toggle 浮层**（plugin action，`placement="popup"`，等价 zellij float：
  session 级浮窗、不进平铺布局、无 pane id）
- 列表内 **Enter / 1-9 跳转**：`pane.focus` → 清条目 → **异步** `popup.close`
  （fire-and-forget，不阻塞跳转）

## 工作方式

- `[[events]] on = "pane.agent_status_changed"` — `hooks/on-agent-status.js`：
  done/blocked 追加到 `~/.local/state/herdr/plugins/soraliu.agent-notifier/notifications.json`，
  其他状态（working/idle/unknown）移除该 pane 条目（正在干活的 agent 不占列表）
- `[[actions]] toggle`（`contexts = ["global"]`）— `hooks/toggle.js`：
  `plugin.pane.open`，遇 `ui_busy`（已有 popup）则 `popup.close` —— 即 toggle 语义
- `[[panes]] strip`（popup, 50% × 12 行）— `panes/strip.js`：500ms 轮询状态文件渲染

## 列表按键

| 键 | 行为 |
| --- | --- |
| Enter / 1-9 | 跳转到该 pane，清条目，异步关浮层 |
| ↑/↓ | 移动选择 |
| d | 清除当前条目（不跳转） |
| D | 清空全部 |
| q / Esc / Ctrl+C | 关闭浮层 |

## 状态与并发

`mutateState` 用 mkdir 原子锁串行化并发 hook（working→done 两事件可能 40ms 内
并发触发）；写入走 tmp+rename 原子替换。陈旧锁（>5s）自动接管。

## 已知限制

- toggle 判定依赖「本插件是唯一 popup 占用者」：Settings/Copy mode 等内建 modal
  打开时 `plugin.pane.open` 返回 `ui_busy`，toggle 会误关它（用户环境无此场景）。
- 条目上限 20 个。
- done 的判定依赖 herdr 的 seen 语义：焦点在目标 pane 的 tab 上时，完成会呈现为
  idle 而非 done，因此不会入列（此时用户正在看，无需提醒）。
- 通知本身不弹任何 UI（设计如此）；需要即时提示时依赖 herdr 内置 toast 共存。

## 安装

```bash
herdr plugin install soraliu/herdr-agent-notifier
```

键位（`~/.config/herdr/config.toml`）：

```toml
[[keys.command]]
command = "soraliu.agent-notifier.toggle"
description = "Toggle agent notification list"
key = "alt+o"
type = "plugin_action"
```

nixfiles 已在 herdr 模块 activation 中幂等接入（install-if-missing，判据 `github:soraliu/herdr-agent-notifier` 源已注册），键位随 herdrConfig 声明。本地开发：`herdr plugin unlink soraliu.agent-notifier && herdr plugin link ~/Github/herdr-agent-notifier`。
