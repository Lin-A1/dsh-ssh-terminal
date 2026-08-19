/**
 * Persistent SSH remote terminal tools for DeepSeek Harness agents. Five
 * model-facing tools (ssh_terminal_open/send/read/list/close) manage
 * long-lived ssh2 shell channels whose target host the model chooses per
 * call, gated by an optional deployment allowlist. Named exports preserve
 * loader injection metadata; there is no default export.
 * @module dsh-ssh-terminal
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolResult } from '@deepseek-ai/dsh-tools'
import { SshTerminalManager } from './manager.ts'
import type { OpenRequest } from './manager.ts'
import { renderList, renderOpen, renderRead, renderSend } from './render.ts'
import { connectSsh2 } from './ssh2.ts'
import type { ConnectFn } from './types.ts'

export const name = 'ssh-terminal'
export const inject = ['tools']

/** Model-facing SSH terminal plugin configuration. */
export interface Config {
  /**
   * Hosts the model may connect to. Empty (default) permits every host;
   * entries are exact names, `*`, or `*.suffix` subdomain wildcards. This is
   * the only boundary between the model and arbitrary outbound SSH.
   */
  allowlist?: string[]
  /** Maximum simultaneous live SSH terminal sessions (default 8). */
  maxSessions?: number
  /** SSH port used when ssh_terminal_open omits `port` (default 22). */
  defaultPort?: number
  /** TCP/auth and startup-probe deadline per connection in ms (default 15000). */
  connectTimeoutMs?: number
  /** Output-silence window that settles a non-submit send in ms (default 800). */
  idleMs?: number
  /** Default per-send wait deadline in ms (default 30000). */
  sendTimeoutMs?: number
  /** Retained scrollback cap per session in UTF-8 bytes (default 1048576). */
  maxScrollbackBytes?: number
  /** Cap on one complete model-facing tool result in UTF-8 bytes (default 131072). */
  maxResultBytes?: number
}

/** Schemastery configuration for the SSH terminal plugin consumer. */
export const Config: z<Config> = z.object({
  allowlist: z.array(z.string()).default([]),
  maxSessions: z.number().step(1).min(1).max(1024).default(8),
  defaultPort: z.number().step(1).min(1).max(65535).default(22),
  connectTimeoutMs: z.number().step(1).min(1).default(15000),
  idleMs: z.number().step(1).min(1).default(800),
  sendTimeoutMs: z.number().step(1).min(1).default(30000),
  maxScrollbackBytes: z.number().step(1).min(1024).default(1048576),
  maxResultBytes: z.number().step(1).min(256).default(131072),
})

/** Deployment-resolved configuration shared by the manager and the tools. */
export interface ResolvedConfig {
  allowlist: readonly string[]
  maxSessions: number
  defaultPort: number
  connectTimeoutMs: number
  idleMs: number
  sendTimeoutMs: number
  maxScrollbackBytes: number
  maxResultBytes: number
}

/**
 * Resolve the optional-input config to the fully-defaulted values the
 * registry schema would supply (direct construction in tests bypasses it).
 * @param config - user config or a schema-resolved one.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  return {
    allowlist: config.allowlist ?? [],
    maxSessions: config.maxSessions ?? 8,
    defaultPort: config.defaultPort ?? 22,
    connectTimeoutMs: config.connectTimeoutMs ?? 15000,
    idleMs: config.idleMs ?? 800,
    sendTimeoutMs: config.sendTimeoutMs ?? 30000,
    maxScrollbackBytes: config.maxScrollbackBytes ?? 1048576,
    maxResultBytes: config.maxResultBytes ?? 131072,
  }
}

const SESSION_STATUS_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', required: true, const: 'running' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', required: true, const: 'exited' },
        exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
        signal: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
      },
    },
  ],
} as const

const SESSION_SNAPSHOT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    terminalId: { type: 'string', required: true },
    name: { type: 'string' },
    host: { type: 'string', required: true },
    user: { type: 'string', required: true },
    port: { type: 'integer', required: true },
    status: { ...SESSION_STATUS_SCHEMA, required: true },
  },
} as const

interface OpenArgs {
  host: string
  user: string
  port?: number
  identityFile?: string
  password?: string
  name?: string
  echo?: boolean
}

interface SendArgs {
  terminalId: string
  data: string
  submit?: boolean
  idleMs?: number
  timeoutMs?: number
}

interface ReadArgs {
  terminalId: string
  offset?: number
  count?: number
}

interface TerminalArgs {
  terminalId: string
}

function terminalId(args: TerminalArgs): string {
  if (args.terminalId.length === 0) throw new Error('terminalId must be a non-empty string')
  return args.terminalId
}

function rawContentText(result: ToolResult): string | undefined {
  const block = result.content.length === 1 ? result.content[0] : undefined
  return block?.type === 'text' ? block.text : undefined
}

/**
 * Build the five tool definitions against an explicit manager, so tests can
 * drive them with a scripted connection factory instead of real SSH.
 * @param manager - session registry enforcing allowlist and caps.
 * @param config - resolved deployment configuration.
 * @returns the tool definitions to register on ctx.tools.
 */
export function createTools(manager: SshTerminalManager, config: ResolvedConfig): ToolDefinition[] {
  const maxResultBytes = config.maxResultBytes
  return [
    defineTool({
      name: 'ssh_terminal_open',
      description: 'Open a persistent interactive shell on a remote host over SSH. The session survives across tool calls: later ssh_terminal_send calls write to the same remote shell. Choose the target per call with host/user/port/identityFile; the deployment may restrict which hosts are allowed. Prefer this over one-shot commands only when you need remote shell state (cwd, env, REPLs, interactive programs) to persist.',
      parameters: {
        host: { type: 'string', required: true, description: 'Remote host name or IP to connect to.' },
        user: { type: 'string', required: true, description: 'Remote login user name.' },
        port: { type: 'number', description: 'SSH port (defaults to the plugin-configured port, usually 22).' },
        identityFile: { type: 'string', description: 'Absolute path to a local private key file. Omit to rely on password or the ssh2 default agent-less behavior.' },
        password: { type: 'string', description: 'Password for password authentication. Prefer identityFile when possible.' },
        name: { type: 'string', description: 'Optional display name such as "deploy" to tell sessions apart.' },
        echo: { type: 'boolean', description: 'Keep remote PTY echo on (default false, startup runs `stty -echo` so sent commands are not duplicated in output).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ...SESSION_SNAPSHOT_SCHEMA.properties,
            motd: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: renderOpen(value, value.motd, maxResultBytes) }],
      },
      async execute(args: OpenArgs, exec) {
        const request: OpenRequest = {
          host: args.host,
          user: args.user,
          ...args.port !== undefined ? { port: args.port } : {},
          ...args.identityFile !== undefined ? { identityFile: args.identityFile } : {},
          ...args.password !== undefined ? { password: args.password } : {},
          ...args.name !== undefined ? { name: args.name } : {},
          ...args.echo !== undefined ? { echo: args.echo } : {},
        }
        const { snapshot, motd } = await manager.open(request)
        if (exec.signal.aborted) {
          await manager.close(snapshot.terminalId)
          throw new Error('ssh terminal open aborted')
        }
        return { ...snapshot, motd }
      },
      presentCall: args => ({ card: 'generic', title: `Open SSH terminal ${args.user}@${args.host}`, kind: 'execute' }),
    }),
    defineTool({
      name: 'ssh_terminal_send',
      description: 'Send text to a persistent SSH terminal. By default Enter is submitted and the call waits until the command finishes (its exit code is reported), the session exits, or the timeout elapses. With submit=false the text is written raw (control characters, partial REPL input) and the call returns after the output goes quiet. An inferred_idle or timeout result does not prove the remote command exited.',
      parameters: {
        terminalId: { type: 'string', required: true, description: 'Terminal id returned by ssh_terminal_open or ssh_terminal_list.' },
        data: { type: 'string', required: true, description: 'UTF-8 text to write to the remote shell.' },
        submit: { type: 'boolean', description: 'Submit Enter after the text and wait for the command to finish (default true). Set false for control characters or incomplete input.' },
        idleMs: { type: 'number', description: 'Output-silence window that settles a submit=false send (default from plugin config).' },
        timeoutMs: { type: 'number', description: 'Maximum wait before returning the output captured so far (default from plugin config).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            output: { type: 'string', required: true },
            waitReason: { type: 'string', required: true, enum: ['command_done', 'inferred_idle', 'timeout', 'session_exit'] },
            exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
            status: { type: 'string', required: true, enum: ['running', 'exited'] },
            truncated: { type: 'boolean', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: renderSend(value, maxResultBytes) }],
        presentationMeta: (_args, value) => ({
          waitReason: value.waitReason,
          exitCode: value.exitCode,
          status: value.status,
          truncated: value.truncated,
        }),
      },
      async execute(args: SendArgs, exec) {
        const session = manager.get(terminalId(args))
        return await session.send({
          data: args.data,
          submit: args.submit ?? true,
          idleMs: args.idleMs ?? config.idleMs,
          timeoutMs: args.timeoutMs ?? config.sendTimeoutMs,
          signal: exec.signal,
        })
      },
      presentCall: args => ({ card: 'terminal', title: args.data || '(send input)', description: `SSH terminal ${args.terminalId}` }),
      presentResult(_args, result) {
        if (result.isError) return undefined
        const raw = rawContentText(result)
        return raw === undefined ? undefined : { card: 'terminal' as const, output: raw }
      },
    }),
    defineTool({
      name: 'ssh_terminal_read',
      description: 'Read a bounded page of retained output from a persistent SSH terminal without sending input.',
      parameters: {
        terminalId: { type: 'string', required: true, description: 'Terminal id.' },
        offset: { type: 'number', description: 'Newest-relative line offset (default 0).' },
        count: { type: 'number', description: 'Maximum lines to return (default 500).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', required: true },
            totalLines: { type: 'integer', required: true },
            lineBegin: { type: 'integer', required: true },
            lineEnd: { type: 'integer', required: true },
            truncated: { type: 'boolean', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: renderRead(value, maxResultBytes) }],
      },
      execute(args: ReadArgs) {
        const result = manager.get(terminalId(args)).read(args.offset ?? 0, args.count ?? 500)
        return Promise.resolve(result)
      },
      isConcurrencySafe: () => true,
      presentCall: args => ({ card: 'generic', title: `Read SSH terminal ${args.terminalId}`, kind: 'read' }),
    }),
    defineTool({
      name: 'ssh_terminal_list',
      description: 'List every live SSH terminal session with its target host and status.',
      parameters: {},
      output: {
        schema: { type: 'array', items: SESSION_SNAPSHOT_SCHEMA },
        render: (_args, value) => [{ type: 'text', text: renderList(value, maxResultBytes) }],
      },
      execute() {
        return Promise.resolve(manager.list())
      },
      isConcurrencySafe: () => true,
      presentCall: () => ({ card: 'generic', title: 'List SSH terminal sessions', kind: 'read' }),
    }),
    defineTool({
      name: 'ssh_terminal_close',
      description: 'Close one persistent SSH terminal session and its connection.',
      parameters: {
        terminalId: { type: 'string', required: true, description: 'Terminal id returned by ssh_terminal_open or ssh_terminal_list.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            terminalId: { type: 'string', required: true },
            outcome: { type: 'string', required: true, enum: ['closed', 'already-closing'] },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.outcome === 'closed'
            ? `closed ssh terminal session ${value.terminalId}`
            : `ssh terminal session ${value.terminalId} was already closing`,
        }],
      },
      async execute(args: TerminalArgs) {
        const id = terminalId(args)
        const outcome = await manager.close(id)
        return { terminalId: id, outcome }
      },
      presentCall: args => ({ card: 'generic', title: `Close SSH terminal ${args.terminalId}`, kind: 'delete' }),
    }),
  ]
}

/**
 * Register the five SSH terminal tools and close every session when the
 * plugin fiber is disposed.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - deployment configuration (schema defaults applied by the loader).
 * @param connect - connection factory; the ssh2 backend is the default and
 *   tests inject a scripted one.
 */
export function apply(ctx: Context, config: Config = {}, connect: ConnectFn = connectSsh2): void {
  const resolved = resolveConfig(config)
  const manager = new SshTerminalManager({
    allowlist: resolved.allowlist,
    maxSessions: resolved.maxSessions,
    defaultPort: resolved.defaultPort,
    connectTimeoutMs: resolved.connectTimeoutMs,
    maxScrollbackBytes: resolved.maxScrollbackBytes,
    connect,
  })
  ctx.effect(() => () => {
    void manager.closeAll()
  })
  for (const tool of createTools(manager, resolved)) {
    ctx.tools.register(tool)
  }
}
