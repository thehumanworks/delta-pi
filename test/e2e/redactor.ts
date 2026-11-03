/**
 * An extension that redacts secrets from what the session keeps, loaded after Delta in tests: Delta
 * must record the redacted message, as pi commits it, never what the person typed.
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

export default function (pi: ExtensionAPI) {
  pi.on('message_end', (event) => {
    if (event.message.role !== 'user' || typeof event.message.content === 'string') return
    const content = event.message.content.map((block) =>
      block.type === 'text' ? { ...block, text: block.text.replaceAll(/hunter\d+/g, '[redacted]') } : block,
    )
    return { message: { ...event.message, content } }
  })
}
