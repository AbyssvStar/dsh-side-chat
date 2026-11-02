import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const path = process.argv[2]
const bytes = readFileSync(path)
const raw = path.endsWith('.zstd') ? zstdDecompressSync(bytes).toString('utf8') : bytes.toString('utf8')
const events = raw.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line))

const counts = new Map()
for (const event of events) counts.set(event.type, (counts.get(event.type) ?? 0) + 1)
console.log('events', events.length)
console.log([...counts].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' '))

const prose = events.filter((event) => event.type === 'assistant/message')
const withText = prose.filter((event) => {
  const content = event.data?.message?.content
  return Array.isArray(content) && content.some((block) => block?.kind === 'text' && typeof block.text === 'string' && block.text.trim() !== '')
})
console.log('assistant/message', prose.length, 'with text', withText.length)

const users = events.filter((event) => event.type === 'user/message')
console.log('user/message', users.length)
for (const event of users.slice(-3)) {
  const text = (event.data?.message?.content ?? []).map((b) => b?.text ?? JSON.stringify(b)).join(' ').slice(0, 160)
  console.log('  user source', JSON.stringify(event.data?.message?.source ?? event.data?.source), '|', text)
}
const last = withText.at(-1)
if (last) {
  const text = last.data.message.content.filter((b) => b?.kind === 'text').map((b) => b.text).join('\n')
  console.log('LAST TEXT turn', last.data?.turn, ':', JSON.stringify(text.slice(0, 200)))
}
