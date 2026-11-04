/**
 * List the sessions on this machine that were forked from another one.
 *
 * A debug aid, not part of the plugin: it reads the session store read-only and
 * prints the header of every log whose `parentSession` is set. The store is
 * `$DSH_HOME/sessions`, or `~/.dsh/sessions` when that is unset; pass a
 * directory to override both.
 *
 * Usage: node scripts/scan-forks.mjs [sessions-dir]
 */
import { readdirSync, statSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/**
 * Resolve the session store without baking this machine's home directory in.
 * @returns {string} directory that holds the per-project buckets.
 */
function sessionsRoot() {
  if (process.argv[2] !== undefined) return process.argv[2]
  if (process.env.DSH_HOME !== undefined) return join(process.env.DSH_HOME, 'sessions')
  return join(homedir(), '.dsh', 'sessions')
}

const root = sessionsRoot()
for (const bucket of readdirSync(root)) {
  const bucketPath = join(root, bucket)
  let sessions
  try {
    sessions = readdirSync(bucketPath)
  } catch {
    continue
  }
  for (const session of sessions) {
    const dir = join(bucketPath, session)
    let files
    try {
      files = readdirSync(dir).filter((name) => name.endsWith('.jsonl.zstd'))
    } catch {
      continue
    }
    for (const file of files) {
      const path = join(dir, file)
      let head
      try {
        const raw = zstdDecompressSync(readFileSync(path))
        head = raw.toString('utf8').split('\n', 1)[0]
      } catch (error) {
        continue
      }
      let parsed
      try {
        parsed = JSON.parse(head)
      } catch {
        continue
      }
      if (parsed.parentSession !== undefined || parsed.isSeeded === true) {
        console.log(`${session}  parent=${parsed.parentSession}  created=${new Date(parsed.createdAt).toISOString()}  ${statSync(path).size}b  ${path}`)
      }
    }
  }
}
