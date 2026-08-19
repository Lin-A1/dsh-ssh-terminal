/**
 * Session registry: allowlist enforcement, session caps, id assignment, and
 * teardown for every SSH terminal owned by this plugin.
 * @module dsh-ssh-terminal/manager
 */

import { hostAllowed } from './allowlist.ts'
import { SshTerminalSession } from './session.ts'
import type { ConnectFn, SessionSnapshot } from './types.ts'

/** Deployment-resolved manager configuration. */
export interface ManagerOptions {
  allowlist: readonly string[]
  maxSessions: number
  defaultPort: number
  connectTimeoutMs: number
  maxScrollbackBytes: number
  connect: ConnectFn
}

/** One ssh_terminal_open request after tool-schema validation. */
export interface OpenRequest {
  host: string
  user: string
  port?: number
  identityFile?: string
  password?: string
  name?: string
  echo?: boolean
}

/** Owns every live SSH terminal session for this plugin instance. */
export class SshTerminalManager {
  private readonly sessions = new Map<string, SshTerminalSession>()
  private seq = 0

  constructor(private readonly options: ManagerOptions) {}

  /**
   * Connect to a model-specified host and start a persistent remote shell.
   * The allowlist and the session cap are enforced here, in the operation
   * that creates the connection.
   * @param req - validated open arguments.
   * @returns the new session snapshot and its startup banner.
   */
  async open(req: OpenRequest): Promise<{ snapshot: SessionSnapshot; motd: string }> {
    if (req.host.length === 0) throw new Error('host must be a non-empty string')
    if (req.user.length === 0) throw new Error('user must be a non-empty string')
    if (!hostAllowed(req.host, this.options.allowlist)) {
      throw new Error(`ssh terminal: host ${JSON.stringify(req.host)} is not in the configured allowlist`)
    }
    if (this.sessions.size >= this.options.maxSessions) {
      throw new Error(`ssh terminal: session limit ${this.options.maxSessions} reached; close an existing terminal first`)
    }
    const port = req.port ?? this.options.defaultPort
    const id = `ssh-term-${++this.seq}`
    const connection = await this.options.connect({
      host: req.host,
      user: req.user,
      port,
      ...req.identityFile !== undefined ? { identityFile: req.identityFile } : {},
      ...req.password !== undefined ? { password: req.password } : {},
      connectTimeoutMs: this.options.connectTimeoutMs,
      cols: 220,
      rows: 50,
    })
    const { session, motd } = await SshTerminalSession.start(
      id,
      { host: req.host, user: req.user, port, ...req.name !== undefined ? { name: req.name } : {} },
      connection,
      { echo: req.echo ?? false, maxScrollbackBytes: this.options.maxScrollbackBytes },
      this.options.connectTimeoutMs,
    )
    this.sessions.set(id, session)
    return { snapshot: session.snapshot(), motd }
  }

  /**
   * Resolve a live session by id.
   * @param terminalId - id returned by ssh_terminal_open or ssh_terminal_list.
   */
  get(terminalId: string): SshTerminalSession {
    const session = this.sessions.get(terminalId)
    if (session === undefined) throw new Error(`unknown ssh terminal id ${JSON.stringify(terminalId)}`)
    return session
  }

  /** Snapshots of every tracked session. */
  list(): SessionSnapshot[] {
    return [...this.sessions.values()].map(session => session.snapshot())
  }

  /**
   * Close one session and drop it from the registry.
   * @param terminalId - id returned by ssh_terminal_open or ssh_terminal_list.
   * @returns whether this call performed the close.
   */
  async close(terminalId: string): Promise<'closed' | 'already-closing'> {
    const session = this.get(terminalId)
    this.sessions.delete(terminalId)
    return await session.close() ? 'closed' : 'already-closing'
  }

  /** Close every session; used at plugin disposal. Never rejects. */
  async closeAll(): Promise<void> {
    const pending = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.allSettled(pending.map(session => session.close()))
  }
}
