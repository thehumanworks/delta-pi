/**
 * An extension that changes what the session keeps, loaded after Delta in tests: it redacts secrets, and
 * Delta must record the redacted message, as pi commits it, never what the person typed.
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

export default function (pi: ExtensionAPI) {
  // It also marks a reply it was told to cut as cut at its length limit.
  pi.on('message_end', (event) => {
    if (event.message.role !== 'assistant') return
    const text = event.message.content.map((block) => (block.type === 'text' ? block.text : '')).join('')
    if (text.includes('[cut]')) return { message: { ...event.message, stopReason: 'length' as const } }
  })
  pi.on('message_end', (event) => {
    if (event.message.role !== 'user' || typeof event.message.content === 'string') return
    const content = event.message.content.map((block) =>
      block.type === 'text' ? { ...block, text: block.text.replaceAll(/hunter\d+/g, '[redacted]') } : block,
    )
    return { message: { ...event.message, content } }
  })
}
