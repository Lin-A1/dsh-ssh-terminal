/**
 * Host allowlist matching. An empty allowlist permits every host; entries are
 * exact host names, `*`, or `*.suffix` wildcards matching one host or any
 * subdomain of the suffix.
 * @module dsh-ssh-terminal/allowlist
 */

/**
 * Decide whether one requested host passes the configured allowlist.
 * @param host - model-supplied host from ssh_terminal_open.
 * @param allowlist - configured entries; empty means unrestricted.
 * @returns true when the connection may proceed.
 */
export function hostAllowed(host: string, allowlist: readonly string[]): boolean {
  if (allowlist.length === 0) return true
  const candidate = host.toLowerCase()
  return allowlist.some((raw) => {
    const entry = raw.toLowerCase()
    if (entry === '*') return true
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(2)
      return candidate === suffix || candidate.endsWith(`.${suffix}`)
    }
    return candidate === entry
  })
}
