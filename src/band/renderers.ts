/**
 * How Delta's own transcript entries draw: a teammate's message, tool call, event or comment that
 * reached the model's context, and the notes Delta leaves for the person.
 */
import { getMarkdownTheme, type Theme } from '@earendil-works/pi-coding-agent'
import { Box, type Component, Markdown, Text, truncateToWidth } from '@earendil-works/pi-tui'
import type { NoteTone } from '../core/host.ts'
import { fitToolRow, personColor } from './status.ts'
import { linkText, styled } from './band.ts'
import { conversationWebLink, fitQuotedLine } from '../watch/conversation.ts'
import { liveDisplay, type RemoteDisplay } from '../watch/rows.ts'

/** A note Delta leaves in the transcript for the person, never sent to the model. */
export type Note = { text: string; tone?: NoteTone }

function author(name: string, person: string, theme: Theme): string {
  return styled({ text: name, color: personColor(person), bold: true }, theme)
}

/**
 * A remote item as the person reads it: under its author, in that person's color. The row draws the
 * item as it is now each time pi draws it, so a teammate's edit or removal redraws it, and fits its
 * quoted context to the terminal's width.
 */
export function renderRemote(display: RemoteDisplay | undefined, theme: Theme, outputPad: number) {
  if (!display || display.kind === 'context') return undefined
  return new RemoteRow(display, theme, outputPad)
}

/** A drawn remote row, rebuilt only when what it shows or the width it is drawn at changes. */
class RemoteRow implements Component {
  private drawn?: { sources: unknown[]; width: number; lines: string[] }

  constructor(
    private readonly saved: RemoteDisplay,
    private readonly theme: Theme,
    private readonly outputPad: number,
  ) {}

  render(width: number): string[] {
    const { display: current, sources } = liveDisplay(this.saved)
    const drawn = this.drawn
    if (drawn && drawn.width === width && sameSources(drawn.sources, sources)) return drawn.lines
    const display = current()
    const lines =
      display === 'gone' || display.kind === 'context'
        ? []
        : display.kind === 'missing'
          ? new Text(this.theme.fg('dim', display.text), this.outputPad, 0).render(width)
          : remoteBox(display, this.theme, this.outputPad, width).render(width)
    this.drawn = { sources, width, lines }
    return lines
  }

  invalidate() {
    this.drawn = undefined
  }
}

function sameSources(a: unknown[], b: unknown[]): boolean {
  return a.length === b.length && a.every((source, index) => source === b[index])
}

function remoteBox(
  display: Exclude<RemoteDisplay, { kind: 'context' }>,
  theme: Theme,
  outputPad: number,
  width: number,
) {
  const box = new Box(outputPad, 0)
  if (display.kind === 'tool') {
    box.addChild(new ToolLine(display, theme))
    return box
  }
  if (display.kind === 'event') {
    box.addChild(new Text(theme.fg('dim', 'Delta activity'), 0, 0))
    box.addChild(new Markdown(display.markdown, 0, 0, getMarkdownTheme()))
    return box
  }
  if (display.kind === 'comment') {
    const heading = `${display.reply ? theme.fg('dim', '↳ ') : ''}${author(display.author, display.person, theme)}${theme.fg('dim', ` ${display.action}${display.routed ? ' · sent to a subthread' : ''}`)}`
    box.addChild(new TruncatedLine(heading))
    // Quoted context is earlier material: dim, behind a gutter, and elided to the row rather than wrapped.
    const room = Math.max(1, width - 2 * outputPad - 2)
    for (const quoted of display.quote) {
      const line = fitQuotedLine(quoted, room)
      const marked = line.emphasis && (line.before || line.after) ? theme.underline(line.marked) : line.marked
      box.addChild(
        new TruncatedLine(theme.fg('dim', `│ ${line.before}`) + theme.fg('dim', marked) + theme.fg('dim', line.after)),
      )
    }
    box.addChild(new Markdown(display.markdown, 0, 0, getMarkdownTheme()))
    return box
  }
  box.addChild(
    new Text(
      `${author(display.author, display.person, theme)} ${theme.fg('dim', display.agent ? '(agent)' : '(person)')}`,
      0,
      0,
    ),
  )
  box.addChild(new Markdown(display.markdown, 0, 0, getMarkdownTheme()))
  return box
}

/** One line, cut at the row's end rather than wrapped. */
class TruncatedLine implements Component {
  constructor(private readonly text: string) {}

  render(width: number): string[] {
    return [truncateToWidth(this.text, width)]
  }

  invalidate() {}
}

/** A note for the person, marked as Delta's and colored by how it reads. */
export function renderNote(note: Note | undefined, theme: Theme) {
  if (!note?.text) return undefined
  const color = note.tone === 'error' ? 'error' : note.tone === 'warning' ? 'warning' : 'muted'
  // A standalone URL, as /delta link answers, stays plain in storage and RPC but is clickable here.
  const link = conversationWebLink(note.text)
  const text = link === note.text ? linkText(note.text, link, theme) : theme.fg(color, note.text)
  return new Text(`${theme.fg('accent', 'Delta')} ${text}`, 1, 0)
}

/**
 * A tool call on one line, like pi's own tool rows: the tool in bold, its key input dim, a failure in
 * red. The input gives way first, in its middle, so its start and its end both stay.
 */
class ToolLine implements Component {
  constructor(
    private readonly display: Extract<RemoteDisplay, { kind: 'tool' }>,
    private readonly theme: Theme,
  ) {}

  render(width: number): string[] {
    const { theme, display } = this
    const row = fitToolRow(display, width)
    const status = row.statusText ? theme.fg(display.status === 'failed' ? 'error' : 'warning', row.statusText) : ''
    const line = `${author(display.author, display.person, theme)}${theme.fg('dim', ' › ')}${theme.bold(row.name)}${row.shown ? theme.fg('dim', ` ${row.shown}`) : ''}${status}`
    return [truncateToWidth(line, width)]
  }

  invalidate() {}
}
