import { cleanup, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

import { translateBots } from './i18n-test-helper'

// Room bodies go through the shell's message renderer (the 1:1 chat's code
// card + `MEDIA:` transform) when the SDK exports it. The stub records what the
// room handed it so the test asserts the wiring, not the renderer's output.
vi.mock('@hermes/plugin-sdk', async () => {
  const { pluginSdkMock, createGroupGateway } = await import('./group-test-utils')
  const base = await pluginSdkMock(createGroupGateway().host)

  const Button = ({ children, onClick, title }: { children?: ReactNode; onClick?: () => void; title?: string }) => (
    <button onClick={onClick} title={title}>
      {children}
    </button>
  )

  return {
    ...base,
    Button,
    RowButton: Button,
    cn: (...values: unknown[]) => values.filter(Boolean).join(' '),
    Codicon: () => null,
    CopyButton: () => null,
    ConfirmDialog: () => null,
    Dialog: () => null,
    DialogContent: () => null,
    DialogDescription: () => null,
    DialogFooter: () => null,
    DialogHeader: () => null,
    DialogTitle: () => null,
    Input: () => null,
    MessageTextContent: ({ media = true, text }: { media?: boolean; text: string }) => (
      <span data-media={String(media)} data-testid="message-text-content">
        {text}
      </span>
    ),
    Switch: () => null,
    Tip: ({ children }: { children: ReactNode }) => children,
    relativeTime: () => 'now',
    useI18n: () => ({ t: { common: { cancel: 'Cancel', save: 'Save' } } }),
    usePluginI18n: () => translateBots
  }
})
vi.mock('./avatar', () => ({ avatarColor: () => '#888', botAppearance: () => ({}), BotFace: () => null }))
vi.mock('./group-chat-parts', () => ({
  GroupClarifyCard: () => null,
  GroupImageControls: () => null,
  GroupMentionInput: () => null
}))
afterEach(cleanup)

it('renders member replies through the shell message renderer, resolving media only for members on this gateway', async () => {
  Element.prototype.scrollIntoView = vi.fn()
  const { $groupChats } = await import('./group-chat')
  const { GroupChatWorkspace } = await import('./group-chat-view')

  const log = [
    { id: 'u1', thread: 'a', from: { kind: 'user' as const, name: 'You' }, text: 'Show me', at: 1 },
    { id: 'm1', thread: 'a', from: { kind: 'member' as const, name: 'builder' }, text: 'MEDIA:/tmp/local.png', at: 2 },
    {
      id: 'm2',
      thread: 'a',
      from: { kind: 'member' as const, name: 'builder', source: 'mini' },
      text: 'MEDIA:/tmp/remote.png',
      at: 3
    }
  ]

  const members = [
    { name: 'builder' },
    { connectionId: 'mini', connectionLabel: 'mini', name: 'builder', remoteSource: true, sourceScoped: true }
  ] as never

  $groupChats.set({ Room: { log, watermarks: {}, sessions: {} } })
  const { getAllByTestId } = render(<GroupChatWorkspace group="Room" members={members} />)
  const bodies = getAllByTestId('message-text-content').map(el => [el.textContent, el.dataset.media])

  expect(bodies).toEqual([
    ['Show me', 'true'],
    ['MEDIA:/tmp/local.png', 'true'],
    ['MEDIA:/tmp/remote.png', 'false']
  ])
})

it('renders a room note as a plain label with no speaker controls, and shows the room preset', async () => {
  Element.prototype.scrollIntoView = vi.fn()
  const { $groupChats } = await import('./group-chat')
  const { GroupChatWorkspace } = await import('./group-chat-view')

  const log = [
    { id: 'u1', thread: 'a', from: { kind: 'user' as const, name: 'You' }, text: 'Pick one', at: 1 },
    { id: 's1', thread: 'a', from: { kind: 'system' as const, name: 'Summary' }, text: 'drive capped', at: 2 }
  ]

  $groupChats.set({ Room: { log, mode: 'decide', watermarks: {}, sessions: {} } })
  const { getByText } = render(<GroupChatWorkspace group="Room" members={[{ name: 'builder' }] as never} />)

  // The engine's own note is a static label, not the click-to-reveal handle button a member gets.
  expect(getByText('Summary').closest('button')).toBeNull()
  // The header's preset menu names the room's mode.
  expect(getByText(translateBots('group.roomModeDecide')).closest('button')).not.toBeNull()
})

it('tags a member turn with the model that served it, amber when the session changed route', async () => {
  Element.prototype.scrollIntoView = vi.fn()
  const { $groupChats } = await import('./group-chat')
  const { GroupChatWorkspace } = await import('./group-chat-view')

  const log = [
    { id: 'm1', thread: 'a', from: { kind: 'member' as const, name: 'builder' }, text: 'done', at: 1 },
    { id: 'm2', thread: 'a', from: { kind: 'member' as const, name: 'ops' }, text: 'ok', at: 2 }
  ]

  const servedBy = {
    builder: { model: 'gemini-3-pro', provider: 'openrouter', changedRoute: true, totalTokens: 10 },
    ops: { model: 'claude-sonnet-5', provider: 'anthropic', changedRoute: false, totalTokens: 10 }
  }

  $groupChats.set({ Room: { log, servedBy, watermarks: {}, sessions: {} } })

  const { getAllByTestId } = render(
    <GroupChatWorkspace group="Room" members={[{ name: 'builder' }, { name: 'ops' }] as never} />
  )

  expect(getAllByTestId('group-served-by').map(el => [el.textContent, el.dataset.changedRoute])).toEqual([
    ['gemini-3-pro', 'true'],
    ['claude-sonnet-5', undefined]
  ])
})

it('says in the header what needs the user, and nothing while the room is quiet', async () => {
  Element.prototype.scrollIntoView = vi.fn()
  const { $groupChats } = await import('./group-chat')
  const { GroupChatWorkspace } = await import('./group-chat-view')
  const members = [{ name: 'builder' }, { name: 'ops' }, { name: 'research' }] as never

  $groupChats.set({
    Room: {
      log: [],
      memberStatus: {
        builder: { at: 1, state: 'review', thread: 'a' },
        ops: { at: 1, state: 'blocked', thread: 'a' },
        research: { at: 1, state: 'idle', thread: 'a' }
      },
      watermarks: {},
      sessions: {}
    }
  })
  const { getByTestId, unmount } = render(<GroupChatWorkspace group="Room" members={members} />)

  expect(getByTestId('group-status-summary').textContent).toBe(
    `${translateBots('group.statusToReview', 1)}${translateBots('group.statusBlocked', 1)}`
  )
  unmount()

  $groupChats.set({ Quiet: { log: [], watermarks: {}, sessions: {} } })
  const { queryByTestId } = render(<GroupChatWorkspace group="Quiet" members={members} />)

  expect(queryByTestId('group-status-summary')).toBeNull()
})
