# herdr-agent-notifier

herdr 插件：记录 agent 完成（done）/需要输入（blocked）事件，**option+o（Alt+o）**
随时开关浮动通知列表，Enter 跳转到对应 pane。

替代 herdr 内置 toast 的两个痛点：toast 5 秒自动消失、点击常来不及。

## 交互设计（0.4.0）

- **默认不打开**——事件只写入状态文件，不弹任何东西
- **`Alt+o` toggle 浮层**（plugin action，`placement="popup"`，等价 zellij float：
  session 级浮窗、不进平铺布局、无 pane id）
- 列表内 **Enter / 1-9 跳转**：`pane.focus` → 清条目 → **异步** `popup.close`
  （fire-and-forget，不阻塞跳转）

## 工作方式


- `[[events]] on = "pane.agent_status_changed"` — `hooks/on-agent-status.js`：
  **任何完成轮次**（`working → idle/done`，无论用户是否在看该 tab——herdr 对已 seen
  的 pane 报 `idle` 而非 `done`，两者都是完成）与 `blocked` 入列
  `~/.local/state/herdr/plugins/soraliu.agent-notifier/notifications.json`。
  初始 `idle`（agent 启动，之前无 working）不入列。条目只由用户操作
  （Enter 跳转 / `d` / `D`）清除，**不因后续状态变化自动移除**。
- `[[events]] on = "pane.exited"` — pane 关闭时移除该 pane 条目与 working 标记。
- `[[actions]] toggle`（`contexts = ["global"]`）— `hooks/toggle.js`：
  `plugin.pane.open`，遇 `ui_busy`（已有 popup）则 `popup.close` —— 即 toggle 语义
- **popup 开着时 `option+o`（Alt+o）在 popup 内部处理**：popup 拥有全部键盘输入，
  herdr 键位不再触发；`panes/strip.js` 收到 `ESC o` 字节后自行 `popup.close`，
  保证 toggle 双向可用。**打开后 700ms 内的输入被忽略**——触发键自身的字节会被
  herdr 转发进刚聚焦的 popup，不吞掉它 popup 会在打开 ~1 秒后自杀（表现为
  「打开后闪一下就没了/看不到条目」）；裸 ESC 按住 80ms 等待后续分块合并
  （alt+o 可能分两个 chunk 到达）。

## 列表按键

| 键 | 行为 |
| --- | --- |
| Enter / 1-9 | 跳转到该 pane，清条目，异步关浮层 |
| option+o (Alt+o) | 关闭浮层（popup 内部接管，等同 toggle off） |
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
- 打开后 700ms 内的按键会被防抖吞掉（见「工作方式」）；需要立刻关闭时再按一次。
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
