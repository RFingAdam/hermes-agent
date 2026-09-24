import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as groupChat from './group-chat'
import type * as groupRooms from './group-room-policy'
import type * as groupRounds from './group-rounds'
import { createGroupGateway, drain, runTimersInline, scriptedStorage } from './group-test-utils'
import type { GatewayOptions, ScriptedGateway } from './group-test-utils'
import type { GroupMember } from './types'

// Drive ceilings: how long ONE user send may keep a room talking. Stock is
// upstream's exact 3 rounds / 10 messages / no wall-clock; every widening is
// an explicit opt-in with its own protection.

const { host } = vi.hoisted(() => ({ host: {} as Record<string, unknown> }))

vi.mock('@hermes/plugin-sdk', async () => {
  const { pluginSdkMock } = await import('./group-test-utils')

  return pluginSdkMock(host)
})

interface Room {
  chat: typeof groupChat
  gateway: ScriptedGateway
  policy: typeof groupRooms
  rounds: typeof groupRounds
}

async function loadRoom(options: GatewayOptions = {}): Promise<Room> {
  vi.resetModules()
  const gateway = createGroupGateway(options)

  for (const key of Object.keys(host)) {
    delete host[key]
  }

  Object.assign(host, gateway.host)

  const [chat, policy, rounds, shared] = await Promise.all([
    import('./group-chat'),
    import('./group-room-policy'),
    import('./group-rounds'),
    import('./shared')
  ])

  shared.setPluginCtx(scriptedStorage(gateway.storage))

  return { chat, gateway, policy, rounds }
}

const MEMBERS: GroupMember[] = [
  { name: 'research', title: '' },
  { name: 'builder', title: '' },
  { name: 'ops', title: '' }
]

const memberPosts = (room: Room, group: string) =>
  (room.chat.$groupChats.get()[group]?.log || []).filter(entry => entry.from.kind === 'member')

async function settle(room: Room, group: string) {
  await drain(() => Boolean(room.chat.$groupChats.get()[group]?.running), 2000)
}

beforeEach(() => {
  runTimersInline()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('extended rounds', () => {
  it('defaults to exactly the stock ceilings, with no wall-clock cap', async () => {
    const { chat, policy } = await loadRoom()

    expect(policy.$groupChatExtendedMode.get()).toBe(false)
    expect(policy.getGroupChatCeilings()).toEqual({
      maxRounds: chat.GROUP_CHAT_MAX_ROUNDS,
      maxMessages: chat.GROUP_CHAT_MAX_MESSAGES,
      wallClockMs: null
    })
  })

  it('raises the ceilings and adds a wall-clock cap when on; off restores exact stock', async () => {
    const { chat, gateway, policy } = await loadRoom()

    policy.setGroupChatExtendedMode(true)
    await Promise.resolve()

    expect(policy.getGroupChatCeilings()).toEqual({
      maxRounds: policy.GROUP_CHAT_EXTENDED_MAX_ROUNDS,
      maxMessages: policy.GROUP_CHAT_EXTENDED_MAX_MESSAGES,
      wallClockMs: policy.GROUP_CHAT_EXTENDED_WALL_CLOCK_MS
    })
    expect(gateway.storage.get(policy.GROUP_CHAT_EXTENDED_MODE_KEY)).toBe(true)

    policy.setGroupChatExtendedMode(false)

    expect(policy.getGroupChatCeilings()).toEqual({
      maxRounds: chat.GROUP_CHAT_MAX_ROUNDS,
      maxMessages: chat.GROUP_CHAT_MAX_MESSAGES,
      wallClockMs: null
    })
  })

  it('drops out-of-range or malformed override fields instead of clamping them', async () => {
    const { policy } = await loadRoom()
    policy.setGroupChatExtendedMode(true)

    policy.applyGroupChatExtendedOverride({ maxRounds: 50, maxMessages: 300, wallClockMinutes: 10 })
    expect(policy.getGroupChatCeilings()).toEqual({ maxRounds: 50, maxMessages: 300, wallClockMs: 600_000 })

    // Too high AND below the floor are both rejected per field, falling back
    // to the extended default — never silently becoming "as large as allowed".
    policy.applyGroupChatExtendedOverride({ maxRounds: 0, maxMessages: 99_999, wallClockMinutes: 999 })
    expect(policy.getGroupChatCeilings()).toEqual({
      maxRounds: policy.GROUP_CHAT_EXTENDED_MAX_ROUNDS,
      maxMessages: policy.GROUP_CHAT_EXTENDED_MAX_MESSAGES,
      wallClockMs: policy.GROUP_CHAT_EXTENDED_WALL_CLOCK_MS
    })

    policy.applyGroupChatExtendedOverride({ wallClockMs: 20 })
    expect(policy.getGroupChatCeilings().wallClockMs).toBe(policy.GROUP_CHAT_EXTENDED_WALL_CLOCK_MS)

    // The precise millisecond field wins over whole minutes.
    policy.applyGroupChatExtendedOverride({ wallClockMs: 1500, wallClockMinutes: 5 })
    expect(policy.getGroupChatCeilings().wallClockMs).toBe(1500)

    for (const malformed of [null, 'nonsense', 42]) {
      policy.applyGroupChatExtendedOverride({ maxRounds: 20 })
      policy.applyGroupChatExtendedOverride(malformed)
      expect(policy.getGroupChatCeilings().maxRounds).toBe(policy.GROUP_CHAT_EXTENDED_MAX_ROUNDS)
    }
  })

  it('ignores a staged override entirely while extended mode is off', async () => {
    const { chat, policy } = await loadRoom()

    policy.applyGroupChatExtendedOverride({ maxRounds: 99, wallClockMs: 1000 })

    expect(policy.getGroupChatCeilings()).toEqual({
      maxRounds: chat.GROUP_CHAT_MAX_ROUNDS,
      maxMessages: chat.GROUP_CHAT_MAX_MESSAGES,
      wallClockMs: null
    })
  })

  it('lets a chatty room run past the stock message cap once extended', async () => {
    const chatty = { turn: ({ n }: { n: number }) => `message ${n} — @everyone keep going` }
    const stock = await loadRoom(chatty)

    stock.rounds.sendToGroupChat('Loud', MEMBERS, 'go')
    await settle(stock, 'Loud')

    expect(memberPosts(stock, 'Loud').length).toBeLessThanOrEqual(stock.chat.GROUP_CHAT_MAX_MESSAGES)

    const extended = await loadRoom(chatty)
    extended.policy.setGroupChatExtendedMode(true)
    extended.policy.applyGroupChatExtendedOverride({ maxRounds: 6, maxMessages: 15 })

    extended.rounds.sendToGroupChat('Loud', MEMBERS, 'go')
    await settle(extended, 'Loud')

    expect(memberPosts(extended, 'Loud')).toHaveLength(15)
  })

  it('enforces a tuned-down extended message cap', async () => {
    const room = await loadRoom({ turn: ({ n }) => `message ${n} — @everyone keep going` })
    room.policy.setGroupChatExtendedMode(true)
    room.policy.applyGroupChatExtendedOverride({ maxRounds: 24, maxMessages: 2 })

    room.rounds.sendToGroupChat('Capped', MEMBERS, 'go wild but capped')
    await settle(room, 'Capped')

    expect(memberPosts(room, 'Capped')).toHaveLength(2)
  })

  it('ends a non-settling drive at the wall-clock deadline, well before the round cap', async () => {
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)

    // Every turn "takes" 400ms and says something new, so only the deadline
    // can stop this drive: rounds and messages are set far out of reach.
    const room = await loadRoom({
      turn: ({ n }) => {
        now += 400

        return `still working, turn ${n} — @everyone`
      }
    })

    room.policy.setGroupChatExtendedMode(true)
    room.policy.applyGroupChatExtendedOverride({ maxRounds: 100, maxMessages: 500, wallClockMs: 1000 })

    room.rounds.sendToGroupChat('Marathon', MEMBERS, 'keep at it')
    await settle(room, 'Marathon')

    expect(room.chat.$groupChats.get().Marathon?.running).toBe(false)
    // 1000ms at 400ms a turn: the third turn crosses the deadline.
    expect(memberPosts(room, 'Marathon')).toHaveLength(3)
  })

  it('never applies a wall-clock cap in stock mode, even with an override staged', async () => {
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)

    const room = await loadRoom({
      turn: ({ n }) => {
        now += 60_000

        return `message ${n} — @everyone keep going`
      }
    })

    room.policy.applyGroupChatExtendedOverride({ wallClockMs: 1000 })

    room.rounds.sendToGroupChat('StockOnly', MEMBERS, 'go')
    await settle(room, 'StockOnly')

    // Every stock round ran: each turn "took" a minute, so honoring the
    // staged 1s deadline would have stopped the drive after one turn.
    expect(memberPosts(room, 'StockOnly')).toHaveLength(
      Math.min(room.chat.GROUP_CHAT_MAX_ROUNDS * MEMBERS.length, room.chat.GROUP_CHAT_MAX_MESSAGES)
    )
  })
})
