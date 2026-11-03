/**
 * A model for end-to-end tests: pi's faux provider, answering each request from the conversation
 * so far. `run <command>` asks for a bash call, `write <path> <text>` for a write call, and anything
 * else is echoed back.
 */
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type FauxResponseFactory,
} from '@earendil-works/pi-ai'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

function lastText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.flatMap((block) => (block?.type === 'text' ? [block.text as string] : [])).join('\n')
}

const respond: FauxResponseFactory = (context) => {
  const last = context.messages.at(-1) as { role: string; content: unknown } | undefined
  if (last?.role === 'toolResult') return fauxAssistantMessage('Done.')
  const text = lastText(last?.content).trim()
  const run = /^run (.+)$/s.exec(text)
  if (run)
    return fauxAssistantMessage([fauxText('Running.'), fauxToolCall('bash', { command: run[1]! })], {
      stopReason: 'toolUse',
    })
  const write = /^write (\S+) (.+)$/s.exec(text)
  if (write)
    return fauxAssistantMessage([fauxToolCall('write', { path: write[1]!, content: `${write[2]!}\n` })], {
      stopReason: 'toolUse',
    })
  return fauxAssistantMessage(`Echo: ${text}`)
}

export default function (pi: ExtensionAPI) {
  const core = createFauxCore({ api: 'faux-e2e', provider: 'faux', models: [{ id: 'faux-1' }] })
  pi.registerProvider('faux', {
    baseUrl: 'http://faux.invalid',
    apiKey: 'faux',
    api: 'faux-e2e',
    models: [
      {
        id: 'faux-1',
        name: 'Faux',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      },
    ],
    streamSimple: (model, context, options) => {
      core.setResponses([respond])
      return core.streamSimple(model, context, options)
    },
  })
}
