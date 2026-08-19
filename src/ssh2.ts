/**
 * ssh2-backed connection factory. Each terminal holds one ssh2 Client with one
 * interactive shell channel behind a PTY.
 * @module dsh-ssh-terminal/ssh2
 */

import { readFile } from 'node:fs/promises'
import { Client } from 'ssh2'
import type { ConnectRequest, SshConnection } from './types.ts'

/**
 * Connect to a remote host with ssh2.
 * @param req - resolved connection request (host, credentials, PTY size).
 * @returns a connection handle able to open one shell channel.
 */
export async function connectSsh2(req: ConnectRequest): Promise<SshConnection> {
  const client = new Client()
  const privateKey = req.identityFile === undefined ? undefined : await readFile(req.identityFile)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      client.destroy()
      reject(new Error(`ssh connect to ${req.user}@${req.host}:${req.port} timed out after ${req.connectTimeoutMs}ms`))
    }, req.connectTimeoutMs)
    client.once('ready', () => {
      clearTimeout(timer)
      resolve()
    })
    client.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    client.connect({
      host: req.host,
      port: req.port,
      username: req.user,
      ...privateKey !== undefined ? { privateKey } : {},
      ...req.password !== undefined ? { password: req.password } : {},
      readyTimeout: req.connectTimeoutMs,
    })
  })
  return {
    openShell: () => new Promise((resolve, reject) => {
      client.shell({ term: 'xterm-256color', cols: req.cols, rows: req.rows }, (error, channel) => {
        if (error) {
          reject(error)
          return
        }
        resolve({
          write: data => channel.write(data),
          close: () => channel.close(),
          onData: listener => channel.on('data', (chunk: Buffer) => listener(chunk.toString('utf8'))),
          onClose: listener => channel.once('close', listener),
        })
      })
    }),
    close: () => client.end(),
  }
}
