/**
 * Room-header controls for the per-room Bot Mode policy: the preset menu
 * (build / decide / standing), the work-loop switch, and the status line
 * that says whether any of the room's work is waiting on the user. The
 * policy itself lives in group-room-policy.ts and group-work.ts; this is
 * only its chrome.
 */
import {
  Button,
  cn,
  Codicon,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Tip,
  useValue
} from '@hermes/plugin-sdk'

import { $groupChats, normalizeGroupChatRoomMode } from './group-chat'
import { getGroupChatCeilings, setGroupChatRoomMode } from './group-room-policy'
import { groupChatWorkLoopEnabled, groupStatusCounts, setGroupChatWorkLoop } from './group-work'
import { useBots } from './i18n'
import type { GroupChatRoomMode, GroupMember } from './types'

const MODE_ICONS: Record<'default' | GroupChatRoomMode, string> = {
  default: 'settings-gear',
  build: 'tools',
  decide: 'checklist',
  standing: 'organization'
}

interface GroupRoomModeMenuProps {
  group: string
  members: GroupMember[]
}

/** The room's preset, as a compact labelled menu. Unset keeps the
 *  install-wide rounds setting, so each room can diverge without touching it. */
export function GroupRoomModeMenu({ group, members }: GroupRoomModeMenuProps) {
  const b = useBots()
  const rooms = useValue($groupChats)
  const mode = normalizeGroupChatRoomMode(rooms[group]?.mode)
  const workLoop = groupChatWorkLoopEnabled(rooms[group])
  const ceilings = getGroupChatCeilings(group, members)

  const modeName: Record<'default' | GroupChatRoomMode, string> = {
    default: b.group.roomModeDefault,
    build: b.group.roomModeBuild,
    decide: b.group.roomModeDecide,
    standing: b.group.roomModeStanding
  }

  const label = modeName[mode || 'default']

  const hint = mode
    ? b.group.roomModeHint(
        label,
        ceilings.maxRounds,
        ceilings.maxMessages,
        Math.round(Number(ceilings.wallClockMs || 0) / 60000)
      )
    : b.group.roomModeUnsetHint

  const items: Array<['default' | GroupChatRoomMode, string]> = [
    ['default', b.group.roomModeDefaultItem],
    ['build', b.group.roomModeBuildItem],
    ['decide', b.group.roomModeDecideItem],
    ['standing', b.group.roomModeStandingItem]
  ]

  return (
    <DropdownMenu>
      <Tip label={hint}>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={b.group.roomModeLabel(label)}
            className={cn(
              'shrink-0 gap-1 px-1.5 text-[0.65rem] font-medium hover:text-foreground',
              mode ? 'text-(--ui-accent)' : 'text-(--ui-text-tertiary)'
            )}
            size="sm"
            variant="ghost"
          >
            <Codicon name={MODE_ICONS[mode || 'default']} />
            {label}
          </Button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="end">
        {items.map(([value, itemLabel]) => (
          <DropdownMenuItem
            key={`mode:${value}`}
            onSelect={() => setGroupChatRoomMode(group, value === 'default' ? null : value)}
          >
            <Codicon className="mr-1.5" name={MODE_ICONS[value]} />
            <span className="min-w-0 flex-1">{itemLabel}</span>
            {(mode || 'default') === value ? <Codicon name="check" /> : null}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        {/* Independent of the preset: any mode can run with members finishing
            tasks across turns, or stopping after one message. */}
        <DropdownMenuItem onSelect={() => setGroupChatWorkLoop(group, !workLoop)}>
          <Codicon className="mr-1.5" name="sync" />
          <span className="min-w-0 flex-1">{workLoop ? b.group.workLoopOn : b.group.workLoopOff}</span>
          {workLoop ? <Codicon name="check" /> : null}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** "N to review, M blocked, K working": six bots produce a wall of text, and
 *  this is the line that says whether any of it needs the user. Amber for
 *  blocked, accent for review, and nothing at all while the room is quiet. */
export function GroupRoomStatusSummary({ group }: { group: string }) {
  const b = useBots()
  useValue($groupChats)
  const counts = groupStatusCounts(group)

  const parts = [
    counts.review ? { key: 'review', text: b.group.statusToReview(counts.review), tone: 'text-(--ui-accent)' } : null,
    counts.blocked
      ? { key: 'blocked', text: b.group.statusBlocked(counts.blocked), tone: 'text-amber-600 dark:text-amber-300' }
      : null,
    counts.working
      ? { key: 'working', text: b.group.statusWorking(counts.working), tone: 'text-(--ui-text-tertiary)' }
      : null
  ].filter(part => part !== null)

  if (!parts.length) {
    return null
  }

  return (
    <Tip label={b.group.statusSummaryHint}>
      <span className="flex shrink-0 items-center gap-1.5 text-[0.65rem]" data-testid="group-status-summary">
        {parts.map(part => (
          <span className={part.tone} key={part.key}>
            {part.text}
          </span>
        ))}
      </span>
    </Tip>
  )
}
