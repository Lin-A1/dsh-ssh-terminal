import { describe, expect, it } from 'vitest'
import { hostAllowed } from '../src/allowlist.ts'
import { SshTerminalManager } from '../src/manager.ts'
import { SshTerminalSession } from '../src/session.ts'
import type { ShellChannel, SshConnection } from '../src/types.ts'

class FakeShell implements ShellChannel {
  readonly writes: string[] = []
  private dataListeners: ((chunk: string) => void)[] = []
  private closeListeners: (() => void)[] = []

  write(data: string): void {
    this.writes.push(data)
    const ready = /printf '(__DSHSSH_READY_[A-Za-z0-9_]+__)\\n'/.exec(data)?.[1]
    const done = /printf '(__DSHSSH_DONE_[A-Za-z0-9_]+__):%s\\n'/.exec(data)?.[1]
    if (ready !== undefined) this.emit(`welcome\n${ready}\n`)
    if (done !== undefined) this.emit(`command output\n${done}:7\n`)
    if (ready === undefined && done === undefined) this.emit('raw input output\n')
  }

  close(): void {
    for (const listener of this.closeListeners) listener()
  }

  onData(listener: (chunk: string) => void): void {
    this.dataListeners.push(listener)
  }

  onClose(listener: () => void): void {
    this.closeListeners.push(listener)
  }

  private emit(chunk: string): void {
    for (const listener of this.dataListeners) listener(chunk)
  }
}

class FakeConnection implements SshConnection {
  readonly shell = new FakeShell()
  closeCount = 0

  async openShell(): Promise<ShellChannel> {
    return this.shell
  }

  close(): void {
    this.closeCount += 1
  }
}

const options = {
  echo: false,
  maxScrollbackBytes: 1024,
}

describe('SSH terminal policy and session lifecycle', () => {
  it('enforces exact and wildcard allowlist entries', () => {
    expect(hostAllowed('db.example.com', ['DB.EXAMPLE.COM'])).toBe(true)
    expect(hostAllowed('nested.db.example.com', ['*.example.com'])).toBe(true)
    expect(hostAllowed('example.com', ['*.example.com'])).toBe(true)
    expect(hostAllowed('other.example.net', ['*.example.com'])).toBe(false)
    expect(hostAllowed('anything.test', [])).toBe(true)
  })

  it('rejects a disallowed host before opening a connection', async () => {
    let connectCalls = 0
    const manager = new SshTerminalManager({
      allowlist: ['*.trusted.example'],
      maxSessions: 2,
      defaultPort: 22,
      connectTimeoutMs: 100,
      maxScrollbackBytes: 1024,
      connect: async () => {
        connectCalls += 1
        return new FakeConnection()
      },
    })

    await expect(manager.open({ host: 'evil.example', user: 'tester' }))
      .rejects.toThrow('not in the configured allowlist')
    expect(connectCalls).toBe(0)
  })

  it('keeps a shell alive across sends, bounds reads, and closes both handles', async () => {
    const connection = new FakeConnection()
    const { session, motd } = await SshTerminalSession.start(
      'ssh-term-1',
      { host: 'trusted.example', user: 'tester', port: 22 },
      connection,
      options,
      100,
    )

    expect(motd).toBe('welcome')
    const submitted = await session.send({ data: 'printf hello', submit: true, idleMs: 10, timeoutMs: 100 })
    expect(submitted).toMatchObject({
      output: 'command output',
      waitReason: 'command_done',
      exitCode: 7,
      status: 'running',
    })

    const raw = await session.send({ data: 'partial', submit: false, idleMs: 1, timeoutMs: 100 })
    expect(raw.waitReason).toBe('inferred_idle')
    expect(raw.output).toContain('raw input output')
    const page = session.read(0, 2)
    expect(page.text).toBe('raw input output\n')
    expect(page.lineEnd - page.lineBegin).toBe(2)

    expect(await session.close()).toBe(true)
    expect(await session.close()).toBe(false)
    expect(connection.closeCount).toBe(2)
    expect(session.snapshot().status.kind).toBe('exited')
  })
})
