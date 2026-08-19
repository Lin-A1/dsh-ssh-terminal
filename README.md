# dsh-ssh-terminal

Persistent SSH remote terminal plugin for [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness). Keeps one `ssh2` shell channel alive across multiple model tool calls — `cwd` / env / REPL state persists — while the **target host is chosen dynamically at call time** and gated by an optional deployment allowlist.

> 归类建议：`plugins/terminal` 或 `plugins/shell`。当前仓库独立开发，验证通过 `dsh plugin add ./path` 后再以 submodule 接入 `dsh-hub`。

## 适用版本

- 基于 `deepseek-harness` **0.1.0-rc.7** (`99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`, tag `dsh-v0.1.0-rc.7`) 开发与验证。
- 要求 Node `>=22`、`@deepseek-ai/cordis ^4.0.1`、`@deepseek-ai/dsh-tools ^0.1.0-rc.7` 与宿主单例共享（见 `package.json` peer/dev 一致性），`ssh2 ^1.17.0`、`@deepseek-ai/schemastery ^3.18.1`。
- 若上游 harness 升级，需重新验证 `ssh2` 通道、哨兵协议与 `defineTool` / `ToolDefinition` 契约是否变化。

## 能力与工具

| 工具 | 作用 |
|---|---|
| `ssh_terminal_open` | 按 `host/user/port/identityFile/password` 动态建连，建一个持久 shell；返回 `terminalId` + 启动 banner |
| `ssh_terminal_send` | 向指定终端写入文本；`submit=true` 时追加 `printf '<sentinel>:%s\n' "$?"` 并等待哨兵证明命令结束，`submit=false` 时按静默窗口回落 |
| `ssh_terminal_read` | 不发输入，按 `offset/count` 分页读取保留的 scrollback |
| `ssh_terminal_list` | 列出全部存活会话快照 |
| `ssh_terminal_close` | 关闭单会话及底层连接 |

所有会话由 `SshTerminalManager` 统一持有，插件 fiber dispose 时 `ctx.effect` 自动 `closeAll()`。

## 安装

```sh
# 本地开发验证（推荐）
dsh plugin add ./dsh-ssh-terminal --profile <name>

# GitHub 安装（首次需在 $DSH_HOME/profiles/<name>/pnpm-workspace.yaml 放行构建）
dsh plugin add github:Lin-A1/dsh-ssh-terminal --profile <name>
# 可信安装建议 pin commit：
dsh plugin add github:Lin-A1/dsh-ssh-terminal#<sha> --profile <name>

# npm（若已发布带 lib/ 的包则无需 allowBuilds）
dsh plugin add dsh-ssh-terminal --profile <name>
```

`prepare` 会在 GitHub 安装时自动 `pnpm run build` 产出 `lib/`。

## 配置

`cordis.patch.yml` 默认：

```yaml
- insert:
    - id: ssh-terminal
      name: dsh-ssh-terminal
      config:
        allowlist: []              # 空=允许任意 host；非空时仅放行精确匹配或 *.suffix
        maxSessions: 8
        defaultPort: 22
        connectTimeoutMs: 15000
        idleMs: 800                # submit=false 时的静默判定窗口
        sendTimeoutMs: 30000
        maxScrollbackBytes: 1048576
        maxResultBytes: 131072     # 单次完整 tool result（含包装）的字节上限
```

`Config` 由 `@deepseek-ai/schemastery` 校验，见 `src/index.ts:Config`。

## 持久终端与动态主机的安全注意事项

- **持久性风险**：连接在多次 `ssh_terminal_send` 之间保持，远端 shell 状态（`cwd`、环境变量、后台任务、交互式程序）会累积；务必通过 `ssh_terminal_close` / 插件卸载及时回收，`maxSessions` 与 `maxScrollbackBytes` 为部署侧兜底上限，`maxResultBytes` 对完整渲染结果做最终截断。
- **动态主机 = 部署侧边界**：`host/user/port/identityFile/password` 均由模型调用时指定，**`allowlist` 是唯一的部署侧访问控制**。`[]` 为开发便利的「全放行」；生产环境必须显式列出可信主机（支持 `example.com` 精确、`*.example.com` 单级/多级子域、`*.suffix` 匹配自身、` *` 通配）；大小写不敏感，匹配见 `src/allowlist.ts:hostAllowed`。
- **凭证处理**：优先 `identityFile`（本地私钥文件路径），`password` 仅在必要时使用；两者均不在结果中回显，`presentCall` 仅展示 `user@host`。不要将私钥或口令写入 profile 的 `cordis.patch.yml` 明文值中，改用环境或宿主隔离。
- **网络与执行边界**：`connectTimeoutMs` / `sendTimeoutMs` / `idleMs` 约束建连与等待；`submit=false` 的 `inferred_idle` / `timeout` 不证明命令已退出；哨兵 `__DSHSSH_DONE_*__` / `__DSHSSH_READY_*__` 依赖远端 shell 对 `printf` 的支持。
- **工作区隔离**：插件自带 `pnpm-workspace.yaml`，切勿与 `dsh-hub` 或 `deepseek-harness` 的 workspace 合并；profile 安装的 `pnpm-workspace.yaml` 是唯一合并点。

## 开发

```sh
npx pnpm install
npx pnpm run build        # tsdown -> lib/
npx pnpm run typecheck    # tsc --noEmit
npx pnpm run lint         # oxlint src tests
npx pnpm test             # vitest run（tests/ 为空时直接通过）
```

发布前自检 `dsh plugin add` 是否在全新 profile 上干净安装。

## 上游跟踪

- 上游：`deepseek-ai/deepseek-harness` `master`，当前 pin `99f6f02`。
- 插件协议：`docs/user/develop/basic/publish.md`、`packages/AGENTS.md`（Loader 对 `name`/`inject`/`Config`/`apply` 的命名导出要求、peer 单例约束）。
