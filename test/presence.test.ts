import { expect, test } from "vitest";
import { PresenceTracker } from "../src/watch/presence.ts";

const ada = { user_id: "ada", name: "Ada" };
const bob = { user_id: "bob", name: "Bob" };

const names = (tracker: PresenceTracker) =>
  tracker.roster().map(({ name, arriving, leaving }) => `${name}${arriving ? "+" : ""}${leaving ? "-" : ""}`);

test("presence debounces arrivals, highlights the latest, and lists departures through their grace", () => {
  const { tracker, report, fire } = harness();
  report([ada]);
  expect(names(tracker)).toEqual(["Ada"]);
  report([ada, bob]);
  expect(names(tracker)).toEqual(["Ada"]);
  fire(3000);
  expect(names(tracker)).toEqual(["Ada", "Bob+"]);
  fire(4000);
  expect(names(tracker)).toEqual(["Ada", "Bob"]);
  report([bob]);
  expect(names(tracker)).toEqual(["Ada-", "Bob"]);
  fire(5000);
  expect(names(tracker)).toEqual(["Bob"]);
});

test("a peer reconnecting within departure grace causes no churn; own reconnect resets the baseline", () => {
  const { tracker, report, fire, changes } = harness();
  report([ada, bob]);
  report([ada]);
  report([ada, bob]);
  fire(5000);
  expect(names(tracker)).toEqual(["Ada", "Bob"]);
  expect(changes()).toBe(0);
  tracker.reset();
  report([ada, bob]);
  expect(names(tracker)).toEqual(["Ada", "Bob"]);
});

test("join flicker cancels pending arrivals and reports one settled arrival", () => {
  const { tracker, report, fire, changes } = harness();
  report([ada]);
  for (let index = 0; index < 4; index++) {
    report([ada, bob]);
    report([ada]);
    fire(3000);
    expect(names(tracker)).toEqual(["Ada"]);
  }
  report([ada, bob]);
  fire(3000);
  expect(names(tracker)).toEqual(["Ada", "Bob+"]);
  expect(changes()).toBe(1);
});

function harness() {
  const tracker = new PresenceTracker();
  const timers: { milliseconds: number; action: () => void; cancelled: boolean }[] = [];
  let changed = 0;
  return {
    tracker,
    report(users: { user_id: string; name: string }[]) {
      tracker.update(
        users,
        (milliseconds, action) => {
          const timer = { milliseconds, action, cancelled: false };
          timers.push(timer);
          return {
            cancel() {
              timer.cancelled = true;
            },
          };
        },
        () => {
          changed++;
        },
      );
    },
    fire(milliseconds: number) {
      for (const timer of timers.filter((timer) => timer.milliseconds === milliseconds)) {
        timers.splice(timers.indexOf(timer), 1);
        if (!timer.cancelled) timer.action();
      }
    },
    changes: () => changed,
  };
}
