/**
 * How long one room drive may run: the round, message and wall-clock
 * ceilings a single user send can spend.
 *
 * Default OFF means exact upstream behavior — GROUP_CHAT_MAX_ROUNDS /
 * GROUP_CHAT_MAX_MESSAGES and no wall-clock cap. "Extended rounds" is an
 * install-wide opt-in for rooms that should keep working turn over turn
 * instead of hitting the 3-round wall mid-task, and it brings a protection
 * stock never had: a wall-clock ceiling on the whole drive. The all-pass
 * settle exit is conversation-shaped (it only fires when literally every
 * member passes), so many more rounds widen the exposure to a member stuck
 * producing real-looking, non-settling text every turn; the deadline bounds
 * worst-case cost and duration whether or not that heuristic ever fires.
 *
 * A room can instead carry its own preset (`room.mode`: build / decide /
 * standing), which overrides the install-wide toggle for that room only.
 * Unset rooms keep exactly the toggle's behavior.
 */
import { atom } from '@hermes/plugin-sdk'

import {
  $groupChats,
  appendGroupChatEntry,
  GROUP_CHAT_MAX_MEMBERS,
  GROUP_CHAT_MAX_MESSAGES,
  GROUP_CHAT_MAX_ROUNDS,
  groupThreadOf,
  normalizeGroupChatRoomMode,
  updateGroupChat
} from './group-chat'
import { groupChatWorkLoopEnabled } from './group-work'
import { getPluginCtx } from './shared'
import type { GroupChatRoomMode, GroupMember } from './types'

export const GROUP_CHAT_EXTENDED_MAX_ROUNDS = 24
export const GROUP_CHAT_EXTENDED_MAX_MESSAGES = 120
export const GROUP_CHAT_EXTENDED_WALL_CLOCK_MS = 30 * 60 * 1000

export const GROUP_CHAT_EXTENDED_MODE_KEY = 'group-chat-extended-mode'
export const GROUP_CHAT_EXTENDED_OVERRIDE_KEY = 'group-chat-extended-override'

// Hard ranges an override can never escape, whatever storage holds.
const OVERRIDE_MAX_ROUNDS = 100
const OVERRIDE_MAX_MESSAGES = 500
const OVERRIDE_MIN_WALL_CLOCK_MS = 1000
const OVERRIDE_MAX_WALL_CLOCK_MS = 2 * 60 * 60 * 1000

interface GroupChatModePreset {
  /** Posts a deterministic room summary when a ceiling (not consensus) ends the drive. */
  autoSummaryOnCap: boolean
  maxRounds: number
  /** Message budget = this × members × rounds, so a five-bot room can finish
   *  its stated rounds instead of dying on a flat cap at round two. */
  messagesPerMemberPerRound: number
  /** False adds a chat-only rule to every turn prompt. */
  toolCapable: boolean
  wallClockMs: number
}

export const GROUP_CHAT_MODE_PRESETS: Readonly<Record<GroupChatRoomMode, GroupChatModePreset>> = Object.freeze({
  // Long, tool-capable work sessions.
  build: {
    maxRounds: 24,
    messagesPerMemberPerRound: 3,
    wallClockMs: 60 * 60 * 1000,
    toolCapable: true,
    autoSummaryOnCap: false
  },
  // Tight, chat-only decisions that always end in a summary.
  decide: {
    maxRounds: 4,
    messagesPerMemberPerRound: 2,
    wallClockMs: 15 * 60 * 1000,
    toolCapable: false,
    autoSummaryOnCap: true
  },
  // Moderate multi-trigger coordination.
  standing: {
    maxRounds: 8,
    messagesPerMemberPerRound: 2,
    wallClockMs: 30 * 60 * 1000,
    toolCapable: false,
    autoSummaryOnCap: false
  }
})

/** User pref: extended group-chat rounds. Default OFF; persisted via
 *  ctx.storage. Not retroactive to a running drive — ceilings are read once
 *  per drive. */
export const $groupChatExtendedMode = atom(false)

export interface GroupChatExtendedOverride {
  maxMessages?: number
  maxRounds?: number
  wallClockMs?: number
}

/** Optional fine-tuning of the extended ceilings, consulted ONLY while
 *  extended mode is on: turning it off always restores the exact stock
 *  constants, whatever is stored here. */
let extendedOverride: GroupChatExtendedOverride = {}

export interface GroupChatCeilings {
  /** Post summarizeGroupChat when a ceiling ends the drive. */
  autoSummary: boolean
  maxMessages: number
  maxRounds: number
  /** The room preset in effect; null = the install-wide toggle. */
  mode: GroupChatRoomMode | null
  /** False = the turn prompt forbids tools (a chat-only room). */
  toolCapable: boolean
  /** Null = no wall-clock cap (stock). */
  wallClockMs: null | number
  /** Members may keep the floor across rounds (group-work.ts). */
  workLoop: boolean
}

/** Flip extended mode and persist it. */
export function setGroupChatExtendedMode(enabled: boolean) {
  $groupChatExtendedMode.set(Boolean(enabled))

  try {
    Promise.resolve(getPluginCtx()?.storage?.set?.(GROUP_CHAT_EXTENDED_MODE_KEY, Boolean(enabled))).catch(
      () => undefined
    )
  } catch {
    /* storage unavailable — pref holds for this window only */
  }
}

/** Validate and install an extended-mode override field by field. A value
 *  outside its hard range (rounds 1-100, messages 1-500, wall-clock 1s-2h)
 *  or non-finite is DROPPED, not clamped to the boundary: an accidental huge
 *  number falls back to the safe extended default for that field instead of
 *  silently becoming "as large as allowed". Wall-clock takes whole
 *  `wallClockMinutes` (what a settings UI offers) or precise `wallClockMs`;
 *  the precise one wins when both are valid. Anything malformed resets. */
export function applyGroupChatExtendedOverride(value: unknown) {
  if (!value || typeof value !== 'object') {
    extendedOverride = {}

    return
  }

  const raw = value as Record<string, unknown>
  const next: GroupChatExtendedOverride = {}
  const rounds = Number(raw.maxRounds)
  const messages = Number(raw.maxMessages)
  const wallClockMinutes = Number(raw.wallClockMinutes)
  const wallClockMs = Number(raw.wallClockMs)

  if (Number.isFinite(rounds) && rounds >= 1 && rounds <= OVERRIDE_MAX_ROUNDS) {
    next.maxRounds = Math.floor(rounds)
  }

  if (Number.isFinite(messages) && messages >= 1 && messages <= OVERRIDE_MAX_MESSAGES) {
    next.maxMessages = Math.floor(messages)
  }

  if (
    Number.isFinite(wallClockMs) &&
    wallClockMs >= OVERRIDE_MIN_WALL_CLOCK_MS &&
    wallClockMs <= OVERRIDE_MAX_WALL_CLOCK_MS
  ) {
    next.wallClockMs = Math.floor(wallClockMs)
  } else if (
    Number.isFinite(wallClockMinutes) &&
    wallClockMinutes >= 1 &&
    wallClockMinutes * 60 * 1000 <= OVERRIDE_MAX_WALL_CLOCK_MS
  ) {
    next.wallClockMs = Math.floor(wallClockMinutes * 60 * 1000)
  }

  extendedOverride = next
}

/** Ceilings for one preset at a live member count; null for no preset. */
export function getModeCeilings(mode: unknown, memberCount: number): GroupChatCeilings | null {
  const key = normalizeGroupChatRoomMode(mode)

  if (!key) {
    return null
  }

  const preset = GROUP_CHAT_MODE_PRESETS[key]
  const members = Math.max(1, Math.min(GROUP_CHAT_MAX_MEMBERS, Math.floor(Number(memberCount) || 1)))

  return {
    maxRounds: preset.maxRounds,
    maxMessages: Math.max(members, Math.floor(preset.messagesPerMemberPerRound * members * preset.maxRounds)),
    wallClockMs: preset.wallClockMs,
    autoSummary: preset.autoSummaryOnCap,
    toolCapable: preset.toolCapable,
    mode: key,
    workLoop: true
  }
}

/** Effective ceilings for a room drive — a live read, since the pref, its
 *  override and the room's mode can all change between drives. A room preset
 *  overrides the install-wide toggle; `members` is the live roster so a
 *  preset's message budget scales with the room. */
export function getGroupChatCeilings(group?: string, members: GroupMember[] = []): GroupChatCeilings {
  const room = group ? $groupChats.get()[group] : undefined
  const memberCount = members.length || room?.members?.length || 1
  const preset = getModeCeilings(room?.mode, memberCount)
  // The work loop is independent of the preset: any mode can run with
  // members finishing tasks across turns or stopping after one message.
  const workLoop = groupChatWorkLoopEnabled(room)

  if (preset) {
    return { ...preset, workLoop }
  }

  if (!$groupChatExtendedMode.get()) {
    return {
      maxRounds: GROUP_CHAT_MAX_ROUNDS,
      maxMessages: GROUP_CHAT_MAX_MESSAGES,
      wallClockMs: null,
      autoSummary: false,
      toolCapable: true,
      mode: null,
      workLoop
    }
  }

  return {
    maxRounds: extendedOverride.maxRounds ?? GROUP_CHAT_EXTENDED_MAX_ROUNDS,
    maxMessages: extendedOverride.maxMessages ?? GROUP_CHAT_EXTENDED_MAX_MESSAGES,
    wallClockMs: extendedOverride.wallClockMs ?? GROUP_CHAT_EXTENDED_WALL_CLOCK_MS,
    autoSummary: false,
    toolCapable: true,
    mode: null,
    workLoop
  }
}

/** Set a room's preset on its record; null or an unknown value clears it. */
export function setGroupChatRoomMode(group: string, mode: unknown): GroupChatRoomMode | null {
  const next = normalizeGroupChatRoomMode(mode)

  updateGroupChat(group, room => {
    const updated = { ...room }

    if (next) {
      updated.mode = next
    } else {
      delete updated.mode
    }

    return updated
  })

  return next
}

/** A cheap, deterministic summary of one thread, posted when a decide-mode
 *  drive ends on a ceiling. No nested model turn: the exit path must not
 *  spend more or recurse. */
export function summarizeGroupChat(group: string, members: GroupMember[], thread: string) {
  const log = ($groupChats.get()[group]?.log || []).filter(entry => groupThreadOf(entry) === thread)

  if (!log.length) {
    return null
  }

  const userLines = log
    .filter(entry => entry.from?.kind === 'user')
    .map(entry => String(entry.text || '').trim())
    .filter(Boolean)

  const memberLines = log.filter(entry => entry.from?.kind === 'member')
  const speakers = [...new Set(memberLines.map(entry => entry.from.name).filter(Boolean))]
  const roster = members.map(member => member.name).filter(Boolean)
  const lastMember = memberLines.at(-1)

  const lastSnippet = lastMember
    ? `${lastMember.from.name || 'member'}: ${String(lastMember.text || '')
        .trim()
        .slice(0, 240)}`
    : '(no member replies yet)'

  const body = [
    `**Decide-mode room summary** (${group})`,
    `- Members: ${(roster.length ? roster : speakers).join(', ') || '—'}`,
    `- Turns posted: ${memberLines.length} member / ${userLines.length} user`,
    `- Last user ask: ${(userLines.at(-1) || '(no user prompt)').slice(0, 280)}`,
    `- Last member reply: ${lastSnippet}`,
    '- Status: the drive hit a decide-mode ceiling (rounds, messages or wall-clock) before the room settled.'
  ].join('\n')

  return appendGroupChatEntry(group, { kind: 'system', name: 'Summary' }, body, thread)
}
