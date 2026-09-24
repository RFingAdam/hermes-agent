/**
 * The room work loop: a member that takes on a task keeps the floor across
 * rounds until it decides it is finished, instead of stopping after one
 * message.
 *
 * The protocol mirrors the "(pass)" contract. A member ends a turn with
 * "(working)" to keep the floor, or "(done)" / "(blocked)" with a report to
 * release it; a member that says nothing special behaves exactly as before.
 * Only an explicit "(working)" keeps the floor, so a member that forgets the
 * sentinel simply stops rather than holding the room to the backstop.
 *
 * There is deliberately NO turn ceiling on an open claim — the member decides
 * when it is done, and the room's round, message and wall-clock ceilings do
 * not cut it off mid-task. Two exits remain: repeating itself for
 * GROUP_WORK_NO_PROGRESS_LIMIT turns releases the claim with a room note, and
 * GROUP_WORK_HARD_TURN_BACKSTOP rounds (matching delegation.max_iterations)
 * ends the drive.
 *
 * Claims are keyed by member at room scope, beside `holds`, and persist with
 * the room record, so a window restart resumes the loop on the next drive of
 * that thread. A held member's claim is ignored until the hold is released.
 */
import { recordGroupActivity } from './group-activity'
import { $groupChats, appendGroupChatEntry, updateGroupChat } from './group-chat'
import { groupMemberKey } from './group-membership'
import { isGroupPassText } from './group-turns'
import type { GroupChat, GroupMember } from './types'

export const GROUP_WORK_NO_PROGRESS_LIMIT = 5
export const GROUP_WORK_HARD_TURN_BACKSTOP = 250

/** What a finished turn said about its own work. */
export type GroupTurnIntent = 'done' | 'pass' | 'reply' | 'working'

export function groupTurnIntent(text: unknown): GroupTurnIntent {
  const trimmed = String(text || '').trim()

  if (isGroupPassText(trimmed)) {
    return 'pass'
  }

  if (/\(\s*working\s*\)\.?$/i.test(trimmed)) {
    return 'working'
  }

  if (/\(\s*(done|blocked)\s*\)\.?$/i.test(trimmed)) {
    return 'done'
  }

  return 'reply'
}

/** Whether the room runs the work loop. On by default; a room opts out with
 *  `workLoop: false`, which is the only value ever stored. */
export function groupChatWorkLoopEnabled(room: Pick<GroupChat, 'workLoop'> | null | undefined): boolean {
  return room?.workLoop !== false
}

/** Per-room work-loop switch. Stored only when OFF, so rooms that predate
 *  the flag need no migration. The loop never grants tools: a chat-only
 *  preset still loops for multi-turn reasoning. */
export function setGroupChatWorkLoop(group: string, enabled: boolean) {
  updateGroupChat(group, room => {
    const next = { ...room }

    if (enabled) {
      delete next.workLoop
    } else {
      next.workLoop = false
    }

    return next
  })

  return enabled
}

/** Signature used to spot a member repeating itself. Whitespace- and
 *  case-insensitive, so trivial rewording does not count as progress. */
export function groupWorkSignature(text: unknown): string {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .slice(0, 400)
}

/** Member keys holding an open claim on `thread`, held members excluded. */
export function openGroupWorkClaims(group: string, thread: string): string[] {
  const room = $groupChats.get()[group]
  const working = room?.working || {}
  const holds = room?.holds || {}

  return Object.keys(working).filter(
    key => working[key]?.thread === thread && !Object.prototype.hasOwnProperty.call(holds, key)
  )
}

export function hasOpenGroupWorkClaims(group: string, thread: string): boolean {
  return openGroupWorkClaims(group, thread).length > 0
}

/** Record a member's continued claim. 'stuck' means it has now repeated
 *  itself GROUP_WORK_NO_PROGRESS_LIMIT times and the claim was released. */
export function noteGroupWorkClaim(group: string, thread: string, memberKey: string, reply: string): 'ok' | 'stuck' {
  const signature = groupWorkSignature(reply)
  let verdict: 'ok' | 'stuck' = 'ok'

  updateGroupChat(group, room => {
    const working = { ...(room.working || {}) }
    const prior = working[memberKey]
    const repeats = prior && prior.signature === signature ? (prior.repeats || 0) + 1 : 0

    if (repeats + 1 >= GROUP_WORK_NO_PROGRESS_LIMIT) {
      verdict = 'stuck'
      delete working[memberKey]
    } else {
      working[memberKey] = {
        thread,
        turns: (prior?.turns || 0) + 1,
        startedAt: prior?.startedAt || Date.now(),
        signature,
        repeats
      }
    }

    return { ...room, working }
  })

  return verdict
}

export function clearGroupWorkClaim(group: string, memberKey: string) {
  if (!Object.prototype.hasOwnProperty.call($groupChats.get()[group]?.working || {}, memberKey)) {
    return
  }

  updateGroupChat(group, room => {
    const working = { ...(room.working || {}) }
    delete working[memberKey]

    return { ...room, working }
  })
}

/** Per-thread ownership. A thread with an assignee is that member's lane:
 *  nobody else is dispatched into it, so two members cannot both decide a
 *  task is theirs. Coordination in chat ("assigning t_123 to @backend") is a
 *  statement of intent; this is what actually enforces it. */
export function groupThreadAssignee(group: string, thread: string): null | string {
  return $groupChats.get()[group]?.assignments?.[thread] || null
}

/** Assign `thread` to a member key; a falsy key clears it and reopens the thread. */
export function setGroupThreadAssignee(group: string, thread: string, memberKey: null | string | undefined) {
  updateGroupChat(group, room => {
    const assignments = { ...(room.assignments || {}) }

    if (memberKey) {
      assignments[thread] = memberKey
    } else {
      delete assignments[thread]
    }

    return { ...room, assignments }
  })

  return memberKey || null
}

/** Narrow a thread's candidates to its lane. An assignee who is no longer
 *  seated in the room does not strand the thread: it reopens to everyone. */
export function filterToGroupThreadLane(group: string, thread: string, members: GroupMember[]): GroupMember[] {
  const assignee = groupThreadAssignee(group, thread)

  if (!assignee || !members.some(member => groupMemberKey(member) === assignee)) {
    return members
  }

  return members.filter(member => groupMemberKey(member) === assignee)
}

/** Apply one committed member reply to the work loop: "(working)" keeps (or
 *  opens) the member's claim, anything else releases it. A member that has
 *  stopped making progress loses its claim and the room says why. */
export function applyGroupWorkTurn(group: string, thread: string, member: GroupMember, reply: string) {
  const memberKey = groupMemberKey(member)
  const intent = groupTurnIntent(reply)

  if (intent !== 'working') {
    clearGroupWorkClaim(group, memberKey)

    return intent
  }

  if (noteGroupWorkClaim(group, thread, memberKey, reply) === 'stuck') {
    appendGroupChatEntry(
      group,
      { kind: 'system', name: 'Work loop' },
      `@${member.name} made no new progress for ${GROUP_WORK_NO_PROGRESS_LIMIT} turns, so the claim was released. Last state:\n\n${String(reply).trim().slice(0, 400)}`,
      thread
    )
    recordGroupActivity(group, { kind: 'stalled', member: memberKey, thread })
  }

  return intent
}
