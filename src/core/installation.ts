/**
 * App installation and extension updates must never interrupt one another. The claim lives for the pi
 * process, not the session runtime: an installer started before a session switch keeps running after it.
 */
type Installation = { kind: 'app' | 'plugin' }

/** pi evaluates this module afresh for every session runtime, so the claim lives on `globalThis`. */
const slot = ((globalThis as Record<symbol, unknown>)[Symbol.for('pi-delta.installation')] ??= {
  current: undefined,
}) as { current: Installation | undefined }

/** The installation running in this pi process, if any. */
export function installation(): Installation | undefined {
  return slot.current
}

/** Claim the installer slot synchronously; a late release cannot clear a newer owner. */
export function claimInstallation(kind: Installation['kind']): (() => void) | undefined {
  if (slot.current) return
  const claim = { kind }
  slot.current = claim
  return () => {
    if (slot.current === claim) slot.current = undefined
  }
}
