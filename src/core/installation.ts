/** App installation and extension updates must never interrupt one another. */
type Installation = { kind: "app" | "plugin" };

export let installation: Installation | undefined;

/** Claim the installer slot synchronously; a late release cannot clear a newer owner. */
export function claimInstallation(kind: Installation["kind"]): (() => void) | undefined {
  if (installation) return;
  const claim = { kind };
  installation = claim;
  return () => {
    if (installation === claim) installation = undefined;
  };
}
