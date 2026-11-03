/**
 * The conversation a share exports: every message on the session's current branch, compaction or
 * not, so a thread starts with the whole conversation rather than only what the model still sees.
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { recordedMessage, type RecordedMessage } from './content.ts'

/** At most this many of the branch's newest messages are exported. */
const SNAPSHOT_LIMIT = 4096

/** The branch's recorded messages, oldest first, within {@link SNAPSHOT_LIMIT}. */
export function snapshotMessages(messages: readonly AgentMessage[]): RecordedMessage[] {
  return messages
    .flatMap((message) => {
      const recorded = recordedMessage(message)
      return recorded ? [recorded] : []
    })
    .slice(-SNAPSHOT_LIMIT)
}
