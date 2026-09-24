import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as groupChat from './group-chat'
import type * as groupRooms from './group-room-policy'
import type * as groupRounds from './group-rounds'
import { createGroupGateway, drain, runTimersInline, scriptedStorage } from './group-test-utils'
import type { GatewayOptions, ScriptedGateway } from './group-test-utils'
import type { GroupChat, GroupMember, GroupMessage } from './types'

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
    expect(policy.getGroupChatCeilings()).toMatchObject({
      maxRounds: chat.GROUP_CHAT_MAX_ROUNDS,
      maxMessages: chat.GROUP_CHAT_MAX_MESSAGES,
      wallClockMs: null
    })
  })

  it('raises the ceilings and adds a wall-clock cap when on; off restores exact stock', async () => {
    const { chat, gateway, policy } = await loadRoom()

    policy.setGroupChatExtendedMode(true)
    await Promise.resolve()

    expect(policy.getGroupChatCeilings()).toMatchObject({
      maxRounds: policy.GROUP_CHAT_EXTENDED_MAX_ROUNDS,
      maxMessages: policy.GROUP_CHAT_EXTENDED_MAX_MESSAGES,
      wallClockMs: policy.GROUP_CHAT_EXTENDED_WALL_CLOCK_MS
    })
    expect(gateway.storage.get(policy.GROUP_CHAT_EXTENDED_MODE_KEY)).toBe(true)

    policy.setGroupChatExtendedMode(false)

    expect(policy.getGroupChatCeilings()).toMatchObject({
      maxRounds: chat.GROUP_CHAT_MAX_ROUNDS,
      maxMessages: chat.GROUP_CHAT_MAX_MESSAGES,
      wallClockMs: null
    })
  })

  it('drops out-of-range or malformed override fields instead of clamping them', async () => {
    const { policy } = await loadRoom()
    policy.setGroupChatExtendedMode(true)

    policy.applyGroupChatExtendedOverride({ maxRounds: 50, maxMessages: 300, wallClockMinutes: 10 })
    expect(policy.getGroupChatCeilings()).toMatchObject({ maxRounds: 50, maxMessages: 300, wallClockMs: 600_000 })

    // Too high AND below the floor are both rejected per field, falling back
    // to the extended default — never silently becoming "as large as allowed".
    policy.applyGroupChatExtendedOverride({ maxRounds: 0, maxMessages: 99_999, wallClockMinutes: 999 })
    expect(policy.getGroupChatCeilings()).toMatchObject({
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

    expect(policy.getGroupChatCeilings()).toMatchObject({
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

describe('room presets', () => {
  it('scales a preset message budget with the live member count', async () => {
    const { policy } = await loadRoom()

    expect(policy.getModeCeilings('build', 5)).toMatchObject({ maxRounds: 24, maxMessages: 3 * 5 * 24 })
    expect(policy.getModeCeilings('decide', 2)).toMatchObject({
      maxRounds: 4,
      maxMessages: 2 * 2 * 4,
      autoSummary: true,
      toolCapable: false
    })
    expect(policy.getModeCeilings('standing', 99)?.maxMessages).toBe(2 * 6 * 8)
    expect(policy.getModeCeilings('nonsense', 3)).toBeNull()
  })

  it('overrides the install-wide toggle per room, and an unset room keeps it', async () => {
    const { chat, policy } = await loadRoom()

    chat.updateGroupChat('Plain', room => room)
    policy.setGroupChatRoomMode('Tight', 'decide')

    expect(policy.getGroupChatCeilings('Plain', MEMBERS)).toMatchObject({ maxRounds: 3, mode: null, toolCapable: true })
    expect(policy.getGroupChatCeilings('Tight', MEMBERS)).toMatchObject({ maxRounds: 4, mode: 'decide' })

    policy.setGroupChatExtendedMode(true)

    expect(policy.getGroupChatCeilings('Plain', MEMBERS).maxRounds).toBe(policy.GROUP_CHAT_EXTENDED_MAX_ROUNDS)
    expect(policy.getGroupChatCeilings('Tight', MEMBERS).maxRounds).toBe(4)
  })

  it('persists the mode on the room record and clears it on an unknown value', async () => {
    const { chat, gateway, policy } = await loadRoom()

    expect(policy.setGroupChatRoomMode('Room', ' Build ')).toBe('build')
    await Promise.resolve()

    expect((gateway.storage.get('group-chats') as Record<string, GroupChat>).Room.mode).toBe('build')
    expect(chat.durableGroupChatRooms().Room.mode).toBe('build')

    expect(policy.setGroupChatRoomMode('Room', 'bogus')).toBeNull()
    expect(chat.$groupChats.get().Room.mode).toBeUndefined()
    expect('mode' in chat.durableGroupChatRooms().Room).toBe(false)
  })

  it('tells a chat-only room not to use tools; a build room keeps them', async () => {
    const room = await loadRoom()

    room.policy.setGroupChatRoomMode('Talk', 'decide')
    room.rounds.sendToGroupChat('Talk', MEMBERS, '@builder thoughts?')
    await settle(room, 'Talk')

    room.policy.setGroupChatRoomMode('Work', 'build')
    room.rounds.sendToGroupChat('Work', MEMBERS, '@builder go')
    await settle(room, 'Work')

    const [talk, work] = room.gateway.calls

    expect(talk.prompt).toContain('This room is chat-only')
    expect(work.prompt).not.toContain('chat-only')
  })

  it('summarizes a decide room that hit its ceiling, in the thread it ran', async () => {
    const room = await loadRoom({ turn: ({ n }) => `point ${n} — @everyone` })

    room.policy.setGroupChatRoomMode('Vote', 'decide')
    const thread = room.rounds.sendToGroupChat('Vote', MEMBERS, 'pick a database')
    await settle(room, 'Vote')

    const notes = (room.chat.$groupChats.get().Vote?.log || []).filter(entry => entry.from.kind === 'system')

    expect(notes).toHaveLength(1)
    expect(notes[0].thread).toBe(thread)
    expect(notes[0].text).toContain('Decide-mode room summary')
    expect(notes[0].text).toContain('Last user ask: pick a database')
  })

  it('does not summarize a decide room that settled on its own', async () => {
    const room = await loadRoom()

    room.policy.setGroupChatRoomMode('Calm', 'decide')
    room.rounds.sendToGroupChat('Calm', MEMBERS, 'anything to add?')
    await settle(room, 'Calm')

    expect((room.chat.$groupChats.get().Calm?.log || []).some(entry => entry.from.kind === 'system')).toBe(false)
  })

  it('feeds a room note to members as [system], and keeps it a note in the gateway mirror', async () => {
    const { chat } = await loadRoom()
    const { formatGroupChatLine } = await import('./group-round-prompt')
    const note: GroupMessage = { at: 1, from: { kind: 'system', name: 'Summary' }, text: 'drive capped' }

    expect(formatGroupChatLine(note, 'builder')).toBe('[system] drive capped')

    const snapshot = chat.groupChatSyncSnapshot({ Room: { log: [note], watermarks: {} } })

    expect(snapshot.rooms['name:Room'].log[0].from.kind).toBe('system')
  })
})

describe('spend ceiling', () => {
  it('stops a drive that outspends its budget, releases claims and says it is an estimate', async () => {
    const long = 'x'.repeat(4000)

    const room = await loadRoom({
      turn: ({ n, profile }) => (profile === 'builder' ? `${long} ${n}\n(working)` : '(pass)')
    })

    room.chat.updateGroupChat('Spendy', current => ({ ...current, tokenBudget: 2000 }))
    const thread = room.rounds.sendToGroupChat('Spendy', MEMBERS, '@builder go') as string
    await settle(room, 'Spendy')

    const notes = (room.chat.$groupChats.get().Spendy?.log || []).filter(entry => entry.from.kind === 'system')

    expect(notes).toHaveLength(1)
    expect(notes[0].thread).toBe(thread)
    expect(notes[0].text).toMatch(/Room stopped at roughly [\d,.\s]+ estimated tokens \(ceiling 2[,.\s]?000\)/)
    expect(notes[0].text).toContain('character-based estimate')
    // ~1000 tokens a reply: the claim holder is stopped after two turns,
    // long before the work loop's backstop.
    expect(room.gateway.calls.filter(call => call.profile === 'builder')).toHaveLength(2)
    expect(room.chat.$groupChats.get().Spendy?.working || {}).toEqual({})
    expect(room.chat.$groupChats.get().Spendy?.running).toBe(false)
  })

  it('resolves an explicit budget first, then the preset, then the default', async () => {
    const { chat, policy } = await loadRoom()

    chat.updateGroupChat('Room', current => current)
    expect(policy.groupTokenBudget('Room')).toBe(policy.GROUP_TOKEN_BUDGET_DEFAULT)

    policy.setGroupChatRoomMode('Room', 'decide')
    expect(policy.groupTokenBudget('Room')).toBe(policy.GROUP_TOKEN_BUDGETS.decide)
    expect(policy.groupTokenBudget('Room')).toBeLessThan(policy.GROUP_TOKEN_BUDGET_DEFAULT)

    chat.updateGroupChat('Room', current => ({ ...current, tokenBudget: 5000 }))
    expect(policy.groupTokenBudget('Room')).toBe(5000)
    expect(chat.durableGroupChatRooms().Room.tokenBudget).toBe(5000)

    chat.updateGroupChat('Room', current => ({ ...current, tokenBudget: 0 }))
    expect(policy.groupTokenBudget('Room')).toBe(Infinity)
  })

  it('estimates roughly four characters a token, counting the prompt and the reply', async () => {
    const { policy } = await loadRoom()
    const meter = policy.createGroupSpendMeter()

    expect(policy.estimateGroupTokens('abcd')).toBe(1)
    expect(policy.estimateGroupTokens('abcde')).toBe(2)
    expect(policy.estimateGroupTokens(null)).toBe(0)

    meter.noteTurn('x'.repeat(400), 'y'.repeat(40))
    meter.noteTurn('x'.repeat(400), null)

    expect(meter.spent()).toBe(100 + 10 + 100)
  })
})
