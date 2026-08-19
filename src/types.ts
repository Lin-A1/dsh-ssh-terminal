/**
 * Shared types for the SSH terminal plugin. Types only — no runtime code.
 * @module dsh-ssh-terminal/types
 */

/** One resolved outbound SSH connection request. */
export interface ConnectRequest {
  host: string
  user: string
  port: number
  identityFile?: string
  password?: string
  connectTimeoutMs: number
  cols: number
  rows: number
}

/** A live remote shell channel with a PTY. */
export interface ShellChannel {
  write(data: string): void
  close(): void
  onData(listener: (chunk: string) => void): void
  onClose(listener: () => void): void
}

/** One established SSH connection able to open a shell channel. */
export interface SshConnection {
  openShell(): Promise<ShellChannel>
  close(): void
}

/** Connection factory; the ssh2 backend is the default, tests inject fakes. */
export type ConnectFn = (req: ConnectRequest) => Promise<SshConnection>

export type SessionStatus =
  | { kind: 'running' }
  | { kind: 'exited'; exitCode: number | null; signal: string | null }

/** Model-facing snapshot of one SSH terminal session. */
export interface SessionSnapshot {
  terminalId: string
  name?: string
  host: string
  user: string
  port: number
  status: SessionStatus
}

export type SendWaitReason = 'command_done' | 'inferred_idle' | 'timeout' | 'session_exit'

/** Canonical JSON value returned by ssh_terminal_send. */
export interface SendResult {
  output: string
  waitReason: SendWaitReason
  exitCode: number | null
  status: 'running' | 'exited'
  truncated: boolean
}

/** Canonical JSON value returned by ssh_terminal_read. */
export interface ReadResult {
  text: string
  totalLines: number
  lineBegin: number
  lineEnd: number
  truncated: boolean
}
