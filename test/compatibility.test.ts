import { expect, test } from "vitest";
import { MINIMUM_PI_VERSION, piVersionWarning } from "../src/core/compatibility.ts";

test("pi compatibility compares numeric versions and accepts newer releases without an upper cutoff", () => {
  for (const version of ["0.9.999", "1.3.99", "1.4.0-dev.1"])
    expect(piVersionWarning(version)).toBe(
      `Warning: Delta supports pi ${MINIMUM_PI_VERSION} or newer; you are running ${version}. Update pi. Delta will continue, but some features may not work.`,
    );
  for (const version of [MINIMUM_PI_VERSION, "1.4.0+build.1", "1.4.1", "1.10.0", "2.0.0"])
    expect(piVersionWarning(version)).toBeUndefined();
  for (const version of [undefined, "unknown"])
    expect(piVersionWarning(version)).toBe(
      `Warning: Delta couldn't determine the pi version. Delta supports pi ${MINIMUM_PI_VERSION} or newer and will continue without a compatibility check.`,
    );
});
