import type { AppDict } from "@/lib/app-i18n";
import { AGENT_IDS, type AgentId } from "@/lib/agents";

/**
 * The words the approval card reads (rule 1222). The app passes its whole dictionary, which has these; the public home
 * page's gallery passes only this slice (`approvalDict`), so the page does not carry the app's dictionary to the browser.
 */
export type ApprovalDict = {
  channelNames: AppDict["channelNames"];
  chat: Pick<AppDict["chat"], "approveFail" | "approved" | "undo" | "copyTo" | "xflagHint" | "readNotes">;
  inbox: Pick<AppDict["inbox"], "xNote" | "xNotes" | "approved" | "pending" | "copy" | "waitAdmin" | "approve">;
  team: { errors: Pick<AppDict["team"]["errors"], "forbidden"> };
  agents: Record<AgentId, { name: string }>;
};

/** The approval card's slice of one language's app dictionary. */
export function approvalDict(t: AppDict): ApprovalDict {
  const { approveFail, approved, undo, copyTo, xflagHint, readNotes } = t.chat;
  const { xNote, xNotes, approved: done, pending, copy, waitAdmin, approve } = t.inbox;
  return {
    channelNames: t.channelNames,
    chat: { approveFail, approved, undo, copyTo, xflagHint, readNotes },
    inbox: { xNote, xNotes, approved: done, pending, copy, waitAdmin, approve },
    team: { errors: { forbidden: t.team.errors.forbidden } },
    agents: Object.fromEntries(AGENT_IDS.map((id) => [id, { name: t.agents[id].name }])) as Record<AgentId, { name: string }>,
  };
}
