/** One staged record: its outbox files, in order, and the digest that guards them. */
export type Entry = { sequence: number; files: string[]; digest: string }
