/**
 * Sentinel markers delimit command output inside a persistent SSH shell.
 * Each submitted command is followed by `printf '<token>:%s\n' "$?"`; the
 * marker line carries the exit code and proves the command completed.
 * @module dsh-ssh-terminal/sentinel
 */

const TOKEN_CHARSET = /^[A-Za-z0-9_]+$/

/**
 * Build a unique, regex-safe done marker for one submitted command.
 * @param scope - owning terminal id (sanitized into the token).
 * @param seq - per-terminal command counter.
 * @returns a marker that cannot collide with earlier commands on this terminal.
 */
export function createDoneToken(scope: string, seq: number): string {
  const safeScope = scope.replace(/[^A-Za-z0-9]/g, '_')
  const rand = Math.random().toString(36).slice(2, 10)
  return `__DSHSSH_DONE_${safeScope}_${seq}_${rand}__`
}

/**
 * Build a unique readiness marker used during session startup.
 * @param scope - owning terminal id.
 * @returns a marker printed once the remote shell executes input.
 */
export function createReadyToken(scope: string): string {
  const safeScope = scope.replace(/[^A-Za-z0-9]/g, '_')
  const rand = Math.random().toString(36).slice(2, 10)
  return `__DSHSSH_READY_${safeScope}_${rand}__`
}

/**
 * Remove one done-marker line from captured output and recover the exit code.
 * The marker is matched as `<token>:<digits>`; surrounding newlines are removed
 * with it. Output produced after the marker is preserved.
 * @param text - output captured since the command was submitted.
 * @param token - done marker for that command.
 * @returns the cleaned output and exit code, or undefined when the marker has
 *   not arrived yet.
 */
export function stripSentinel(text: string, token: string): { text: string; exitCode: number } | undefined {
  if (!TOKEN_CHARSET.test(token)) throw new Error(`sentinel token ${JSON.stringify(token)} is not regex-safe`)
  const re = new RegExp(`\\n?${token}:(\\d+)\\n?`)
  const match = re.exec(text)
  if (match === null) return undefined
  const cleaned = text.slice(0, match.index) + text.slice(match.index + match[0].length)
  return { text: cleaned, exitCode: Number(match[1]) }
}

/**
 * Remove every line containing a marker (its echoed input line and its printed
 * output line) from startup banner text.
 * @param text - raw text captured before the readiness marker.
 * @param token - readiness marker.
 * @returns banner text without marker-bearing lines.
 */
export function stripMarkerLines(text: string, token: string): string {
  return text
    .split('\n')
    .filter(line => !line.includes(token))
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '')
}
