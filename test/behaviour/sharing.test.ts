import { afterEach, expect, test } from 'vitest'
import { type Kit, startDelta } from '../kit/index.ts'

let delta: Kit | undefined
afterEach(async () => {
  delta?.expectClean()
  await delta?.stop()
  delta = undefined
})

const NOT_NOW = (dialog: { title: string }) => (dialog.title.includes('Set it up now?') ? 'Not now' : undefined)

test('/delta share during a turn asks who should see the session once the turn ends, then shares it', async () => {
  delta = await startDelta({ answers: [NOT_NOW] })
  const { pi } = delta
  await delta.until(() => pi.dialogs.length === 1, 'the setup offer')
  let answer: ((text: string) => void) | undefined
  pi.model = () => new Promise((resolve) => (answer = (text) => resolve({ text })))
  const turn = pi.submit('a long task')
  await delta.until(() => answer, 'the turn to run')
  pi.answers.push((dialog) => (dialog.title.includes('Who should see this session?') ? 'Share with Zed' : undefined))
  await pi.command('delta', 'share')
  expect(pi.noticeTexts()).toContain('Delta will share this session once the current pi turn ends.')
  // Nothing is shared, or asked, while the turn runs.
  expect(pi.dialogs).toHaveLength(1)
  expect(delta.thread()).toBeUndefined()
  answer!('Finished.')
  await turn
  // The conversation so far, the turn that ran during the request included, is exported.
  const thread = await delta.until(
    () => JSON.stringify(delta!.thread()?.records ?? []).includes('Finished.') && delta!.thread(),
    'the session and its conversation to be shared',
  )
  expect(thread.url).toBeTruthy()
  expect(thread.visibility).toBe('organization')
  expect(pi.errors).toEqual([])
})
