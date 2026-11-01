/** The oldest supported pi: the release whose extension events and renderers this extension uses. */
export const MINIMUM_PI_VERSION = "1.4.0";

/** Warn without blocking startup when pi is older than the supported minimum. */
export function piVersionWarning(version: string | undefined): string | undefined {
  const parsed = version?.match(/^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!parsed)
    return `Warning: Delta couldn't determine the pi version. Delta supports pi ${MINIMUM_PI_VERSION} or newer and will continue without a compatibility check.`;
  const minimum = MINIMUM_PI_VERSION.split(".").map(Number);
  for (let index = 0; index < minimum.length; index++) {
    const component = Number(parsed[index + 1]);
    if (component > minimum[index]!) return;
    if (component < minimum[index]!) return unsupportedVersionWarning(version!);
  }
  if (parsed[4]) return unsupportedVersionWarning(version!);
}

function unsupportedVersionWarning(version: string): string {
  return `Warning: Delta supports pi ${MINIMUM_PI_VERSION} or newer; you are running ${version}. Update pi. Delta will continue, but some features may not work.`;
}
