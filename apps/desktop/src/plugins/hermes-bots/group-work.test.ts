import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as groupActivity from './group-activity'
import type * as groupChat from './group-chat'
import type * as groupRounds from './group-rounds'
import { createGroupGateway, drain, runTimersInline, scriptedStorage } from './group-test-utils'
import type { GatewayOptions, ScriptedGateway } from './group-test-utils'
import type * as groupWork from './group-work'
import type { GroupMember } from './types'

// The work loop: a member that claims a task keeps the floor across rounds
// until it says it is finished, and the room's ceilings never cut it off
// mid-task — only a no-progress stall or the hard backstop do.

const { host } = vi.hoisted(() => ({ host: {} as Record<string, unknown> }))

vi.mock('@hermes/plugin-sdk', async () => {
  const { pluginSdkMock } = await import('./group-test-utils')

  return pluginSdkMock(host)
})

interface Room {
  activity: typeof groupActivity
  chat: typeof groupChat
  gateway: ScriptedGateway
  rounds: typeof groupRounds
  work: typeof groupWork
}

async function loadRoom(options: GatewayOptions = {}): Promise<Room> {
  vi.resetModules()
  const gateway = createGroupGateway(options)

  for (const key of Object.keys(host)) {
    delete host[key]
  }

  Object.assign(host, gateway.host)

  const [activity, chat, rounds, work, shared] = await Promise.all([
    import('./group-activity'),
    import('./group-chat'),
    import('./group-rounds'),
    import('./group-work'),
    import('./shared')
  ])

  shared.setPluginCtx(scriptedStorage(gateway.storage))

  return { activity, chat, gateway, rounds, work }
}

const MEMBERS: GroupMember[] = [
  { name: 'research', title: '' },
  { name: 'builder', title: '' },
  { name: 'ops', title: '' }
]

const turnsBy = (room: Room, profile: string) => room.gateway.calls.filter(call => call.profile === profile)

async function settle(room: Room, group: string, limit = 5000) {
  await drain(() => Boolean(room.chat.$groupChats.get()[group]?.running), limit)
}

beforeEach(() => {
  runTimersInline()
})

describe('turn intent', () => {
  it('classifies the work-loop sentinels on the final line', async () => {
    const { work } = await loadRoom()

    expect(work.groupTurnIntent('(pass)')).toBe('pass')
    expect(work.groupTurnIntent('')).toBe('pass')
    expect(work.groupTurnIntent('pulled the branch\n(working)')).toBe('working')
    expect(work.groupTurnIntent('**Done** shipped it\n- Did: x\n(done)')).toBe('done')
    expect(work.groupTurnIntent('cannot reach the box\n(blocked)')).toBe('done')
    expect(work.groupTurnIntent('(working) on it, more later')).toBe('reply')
    expect(work.groupTurnIntent('just a normal message')).toBe('reply')
  })
})

describe('work loop', () => {
  it('keeps a working member on the floor past the round cap until it reports done', async () => {
    const room = await loadRoom({
      turn: ({ profile, session }) => {
        if (profile !== 'builder') {
          return '(pass)'
        }

        const done = session.messages.filter(message => message.role === 'assistant').length

        return done < 5 ? `step ${done + 1} landed\n(working)` : '**Done** shipped\n- Did: x\n(done)'
      }
    })

    room.rounds.sendToGroupChat('Shop', MEMBERS, '@builder ship the migration')
    await settle(room, 'Shop')

    // Six turns against a stock ceiling of three rounds.
    expect(turnsBy(room, 'builder')).toHaveLength(6)
    expect(turnsBy(room, 'builder').length).toBeGreaterThan(room.chat.GROUP_CHAT_MAX_ROUNDS)
    expect(room.work.openGroupWorkClaims('Shop', thread(room, 'Shop'))).toEqual([])
  })

  it('feeds a claim holder a continue-your-task line when the room has nothing new', async () => {
    const room = await loadRoom({
      turn: ({ profile, session }) => {
        const done = session.messages.filter(message => message.role === 'assistant').length

        return profile === 'builder' && done === 0 ? 'on it\n(working)' : '(pass)'
      }
    })

    room.rounds.sendToGroupChat('Shop', MEMBERS, '@builder ship it')
    await settle(room, 'Shop')

    const [, second] = turnsBy(room, 'builder')

    expect(second.prompt).toContain('(no new messages - continue the task you claimed)')
    expect(second.prompt).toContain('"(working)"')
  })

  it('releases a member that keeps repeating itself, and says why', async () => {
    const room = await loadRoom({
      turn: ({ profile }) => (profile === 'builder' ? 'still compiling\n(working)' : '(pass)')
    })

    room.rounds.sendToGroupChat('Loop', MEMBERS, '@builder build it')
    await settle(room, 'Loop')

    const log = room.chat.$groupChats.get().Loop?.log || []
    const note = log.find(entry => entry.from.kind === 'system')

    expect(turnsBy(room, 'builder')).toHaveLength(room.work.GROUP_WORK_NO_PROGRESS_LIMIT)
    expect(note?.text).toContain(`made no new progress for ${room.work.GROUP_WORK_NO_PROGRESS_LIMIT} turns`)
    expect(room.work.hasOpenGroupWorkClaims('Loop', thread(room, 'Loop'))).toBe(false)
    expect(room.activity.currentGroupActivity('Loop').some(event => event.kind === 'stalled')).toBe(true)
  })

  it('treats a reply without the sentinel as releasing the floor', async () => {
    const room = await loadRoom({
      turn: ({ profile, session }) => {
        const done = session.messages.filter(message => message.role === 'assistant').length

        return profile === 'builder' ? (done === 0 ? 'started\n(working)' : 'all good now') : '(pass)'
      }
    })

    room.rounds.sendToGroupChat('Forgot', MEMBERS, '@builder go')
    await settle(room, 'Forgot')

    expect(turnsBy(room, 'builder')).toHaveLength(2)
    expect(room.work.hasOpenGroupWorkClaims('Forgot', thread(room, 'Forgot'))).toBe(false)
  })

  it('does nothing special when the room opts out', async () => {
    const room = await loadRoom({
      turn: ({ n, profile }) => (profile === 'builder' ? `step ${n}\n(working)` : '(pass)')
    })

    room.work.setGroupChatWorkLoop('Off', false)
    room.rounds.sendToGroupChat('Off', MEMBERS, '@builder go')
    await settle(room, 'Off')

    expect(turnsBy(room, 'builder')).toHaveLength(1)
    expect(turnsBy(room, 'builder')[0].prompt).not.toContain('"(working)"')
    expect(room.chat.$groupChats.get().Off?.working || {}).toEqual({})
  })

  it('ends a claim that is never released at the hard backstop', async () => {
    const room = await loadRoom({
      turn: ({ n, profile }) => (profile === 'builder' ? `step ${n}\n(working)` : '(pass)')
    })

    room.rounds.sendToGroupChat('Forever', MEMBERS, '@builder go')
    await settle(room, 'Forever', 200_000)

    expect(room.chat.$groupChats.get().Forever?.running).toBe(false)
    expect(turnsBy(room, 'builder')).toHaveLength(room.work.GROUP_WORK_HARD_TURN_BACKSTOP)
  }, 30_000) // 250 scripted turns
})

describe('claims', () => {
  it('persists open claims and only ever stores the loop switch when it is off', async () => {
    const { chat, work } = await loadRoom()

    work.noteGroupWorkClaim('Room', 't1', 'builder', 'halfway\n(working)')

    expect(chat.durableGroupChatRooms().Room.working?.builder).toMatchObject({ thread: 't1', turns: 1 })
    expect('workLoop' in chat.durableGroupChatRooms().Room).toBe(false)

    work.setGroupChatWorkLoop('Room', false)
    expect(chat.durableGroupChatRooms().Room.workLoop).toBe(false)

    work.setGroupChatWorkLoop('Room', true)
    expect('workLoop' in chat.durableGroupChatRooms().Room).toBe(false)
  })

  it('ignores a held member’s claim until the hold is released', async () => {
    const { chat, work } = await loadRoom()

    work.noteGroupWorkClaim('Room', 't1', 'builder', 'halfway\n(working)')
    chat.updateGroupChat('Room', room => ({ ...room, holds: { builder: { at: 1 } } }))

    expect(work.openGroupWorkClaims('Room', 't1')).toEqual([])

    chat.updateGroupChat('Room', room => ({ ...room, holds: {} }))

    expect(work.openGroupWorkClaims('Room', 't1')).toEqual(['builder'])
    expect(work.openGroupWorkClaims('Room', 'other-thread')).toEqual([])
  })
})

function thread(room: Room, group: string) {
  return room.chat.$groupChats.get()[group]?.log[0]?.thread || ''
}
