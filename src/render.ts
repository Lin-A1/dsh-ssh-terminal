/**
 * Model-facing rendering and complete-result byte bounding for SSH terminal
 * tool output.
 * @module dsh-ssh-terminal/render
 */

import type { ReadResult, SendResult, SessionSnapshot } from './types.ts'

const TRUNCATED = '\n[output truncated]'

/**
 * Bound one complete result to a UTF-8 byte budget, cutting at a character
 * boundary and appending a truncation marker.
 * @param text - complete text.
 * @param maxBytes - positive final cap.
 * @returns the text or a bounded prefix plus marker.
 */
export function boundText(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text)
  if (bytes.byteLength <= maxBytes) return text
  const markerBytes = new TextEncoder().encode(TRUNCATED).byteLength
  if (markerBytes >= maxBytes) return TRUNCATED.slice(0, maxBytes)
  const head = new TextDecoder().decode(bytes.subarray(0, maxBytes - markerBytes), { stream: true })
  return `${head}${TRUNCATED}`
}

function statusText(status: SessionSnapshot['status']): string {
  return status.kind === 'running'
    ? 'running'
    : `exited code=${status.exitCode ?? 'null'} signal=${status.signal ?? 'null'}`
}

/**
 * Render one created SSH terminal session and its banner.
 * @param snapshot - published session snapshot.
 * @param motd - startup banner (marker lines already removed).
 * @param maxBytes - complete UTF-8 result cap.
 */
export function renderOpen(snapshot: SessionSnapshot, motd: string, maxBytes: number): string {
  const name = snapshot.name === undefined ? '' : ` (${snapshot.name})`
  const banner = motd || '(no startup output)'
  return boundText(`started ssh terminal session ${snapshot.terminalId}${name} [${snapshot.user}@${snapshot.host}:${snapshot.port}]\n${banner}`, maxBytes)
}

/**
 * Render one settled send: captured output plus wait, exit-code, and session
 * markers.
 * @param result - settled send outcome.
 * @param maxBytes - complete UTF-8 result cap.
 */
export function renderSend(result: SendResult, maxBytes: number): string {
  const output = result.output || '(no new output)'
  const exit = result.exitCode === null ? '' : `\n[exit code: ${result.exitCode}]`
  const truncated = result.truncated ? TRUNCATED : ''
  return boundText(`${output}\n[wait: ${result.waitReason}]${exit}\n[session: ${result.status}]${truncated}`, maxBytes)
}

/**
 * Render one bounded scrollback page with pagination markers.
 * @param result - retained page.
 * @param maxBytes - complete UTF-8 result cap.
 */
export function renderRead(result: ReadResult, maxBytes: number): string {
  const output = result.text || '(no retained output)'
  const truncated = result.truncated ? TRUNCATED : ''
  return boundText(`${output}\n[lines: ${result.lineBegin}-${result.lineEnd} of ${result.totalLines}]${truncated}`, maxBytes)
}

/**
 * Render all tracked SSH terminal sessions, one line each.
 * @param sessions - fresh snapshots.
 * @param maxBytes - complete UTF-8 result cap.
 */
export function renderList(sessions: readonly SessionSnapshot[], maxBytes: number): string {
  if (sessions.length === 0) return '(no ssh terminal sessions)'
  const text = sessions.map((session) => {
    const name = session.name === undefined ? '' : ` (${session.name})`
    return `${session.terminalId}${name} [${session.user}@${session.host}:${session.port}] ${statusText(session.status)}`
  }).join('\n')
  return boundText(text, maxBytes)
}
