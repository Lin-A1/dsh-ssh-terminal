# AGENTS.md — dsh-ssh-terminal

Plugin-local conventions for the persistent SSH remote terminal.

## Scope

- Runtime: Node `>=22`, host fiber only. No web `lib/client.js` face.
- Loader contract: named exports `name` / `inject` / `Config` / `apply` only — no `default` export. `inject = ['tools']`; registrations via `ctx.effect` / `ctx.tools.register`; disposal closes all sessions.

## Repository shape invariants

- `package.json`: `private: true`, `type: module`, `main: lib/index.js`, `exports["."]` typed, `files: [lib/, cordis.patch.yml]`, `dsh.bundle.patch: ./cordis.patch.yml`, scripts `build` (`tsdown`), `prepare` (`pnpm run build`), `typecheck` (`tsc --noEmit`), `lint` (`oxlint src tests`), `test` (`vitest run`). `@deepseek-ai/cordis` in both `peerDependencies` and `devDependencies` same range (`^4.0.1`); `@deepseek-ai/schemastery` in `dependencies`; `@deepseek-ai/dsh-tools` peer+dev.
- `pnpm-workspace.yaml` is plugin-local (`packages: [.]`). Never merge into `dsh-hub` or `deepseek-harness`; profile's `pnpm-workspace.yaml` is the only merge point.
- `cordis.patch.yml`: single `- insert` with stable `id: ssh-terminal`, `name: dsh-ssh-terminal`. Config keys match `Config` schema defaults.

## Design choices

- Target host is model-chosen per `ssh_terminal_open` call (`host/user/port/identityFile/password`); deployment gates via `allowlist` (`src/allowlist.ts:hostAllowed`): empty = unrestricted, `*` = any, `*.suffix` = suffix + subdomains, case-insensitive. Only enforcement point.
- One `ssh2` `Client` + one PTY `shell` per terminal (`src/ssh2.ts:connectSsh2`). `cols: 220, rows: 50`, `term: xterm-256color`.
- Sentinel protocol (`src/sentinel.ts`): `submit=true` appends `printf '<token>:%s\n' "$?"`; `stripSentinel` extracts `exitCode` and removes marker line. Readiness probe optionally `stty -echo` then `printf` ready token.
- Bounded buffers: per-session `maxScrollbackBytes` (trim at ~½ on `\n`), per-result `maxResultBytes` via `render.ts:boundText` (UTF-8 byte-aware, char-boundary safe). Pending-send guard prevents concurrent `send` on same terminal.

## Testing

- Tests live under `tests/` (not `src/__tests__`). Use scripted `ConnectFn` fake injected into `createTools` / `apply` — no real SSH in CI. `SshTerminalManager` and `SshTerminalSession` are unit-testable via fake `SshConnection`/`ShellChannel`.

## Verification before hub PR

```sh
npx pnpm install
npx pnpm run build
npx pnpm run typecheck
npx pnpm run lint
npx pnpm test
```

Then `dsh plugin add ./dsh-ssh-terminal` against a fresh profile on `deepseek-harness 0.1.0-rc.7 (99f6f02)` must install cleanly and show `ssh-terminal` layer in `dsh --dump-config`.
