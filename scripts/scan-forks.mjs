import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const root = 'C:/Users/WYC/.dsh/sessions'
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
