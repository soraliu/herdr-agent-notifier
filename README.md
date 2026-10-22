# herdr-agent-notifier

herdr 插件：agent 完成任务（done）或需要输入（blocked）时，在常驻 strip pane 中显示，
永不自动消失；在 strip 内按 Enter（或数字键）跳转到对应 pane。

替代 herdr 内置 toast 的两个痛点：toast 5 秒自动消失、点击常来不及。

## 工作方式

- `[[events]] on = "pane.agent_status_changed"` — 每次状态变化触发 `hooks/on-agent-status.js`：
  done/blocked 加入 `~/.local/state/herdr/plugins/soraliu.agent-notifier/notifications.json`，
  其他状态（working/idle/unknown）移除该 pane 的条目。
- **自动打开**：done/blocked 时 hook 经 socket 调 `plugin.pane.open`（split 下方、
  `focus:false` 不抢焦点）打开 strip；已开（`state.strip_pane_id` 存活）则跳过。
  关闭后下一个事件自动重开。并发 done 经异步锁串行化，不会重复开。
- `[[panes]] strip` — `panes/strip.js` 常驻 TUI，500ms 轮询状态文件渲染列表。
- 跳转：`pane.focus`（经 `HERDR_SOCKET_PATH` 的 newline-delimited JSON RPC）。

## strip 按键

| 键 | 行为 |
| --- | --- |
| Enter / 1-9 | 跳转到该 pane 并清除条目 |
| ↑/↓ | 移动选择 |
| d | 清除当前条目（不跳转） |
| q / Esc / Ctrl+C | 关闭 strip（下一个 done/blocked 事件自动重开） |

## 状态与并发

`mutateState` 用 mkdir 原子锁串行化并发 hook（working→done 两个事件可能 40ms 内
并发触发）；写入走 tmp+rename 原子替换。陈旧锁（>5s）自动接管。

## 已知限制

- 条目上限 20 个。
- done 的判定依赖 herdr 的 seen 语义：焦点在目标 pane 的 tab 上时，完成会呈现为
  idle 而非 done，因此不会入列（此时用户正在看，无需提醒）。

## 安装

```bash
herdr plugin install soraliu/herdr-agent-notifier
```

nixfiles 已在 herdr 模块 activation 中幂等接入（install-if-missing，判据 `github:soraliu/herdr-agent-notifier` 源已注册）。本地开发：`herdr plugin unlink soraliu.agent-notifier && herdr plugin link ~/Github/herdr-agent-notifier`。
