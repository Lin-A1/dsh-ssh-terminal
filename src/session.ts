/**
 * One persistent SSH terminal session: an ssh2 shell channel with a PTY, a
 * bounded scrollback buffer, and sentinel-based command boundary detection.
 * @module dsh-ssh-terminal/session
 */

import type { ReadResult, SendResult, SessionSnapshot, SessionStatus, ShellChannel, SshConnection } from './types.ts'
import { createDoneToken, createReadyToken, stripMarkerLines, stripSentinel } from './sentinel.ts'

const encoder = new TextEncoder()

/** Per-session behavior knobs resolved by the manager. */
export interface SessionOptions {
  /** Keep remote PTY echo on (default false; startup runs `stty -echo`). */
  echo: boolean
  /** Maximum UTF-8 bytes of retained scrollback. */
  maxScrollbackBytes: number
}

/** One ssh_terminal_send invocation. */
export interface SendRequest {
  data: string
  submit: boolean
  idleMs: number
  timeoutMs: number
  signal?: AbortSignal
}

interface WaitRequest {
  mark: number
  token?: string
  idleMs: number
  timeoutMs: number
  signal?: AbortSignal
}

/**
 * A persistent remote shell. At most one send is in flight at a time; a second
 * concurrent send is rejected so command boundaries stay unambiguous.
 */
export class SshTerminalSession {
  private buf = ''
  private trimmedChars = 0
  private seq = 0
  private pending = false
  private readonly dataListeners = new Set<() => void>()
  private readonly closeListeners = new Set<() => void>()
  private closed = false
  private status: SessionStatus = { kind: 'running' }

  private constructor(
    private readonly id: string,
    private readonly meta: { host: string; user: string; port: number; name?: string },
    private readonly connection: SshConnection,
    private readonly shell: ShellChannel,
    private readonly options: SessionOptions,
  ) {
    shell.onData(chunk => this.feed(chunk))
    shell.onClose(() => this.handleClose())
  }

  /**
   * Open the shell channel, run the readiness probe (optionally disabling PTY
   * echo), and return the live session plus the startup banner.
   * @param id - manager-assigned terminal id.
   * @param meta - model-facing connection facts.
   * @param connection - established SSH connection.
   * @param options - session behavior knobs.
   * @param probeTimeoutMs - startup readiness deadline.
   */
  static async start(
    id: string,
    meta: { host: string; user: string; port: number; name?: string },
    connection: SshConnection,
    options: SessionOptions,
    probeTimeoutMs: number,
  ): Promise<{ session: SshTerminalSession; motd: string }> {
    const shell = await connection.openShell()
    const session = new SshTerminalSession(id, meta, connection, shell, options)
    try {
      const motd = await session.probe(probeTimeoutMs)
      return { session, motd }
    }
    catch (error) {
      connection.close()
      throw error
    }
  }

  private get pos(): number {
    return this.trimmedChars + this.buf.length
  }

  private feed(chunk: string): void {
    this.buf += chunk.replace(/\r\n/g, '\n')
    if (encoder.encode(this.buf).byteLength > this.options.maxScrollbackBytes) {
      const cut = this.buf.indexOf('\n', Math.floor(this.buf.length / 2))
      if (cut > 0) {
        this.buf = this.buf.slice(cut + 1)
        this.trimmedChars += cut + 1
      }
    }
    for (const listener of [...this.dataListeners]) listener()
  }

  private handleClose(): void {
    if (this.status.kind === 'exited') return
    this.status = { kind: 'exited', exitCode: null, signal: null }
    for (const listener of [...this.closeListeners]) listener()
  }

  private sliceFrom(mark: number): { text: string; truncated: boolean } {
    const rel = mark - this.trimmedChars
    if (rel <= 0) return { text: this.buf, truncated: this.trimmedChars > 0 }
    return { text: this.buf.slice(rel), truncated: false }
  }

  private probe(timeoutMs: number): Promise<string> {
    const token = createReadyToken(this.id)
    const prefix = this.options.echo ? '' : 'stty -echo; '
    const mark = this.pos
    return new Promise((resolve, reject) => {
      const onData = (): void => {
        const { text } = this.sliceFrom(mark)
        if (!text.includes(token)) return
        cleanup()
        resolve(stripMarkerLines(text, token))
      }
      const onClose = (): void => {
        cleanup()
        reject(new Error(`ssh terminal ${this.id}: remote shell closed during startup`))
      }
      const timer = setTimeout(() => {
        cleanup()
        resolve(stripMarkerLines(this.sliceFrom(mark).text, token))
      }, timeoutMs)
      const cleanup = (): void => {
        clearTimeout(timer)
        this.dataListeners.delete(onData)
        this.closeListeners.delete(onClose)
      }
      this.dataListeners.add(onData)
      this.closeListeners.add(onClose)
      this.shell.write(`${prefix}printf '${token}\\n'\n`)
    })
  }

  /**
   * Write input to the remote shell and wait for the command boundary, output
   * silence, the timeout, or session exit.
   * @param req - input text, submit mode, deadlines, and caller cancellation.
   * @returns the captured output since this send, with the marker stripped.
   */
  async send(req: SendRequest): Promise<SendResult> {
    if (this.closed || this.status.kind === 'exited') {
      throw new Error(`ssh terminal ${this.id} is closed`)
    }
    if (this.pending) {
      throw new Error(`ssh terminal ${this.id} already has a send in flight; wait for it to settle or open another terminal`)
    }
    if (req.signal?.aborted) throw new Error('ssh terminal send aborted')
    this.pending = true
    try {
      const mark = this.pos
      let token: string | undefined
      if (req.submit) {
        token = createDoneToken(this.id, ++this.seq)
        this.shell.write(`${req.data}\nprintf '${token}:%s\\n' "$?"\n`)
      }
      else {
        this.shell.write(req.data)
      }
      return await this.wait({ mark, token, idleMs: req.idleMs, timeoutMs: req.timeoutMs, signal: req.signal })
    }
    finally {
      this.pending = false
    }
  }

  private wait(req: WaitRequest): Promise<SendResult> {
    return new Promise((resolve, reject) => {
      let idleTimer: NodeJS.Timeout | undefined
      const finish = (waitReason: SendResult['waitReason'], exitCode: number | null = null): void => {
        cleanup()
        const { text, truncated } = this.sliceFrom(req.mark)
        let output = text
        if (req.token !== undefined) {
          const stripped = stripSentinel(text, req.token)
          if (stripped !== undefined) output = stripped.text
        }
        resolve({ output, waitReason, exitCode, status: this.status.kind, truncated })
      }
      const onData = (): void => {
        if (req.token !== undefined) {
          const { text } = this.sliceFrom(req.mark)
          const hit = stripSentinel(text, req.token)
          if (hit !== undefined) {
            finish('command_done', hit.exitCode)
            return
          }
        }
        else {
          restartIdle()
        }
      }
      const onClose = (): void => finish('session_exit')
      const onAbort = (): void => {
        cleanup()
        reject(new Error('ssh terminal send aborted'))
      }
      const restartIdle = (): void => {
        if (req.token !== undefined) return
        if (idleTimer !== undefined) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => finish('inferred_idle'), req.idleMs)
      }
      const timeoutTimer = setTimeout(() => finish('timeout'), req.timeoutMs)
      const cleanup = (): void => {
        if (idleTimer !== undefined) clearTimeout(idleTimer)
        clearTimeout(timeoutTimer)
        this.dataListeners.delete(onData)
        this.closeListeners.delete(onClose)
        req.signal?.removeEventListener('abort', onAbort)
      }
      this.dataListeners.add(onData)
      this.closeListeners.add(onClose)
      req.signal?.addEventListener('abort', onAbort)
      restartIdle()
      onData()
    })
  }

  /**
   * Read a newest-relative page of retained scrollback without sending input.
   * @param offset - lines to skip from the newest end (default 0).
   * @param count - maximum lines to return.
   */
  read(offset: number, count: number): ReadResult {
    const lines = this.buf.split('\n')
    const totalLines = lines.length
    const end = Math.max(0, totalLines - Math.max(0, offset))
    const begin = Math.max(0, end - Math.max(1, count))
    return {
      text: lines.slice(begin, end).join('\n'),
      totalLines,
      lineBegin: begin,
      lineEnd: end,
      truncated: this.trimmedChars > 0,
    }
  }

  /**
   * Close the shell channel and the underlying connection.
   * @returns false when the remote side had already ended the session.
   */
  async close(): Promise<boolean> {
    const wasRunning = this.status.kind === 'running' && !this.closed
    this.closed = true
    if (wasRunning) {
      this.shell.close()
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.closeListeners.delete(onClosed)
          resolve()
        }, 5000)
        const onClosed = (): void => {
          clearTimeout(timer)
          resolve()
        }
        this.closeListeners.add(onClosed)
      })
    }
    this.connection.close()
    this.handleClose()
    return wasRunning
  }

  /** Current model-facing snapshot. */
  snapshot(): SessionSnapshot {
    return { terminalId: this.id, ...this.meta, status: this.status }
  }
}
