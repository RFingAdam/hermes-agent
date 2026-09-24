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
 */
import { atom } from '@hermes/plugin-sdk'

import { GROUP_CHAT_MAX_MESSAGES, GROUP_CHAT_MAX_ROUNDS } from './group-chat'
import { getPluginCtx } from './shared'

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
  maxMessages: number
  maxRounds: number
  /** Null = no wall-clock cap (stock). */
  wallClockMs: null | number
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

/** Effective ceilings for a room drive — a live read, since the pref and
 *  its override can change between drives. */
export function getGroupChatCeilings(): GroupChatCeilings {
  if (!$groupChatExtendedMode.get()) {
    return {
      maxRounds: GROUP_CHAT_MAX_ROUNDS,
      maxMessages: GROUP_CHAT_MAX_MESSAGES,
      wallClockMs: null
    }
  }

  return {
    maxRounds: extendedOverride.maxRounds ?? GROUP_CHAT_EXTENDED_MAX_ROUNDS,
    maxMessages: extendedOverride.maxMessages ?? GROUP_CHAT_EXTENDED_MAX_MESSAGES,
    wallClockMs: extendedOverride.wallClockMs ?? GROUP_CHAT_EXTENDED_WALL_CLOCK_MS
  }
}
