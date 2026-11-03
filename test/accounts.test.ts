import { describe, expect, test } from "vitest";
import { AccessRequiredError, type AuthenticationHost, requireAuthentication } from "../src/cli/auth.ts";
import {
  InstallationUpdates,
  parseInstallUpdate,
  parseProgressEvent,
  type UpdateHost,
} from "../src/cli/install-update.ts";
import type { Exit, Output, ProcessStream, RunResult } from "../src/core/process.ts";

/** A finished program's output as a stream, as the CLI would print it. */
function stream(stdout: string, stderr = "", code = 0): ProcessStream {
  const pieces: Output[] = [
    ...(stderr ? stderr.split(/(?<=\n)/).map((text) => ({ stream: "stderr" as const, text })) : []),
    ...(stdout ? [{ stream: "stdout" as const, text: stdout }] : []),
  ];
  return {
    pid: 1,
    next: async () =>
      pieces.length ? { done: false, value: pieces.shift()! } : { done: true, value: { code, signal: null } as Exit },
    return: async () => ({ done: true, value: { code: null, signal: "SIGTERM" } as Exit }),
  };
}
const ran = (stdout: string, exitCode = 0): RunResult => ({
  stdout,
  stderr: "",
  exitCode,
  isStdoutTruncated: false,
  isStderrTruncated: false,
});
const update = (status: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    schema_version: 1,
    status,
    current_version: "1.0.0",
    latest_version: "1.1.0",
    channel: "stable",
    message: "Run the installer.",
    can_install: true,
    ...extra,
  });

function updateHost(answers: { check?: string; update?: { stdout: string; stderr?: string } }) {
  const runs: { argv: string[]; env?: Record<string, string> }[] = [];
  const logs: { text: string; to: string }[] = [];
  const steps: unknown[] = [];
  const host: UpdateHost = {
    run: async (argv, init) => {
      runs.push({ argv, env: init?.env });
      if (argv[0] === "sh") return ran("/usr/bin/delta\n");
      return ran(answers.check ?? update("up_to_date"));
    },
    spawn: (init) => {
      runs.push({ argv: init.argv, env: init.env });
      return stream(answers.update?.stdout ?? "", answers.update?.stderr);
    },
    windows: async () => false,
    exists: async () => true,
    after: (milliseconds, run) => {
      const timer = setTimeout(run, milliseconds);
      return { cancel: () => clearTimeout(timer) };
    },
    log: async (text, to) => {
      logs.push({ text, to });
    },
    progress: (step) => steps.push(step),
  };
  return { host, runs, logs, steps };
}

describe("Delta app updates", () => {
  test("the background check is read-only, labels itself as pi's, and tells the person about a release", async () => {
    const { host, runs, logs } = updateHost({ check: update("update_available") });
    const updates = new InstallationUpdates();
    await updates.check(host);
    await updates.check(host);
    const checks = runs.filter((entry) => entry.argv.includes("update"));
    expect(checks).toEqual([
      { argv: ["/usr/bin/delta", "update", "--check", "--json"], env: { DELTA_CLI_INTEGRATION: "pi" } },
    ]);
    expect(logs).toEqual([
      {
        text: "Delta 1.1.0 is available (installed: 1.0.0). Run /delta-update or /delta update to update the installation.",
        to: "transcript",
      },
    ]);
  });

  test("an explicit update shows each step the CLI reports, and says what it did", async () => {
    const stderr = [
      JSON.stringify({ schema_version: 1, type: "progress", phase: "downloading", version: "1.1.0", percent: 45 }),
      "plain diagnostic",
      JSON.stringify({ schema_version: 1, type: "progress", phase: "installing", version: "1.1.0" }),
    ].join("\n");
    const { host, runs, steps } = updateHost({
      update: { stdout: update("updated", { can_install: false }), stderr: `${stderr}\n` },
    });
    expect(await new InstallationUpdates().update(host, "dedicated_command")).toBe("Updated Delta to 1.1.0.");
    expect(runs.at(-1)).toEqual({
      argv: ["/usr/bin/delta", "update", "--json"],
      env: { DELTA_CLI_INTEGRATION: "pi", DELTA_CLI_COMMAND_FORM: "dedicated_command" },
    });
    expect(steps).toEqual([
      { phase: "checking" },
      { phase: "downloading", version: "1.1.0", percent: 45 },
      { phase: "installing", version: "1.1.0" },
      undefined,
    ]);
  });

  test("responses and progress lines outside the schema are refused or skipped", () => {
    expect(() => parseInstallUpdate(JSON.stringify({ schema_version: 2 }))).toThrow("Unexpected Delta update response");
    expect(() => parseInstallUpdate(update("updated", { latest_version: null }))).toThrow();
    expect(parseProgressEvent("downloading…")).toBeUndefined();
    expect(
      parseProgressEvent(JSON.stringify({ schema_version: 1, type: "progress", phase: "downloading", percent: 101 })),
    ).toBeUndefined();
    expect(
      parseProgressEvent(
        JSON.stringify({
          schema_version: 1,
          type: "action_required",
          action: "approve_installer",
          message: "Approve it",
        }),
      ),
    ).toEqual({ type: "action_required", action: "approve_installer", message: "Approve it" });
  });
});

/** A sign-in host whose CLI answers each `auth` request from `answers`, in order. */
function authHost(answers: Record<string, unknown>[], asked: string[] = [], choose = "Sign in") {
  const requests: string[][] = [];
  const opened: string[] = [];
  const notices: string[] = [];
  const host: AuthenticationHost = {
    windows: false,
    sleep: (milliseconds, signal) =>
      new Promise((resolve, reject) => {
        if (signal.aborted) return reject(new Error("stopped"));
        const timer = setTimeout(resolve, Math.min(milliseconds, 5));
        signal.addEventListener("abort", () => (clearTimeout(timer), reject(new Error("stopped"))), { once: true });
      }),
    spawn: (argv) => {
      requests.push(argv.slice(3));
      const answer = answers.shift() ?? { status: "signed_in" };
      return stream(JSON.stringify(answer), "", answer.status === "signed_in" || answer.status === "pending" ? 0 : 1);
    },
    ask: async (question) => {
      asked.push(question);
      return question.includes("beta terms") ? "Open the beta terms" : choose;
    },
    open: async (url) => (opened.push(url), true),
    waiting: () => {},
    stop: new AbortController().signal,
  };
  return { host, requests, opened, notices, notice: async (text: string) => void notices.push(text) };
}

describe("sign-in", () => {
  test("a signed-in account asks nothing", async () => {
    const asked: string[] = [];
    const { host, requests, notice } = authHost([{ status: "signed_in" }], asked);
    await requireAuthentication(host, "/usr/bin/delta", async () => {}, notice);
    expect(requests).toEqual([["status"]]);
    expect(asked).toEqual([]);
  });

  test("signing in waits on the browser after the person agrees, and declining says how to retry", async () => {
    const pending = {
      status: "pending",
      login_id: "l-1",
      url: "https://delta.dev/login/l-1",
      expires_at: "2099-01-01T00:00:00Z",
    };
    const { host, requests, notices, notice } = authHost([{ status: "signed_out" }, pending, { status: "signed_in" }]);
    await requireAuthentication(host, "/usr/bin/delta", async () => {}, notice);
    expect(requests).toEqual([["status"], ["login", "--no-wait"], ["wait", "l-1"]]);
    expect(notices.at(-1)).toContain("https://delta.dev/login/l-1");
    const declined = authHost([{ status: "signed_out" }], [], "Not now");
    const refusal = requireAuthentication(
      declined.host,
      "/usr/bin/delta",
      async () => {},
      declined.notice,
      "/delta-share",
    );
    await expect(refusal).rejects.toThrow(
      new AccessRequiredError("Delta isn't signed in. Run /delta-share again to sign in."),
    );
  });

  test("unaccepted beta terms open in the browser, and sign-in carries on once they are accepted", async () => {
    const denied = { status: "access_denied", reason: "terms_not_accepted", url: "https://zed.dev/delta/terms" };
    const { host, opened, requests, notice } = authHost([denied, denied, { status: "signed_in" }]);
    await requireAuthentication(host, "/usr/bin/delta", async () => {}, notice);
    expect(opened).toEqual(["https://zed.dev/delta/terms"]);
    expect(requests).toEqual([["status"], ["status"], ["status"]]);
  });
});
