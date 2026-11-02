/**
 * The `/delta` command and its dedicated forms: parsing, the menu, and running each action.
 */
import { exists } from "../core/files.ts";
import type { Host } from "../core/host.ts";
import { isOneOf } from "../core/json.ts";
import { activation, recoveryCommand, requests, stateFor } from "../core/session-state.ts";
import { errorText } from "../core/text.ts";
import { type CommandForm, orgCommand } from "../cli/delta-cli.ts";
import { InstallationUpdates, type UpdateHost } from "../cli/install-update.ts";
import { setProgress, showUpdateProgress } from "../band/band.ts";
import { beginRefusalResolution } from "../recording/delivery.ts";
import { type SessionSwitch, startJoin } from "../sharing/join.ts";
import { shareFailureText, startShare } from "../sharing/share.ts";
import { pluginUpdateCommand, type Reload } from "../updates/updates.ts";
import { statusLink } from "../band/band.ts";
import { activate, refreshReminder } from "./activation.ts";
import { chooseDeltaAction, type MenuStart } from "./delta-menu.ts";
import { interaction, offerToStopWaiting, setupEnv } from "./interaction.ts";
import { currentOrganizationId, listOrganizations } from "./organizations.ts";
import {
  DASHBOARD_URL,
  emailsIn,
  HEADLESS_REFUSAL,
  InteractionDismissedError,
  InteractionUnavailableError,
  membersUrl,
  openMembersPage,
  type Organization,
  runSetupWizard,
} from "./setup.ts";

/** What only a command handler may do: switch pi to another session, and reload its extensions. */
export type CommandControl = SessionSwitch & Reload;

/** What a command answers: text for the transcript, or nothing when its progress belongs to the band. */
export type CommandAnswer = { text?: string };

/** Run `/delta setup` for the active session and answer with what it did. */
async function setupCommand(host: Host): Promise<string> {
  if (!host.session.interactive()) return HEADLESS_REFUSAL;
  const outcome = await runSetupWizard(setupEnv(host), interaction(host));
  if (outcome.status === "wrote") await refreshReminder(host, host.session.id());
  return outcome.text;
}

/** Every `/delta` action, for a session that can't show the menu and for an action it doesn't know. */
export const DELTA_USAGE =
  "Usage: /delta share [<email>…] | /delta join <shared-link-or-thread> | /delta setup | /delta update | /delta plugin-update [check | notifications on|off] | /delta org list | /delta org current | /delta org switch <ID> | /delta org invite <email>… | /delta org manage | /delta link | /delta copy | /delta resolve";
/** `/delta-join` typed without its link. */
export const JOIN_USAGE =
  "Usage: /delta-join <link>. Paste the Delta link someone shared with you, such as /delta-join https://delta.dev/join/…, or a thread ID.";
/** `/delta-org` typed without an action. */
export const ORG_USAGE =
  "Usage: /delta-org list (your teams), /delta-org current (the selected one), /delta-org switch <ID>, /delta-org invite <email>… (invite people to the selected one), or /delta-org manage (open the selected one on the dashboard).";

/** The commands this extension adds, each also a `/delta` action, with what pi's command menu shows. */
export const COMMANDS = [
  {
    name: "delta",
    description: "Share or join a Delta session, set up syncing, choose a team, or update Delta",
    actions: [
      "share",
      "join",
      "setup",
      "update",
      "plugin-update",
      "org list",
      "org current",
      "org switch",
      "org invite",
      "org manage",
      "link",
      "copy",
      "resolve",
    ],
  },
  {
    name: "delta-share",
    description: "Delta: sync this session and its code to DeltaDB, and choose who sees it [<email>…]",
  },
  { name: "delta-join", description: "Delta: join a shared conversation. Needs its link: /delta-join <link>" },
  { name: "delta-setup", description: "Delta: choose which sessions in this repository sync to DeltaDB" },
  { name: "delta-update", description: "Delta: update the installed Delta app and CLI" },
  {
    name: "delta-plugin-update",
    description: "Delta: update this pi extension [check | notifications on|off]",
    actions: ["check", "notifications on", "notifications off"],
  },
  {
    name: "delta-org",
    description: "Delta: manage your team. /delta-org list, current, switch <ID>, invite <email>, or manage",
    actions: ["list", "current", "switch", "invite", "manage"],
  },
] as const;

/**
 * Answer a command typed without what it needs, such as bare `/delta`, with a menu of its actions,
 * and run the chosen one. A session that can't ask gets `usage` instead, and choosing nothing adds
 * nothing to the transcript.
 */
export async function deltaMenu(
  host: Host,
  start: MenuStart,
  usage: string,
  form: CommandForm,
  replace?: CommandControl,
): Promise<CommandAnswer> {
  if (!host.session.interactive()) return { text: usage };
  let action: string | undefined;
  try {
    action = await chooseDeltaAction(interaction(host), start);
  } catch (error) {
    if (error instanceof InteractionDismissedError) return {};
    if (error instanceof InteractionUnavailableError) return { text: usage };
    throw error;
  }
  return action ? runDeltaCommand(host, action, form, replace) : {};
}

/** Open the selected organization's members page on the dashboard; a headless session gets the link. */
async function manageOrganization(host: Host): Promise<string> {
  let organization: Organization | undefined;
  try {
    organization = (await listOrganizations(host)).find((known) => known.current);
  } catch (error) {
    return `Delta couldn't read your current team (${errorText(error)}). Manage your teams here: ${DASHBOARD_URL}`;
  }
  if (!organization) return `Delta has no team selected. Manage your teams here: ${DASHBOARD_URL}`;
  const interactive = host.session.interactive();
  return openMembersPage({ openLink: async (url) => interactive && host.ui.open(url) }, organization);
}

export function installUpdateHost(host: Host): UpdateHost {
  return {
    run: (argv, init) => host.process.run(argv, init),
    spawn: (init) => host.process.spawn(init),
    windows: async () => host.env.windows(),
    exists,
    after: (milliseconds, callback) => host.clock.after(milliseconds, callback),
    log: async (text, to) => {
      if (to === "debug") host.ui.debug(text);
      else host.ui.note(text);
    },
    progress: (step) => showUpdateProgress(host, step),
  };
}

const NO_LINK = "This session has no Delta link yet. Share it with /delta-share first.";

/** Copy the thread's link, which the band shows, to the clipboard. */
async function copyLink(host: Host): Promise<string> {
  const link = statusLink();
  if (!link) return NO_LINK;
  return (await host.ui.copy(link)) ? `Copied ${link}` : `Couldn't copy the link; here it is: ${link}`;
}

/** Ask the person how to resolve the offline changes Delta refused: Fork & Restore, or Discard. */
async function resolveCommand(host: Host): Promise<string | undefined> {
  const session = host.session.id();
  if (!stateFor(session).refusedOffline) return "Delta has no rejected offline changes to resolve in this session.";
  if (!host.session.interactive()) return "Run /delta resolve in pi's terminal to choose Fork & Restore or Discard.";
  const fork = "Fork & Restore";
  const discard = "Discard";
  let answer: string;
  try {
    answer = await interaction(host).ask(
      "Delta couldn't publish this thread's offline changes because someone else changed the thread. Fork & Restore keeps them in a new thread; Discard drops them. Either way this thread carries on from what everyone else sees.",
      {
        options: [fork, discard, "Cancel"],
        header: "Delta",
        descriptions: { [fork]: "Keep the changes in a new thread", [discard]: "Drop the rejected changes" },
      },
    );
  } catch {
    return;
  }
  if (answer !== fork && answer !== discard) return;
  return beginRefusalResolution(host, session, answer === fork ? "fork" : "discard")
    ? undefined
    : "Delta is already resolving this thread's offline changes. Wait for its result.";
}

/** Run one `/delta` action, such as `share` or `join <link>`, from `/delta`, its menu, or a dedicated command. */
export async function runDeltaCommand(
  host: Host,
  action: string,
  form: CommandForm,
  replace?: CommandControl,
): Promise<CommandAnswer> {
  if (action === "plugin-update" || action.startsWith("plugin-update "))
    return pluginUpdateCommand(host, action.slice("plugin-update".length).trim(), replace);
  if (action === "update") return { text: await installationUpdates.update(installUpdateHost(host), form) };
  if (action === "org manage") return { text: await manageOrganization(host) };
  if (action === "link") return { text: statusLink() ?? NO_LINK };
  if (action === "copy") return { text: await copyLink(host) };
  if (action === "resolve") return { text: await resolveCommand(host) };
  // A share, join, or setup started now would sign in again beside the wait, so it asks about that instead.
  if (/^(?:setup|share|join)\b/.test(action) && (await offerToStopWaiting(host))) return {};
  // The setup wizard only writes the checkout's policy; it needs no session binding or activation.
  if (action === "setup") return { text: await setupCommand(host) };
  const locator = /^join\s+(\S+)$/.exec(action)?.[1];
  const organization = /^org\s+(?:(list|current)|(switch)\s+(\S+))$/.exec(action);
  const invite = /^org\s+invite\b\s*(.*)$/.exec(action)?.[1];
  // `/delta share` asks who should see the session; addresses typed after it answer that up front.
  const shareArguments = /^share(?:\s+(.*))?$/.exec(action)?.[1] ?? "";
  const shareEmails = emailsIn(shareArguments);
  const shareAction = /^share\b/.test(action) && (!shareArguments.trim() || shareEmails.length > 0);
  if (!shareAction && !locator && !organization && invite === undefined) return { text: DELTA_USAGE };
  if (requests.join) return { text: "A Delta join is already in progress. Wait for its result." };
  if (requests.share) return { text: "A Delta share is already in progress. Wait for its result." };
  if (organization)
    return orgCommand(
      host,
      isOneOf(organization[1], ["list", "current"]) ? organization[1] : { switch: organization[3]! },
    );
  if (invite !== undefined) {
    const emails = emailsIn(invite);
    if (!emails.length) {
      // The current organization is known once anything has listed them; otherwise link the dashboard itself.
      const members = currentOrganizationId ? membersUrl(currentOrganizationId) : DASHBOARD_URL;
      return {
        text: `Usage: /delta-org invite <email> [<email>…]. Invites people to your current Delta team. To invite many people at once, use the dashboard: ${members}`,
      };
    }
    return orgCommand(host, { invite: emails });
  }
  const session = host.session.id();
  try {
    if (session !== activation.session || !stateFor(session).binding) await activate(host, session);
    // Sharing and joining report through the band and ask through dialogs, which only these sessions have.
    if (!host.session.interactive())
      return {
        text: `${locator ? "/delta-join" : "/delta-share"} needs pi's interactive terminal or an RPC client that shows dialogs. Print and JSON modes aren't supported.`,
      };
    if (stateFor(session).binding?.child)
      return { text: "This session is a subagent recorded under its parent's Delta thread." };
    if (locator) {
      if (!host.session.idle() || stateFor(session).promptEntering)
        return { text: "Wait for the current pi turn to finish before joining." };
      if (!replace) return { text: "Run /delta-join from pi's command line to join a thread." };
      await startJoin(host, { session, cwd: host.session.cwd(), locator, form }, replace);
      // Progress belongs to the band; a command with no text adds no transcript row.
      return {};
    }
    if (!host.session.idle()) return { text: "Wait for the current pi turn to finish before sharing." };
    startShare(host, { session, cwd: host.session.cwd(), form, choose: { emails: shareEmails } });
    return {};
  } catch (error) {
    // Only activation can fail here; the share or join itself reports in the band and transcript.
    const text = shareFailureText(
      error,
      locator ? `/delta-join ${locator}` : recoveryCommand(stateFor(session).binding),
    );
    setProgress(host, text, "error");
    return { text };
  }
}

export const installationUpdates = new InstallationUpdates();
