import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const pluginSource = readFileSync(new URL('../plugin.js', import.meta.url), 'utf8')

/** Load the plugin in a vm with a scripted cli.exec so member turns are
 *  deterministic. `turnScript(profile, prompt)` returns the member's reply
 *  text (or throws to simulate a failed turn). */
function load(turnScript) {
  const values = new Map()
  const atom = initial => {
    const slot = { get: () => values.get(slot), set: value => values.set(slot, value) }
    values.set(slot, initial)
    return slot
  }
  const calls = []
  const transcripts = new Map()
  const context = {
    atom,
    setTimeout: fn => {
      fn()
      return 0
    },
    clearTimeout: () => undefined,
    PALETTE_AREA: 'palette',
    COMPOSER_AREAS: { middleware: 'middleware' },
    document: { getElementById: () => null, createElement: () => ({}), head: { appendChild: () => undefined } },
    host: {
      request: async (method, params) => {
        if (method === 'session.create') {
          return { session_id: `rt-${params.profile}`, stored_session_id: `sid-${params.profile}`, message_count: 0, messages: [] }
        }
        if (method === 'session.resume') {
          const profile = params.profile
          const transcript = transcripts.get(profile) || []
          return { session_id: `rt-${profile}`, messages: transcript, inflight: false, running: false }
        }
        if (method === 'prompt.submit') {
          const profile = String(params.session_id).replace(/^rt-/, '')
          const transcript = transcripts.get(profile) || []
          transcript.push({ role: 'user', content: params.text })
          calls.push({ profile, prompt: params.text })
          // turnScript may be sync or async (a real setTimeout-based delay
          // simulating turn latency) — always await so both shapes work.
          const reply = await turnScript(profile, params.text, calls.length)
          transcript.push({ role: 'assistant', content: reply })
          transcripts.set(profile, transcript)
          return {}
        }
        return {}
      },
      state: { profile: { get: () => 'default', listen: () => undefined }, gateway: { listen: () => undefined } },
      notify: () => undefined,
      notifyError: () => undefined
    }
  }
  const source = pluginSource
    .replace(/^import\s+\*\s+as\s+sdk\s+from '@hermes\/plugin-sdk'\r?\n/m, '')
    .replace(/^import\s+\{[\s\S]*?\}\s+from '@hermes\/plugin-sdk'\r?\n/m, '')
    .replace(/^const \{ McpTab, ToolsetConfigPanel \} = sdk\r?\n/m, '')
    .replace(/^import .* from 'react'\r?\n/m, '')
    .replace(/^import .* from 'react\/jsx-runtime'\r?\n/m, '')
    .replace('export default {', 'globalThis.plugin = {')
    .concat(
      '\nglobalThis.__gc = { sendToGroupChat, runGroupChatRounds, resolveGroupResponders, parseGroupChatMentions, rotateGroupSpeakers, isGroupPassText, formatGroupChatLine, buildGroupChatTurnPrompt, trimGroupChatLog, disbandGroupChat, $groupChats, $groupNeedsYou, $groupChatWorkspace, $botMeta, GROUP_CHAT_STOCK_MAX_ROUNDS, GROUP_CHAT_STOCK_MAX_MESSAGES, GROUP_CHAT_EXTENDED_MAX_ROUNDS, GROUP_CHAT_EXTENDED_MAX_MESSAGES, GROUP_CHAT_EXTENDED_WALL_CLOCK_MS, $groupChatExtendedMode, setGroupChatExtendedMode, applyGroupChatExtendedOverride, getGroupChatCeilings };\n'
    )
  vm.runInNewContext(source, context, { filename: 'plugin.js' })
  const storageWrites = new Map()
  context.plugin.register({
    storage: { get: () => null, set: (key, value) => storageWrites.set(key, value) },
    register: () => undefined
  })
  return { ...context.__gc, calls, storageWrites }
}

const MEMBERS = [{ name: 'research', title: '' }, { name: 'builder', title: '' }, { name: 'ops', title: 'The Ops' }]

function roomLog(gc, group) {
  return (gc.$groupChats.get()[group] || { log: [] }).log
}

test('pass detection: (pass), pass, pass., empty are silence; real text is not', () => {
  const gc = load(() => '(pass)')
  assert.equal(gc.isGroupPassText('(pass)'), true)
  assert.equal(gc.isGroupPassText('pass'), true)
  assert.equal(gc.isGroupPassText('Pass.'), true)
  assert.equal(gc.isGroupPassText('  '), true)
  assert.equal(gc.isGroupPassText('I will pass this to ops'), false)
})

test('mention routing: only @-mentioned members respond; @everyone or none = all', () => {
  const gc = load(() => '(pass)')
  const log = [{ from: { kind: 'user', name: 'You' }, text: '@builder take this one', at: 1 }]
  const one = gc.resolveGroupResponders(log, MEMBERS)
  assert.equal(JSON.stringify(one.map(m => m.name)), JSON.stringify(['builder']))

  const all = gc.resolveGroupResponders([{ from: { kind: 'user', name: 'You' }, text: 'hello team', at: 1 }], MEMBERS)
  assert.equal(all.length, 3)

  const everyone = gc.resolveGroupResponders(
    [{ from: { kind: 'user', name: 'You' }, text: '@everyone standup', at: 1 }],
    MEMBERS
  )
  assert.equal(everyone.length, 3)
})

test('mention routing: display titles resolve to the member and @user never matches a bot', () => {
  const gc = load(() => '(pass)')
  const parsed = gc.parseGroupChatMentions('@theops please check, then ping @user', MEMBERS)
  assert.equal(parsed.mentioned.has('ops'), true)
  assert.equal(parsed.mentioned.size, 1)
})

test('a member @-mentioned by another bot joins the NEXT round', async () => {
  const gc = load((profile, prompt) => {
    if (profile === 'research' && !prompt.includes('(you)')) {
      return 'Interesting — @builder should own this.'
    }
    if (profile === 'builder') {
      return 'On it. OWNER: @builder.'
    }
    return '(pass)'
  })

  gc.sendToGroupChat('Core', [{ name: 'research', title: '' }, { name: 'builder', title: '' }], '@research thoughts?')
  await new Promise(resolve => setTimeout(resolve, 0))
  await new Promise(resolve => setImmediate(resolve))
  // Drain the async loop: poll until running flips false.
  for (let i = 0; i < 200 && (gc.$groupChats.get().Core || {}).running; i++) {
    await new Promise(resolve => setImmediate(resolve))
  }

  const texts = roomLog(gc, 'Core').map(e => `${e.from.name}: ${e.text}`)
  assert.equal(texts.some(t => t.startsWith('research:')), true)
  assert.equal(texts.some(t => t.startsWith('builder: On it')), true)
})

test('settle: everyone passing ends the room turn with only the user message logged', async () => {
  const gc = load(() => '(pass)')

  gc.sendToGroupChat('Quiet', MEMBERS, 'fyi, deploy went out')
  for (let i = 0; i < 200 && (gc.$groupChats.get().Quiet || {}).running; i++) {
    await new Promise(resolve => setImmediate(resolve))
  }

  const log = roomLog(gc, 'Quiet')
  assert.equal(log.length, 1)
  assert.equal(log[0].from.kind, 'user')
  // Every member took exactly one turn (round 1), then the settle exit fired.
  assert.equal(gc.calls.length, 3)
})

test('hard caps: chatty members stop at GROUP_CHAT_MAX_MESSAGES total', async () => {
  const gc = load((profile, prompt, n) => `message ${n} — @everyone keep going`)

  gc.sendToGroupChat('Loud', MEMBERS, 'go wild')
  for (let i = 0; i < 400 && (gc.$groupChats.get().Loud || {}).running; i++) {
    await new Promise(resolve => setImmediate(resolve))
  }

  const memberMessages = roomLog(gc, 'Loud').filter(e => e.from.kind === 'member')
  assert.ok(memberMessages.length <= gc.getGroupChatCeilings().maxMessages, `posted ${memberMessages.length}`)
})

test('fork change: default (stock) ceilings are byte-identical to upstream — extended mode is OFF by default', () => {
  const gc = load(() => '(pass)')
  const ceilings = gc.getGroupChatCeilings()
  assert.equal(gc.$groupChatExtendedMode.get(), false)
  assert.equal(ceilings.maxRounds, 3)
  assert.equal(ceilings.maxMessages, 10)
  assert.equal(ceilings.wallClockMs, null, 'stock mode has no wall-clock cap, matching upstream')
})

test('fork change: enabling extended mode raises ceilings and adds a wall-clock cap; disabling restores exact stock', () => {
  const gc = load(() => '(pass)')

  gc.setGroupChatExtendedMode(true)
  const extended = gc.getGroupChatCeilings()
  assert.equal(extended.maxRounds, gc.GROUP_CHAT_EXTENDED_MAX_ROUNDS)
  assert.equal(extended.maxMessages, gc.GROUP_CHAT_EXTENDED_MAX_MESSAGES)
  assert.equal(extended.wallClockMs, gc.GROUP_CHAT_EXTENDED_WALL_CLOCK_MS)
  assert.ok(extended.maxRounds > 3 && extended.maxMessages > 10)

  gc.setGroupChatExtendedMode(false)
  const stock = gc.getGroupChatCeilings()
  assert.equal(stock.maxRounds, 3)
  assert.equal(stock.maxMessages, 10)
  assert.equal(stock.wallClockMs, null)
})

test('fork change: extended-mode override clamps to hard ranges and rejects malformed input field-by-field', () => {
  const gc = load(() => '(pass)')
  gc.setGroupChatExtendedMode(true)

  gc.applyGroupChatExtendedOverride({ maxRounds: 50, maxMessages: 300, wallClockMinutes: 10 })
  let c = gc.getGroupChatCeilings()
  assert.equal(c.maxRounds, 50)
  assert.equal(c.maxMessages, 300)
  assert.equal(c.wallClockMs, 10 * 60 * 1000)

  // Out-of-range values are dropped per-field, falling back to the safe
  // EXTENDED_* default for that field rather than clamping to a boundary.
  // Covers both directions: too high (99999) AND below the 1000ms floor
  // (e.g. 20ms) are equally rejected, not silently clamped up to the floor —
  // a caller that means "as fast as possible" does not get a surprise
  // near-instant deadline.
  gc.applyGroupChatExtendedOverride({ maxRounds: 0, maxMessages: 99999, wallClockMinutes: 999 })
  c = gc.getGroupChatCeilings()
  assert.equal(c.maxRounds, gc.GROUP_CHAT_EXTENDED_MAX_ROUNDS)
  assert.equal(c.maxMessages, gc.GROUP_CHAT_EXTENDED_MAX_MESSAGES)
  assert.equal(c.wallClockMs, gc.GROUP_CHAT_EXTENDED_WALL_CLOCK_MS)

  gc.applyGroupChatExtendedOverride({ wallClockMs: 20 }) // below the 1000ms floor
  c = gc.getGroupChatCeilings()
  assert.equal(c.wallClockMs, gc.GROUP_CHAT_EXTENDED_WALL_CLOCK_MS, 'below-floor value rejected, not clamped up to the floor')

  // Malformed shapes never throw and never touch prior valid state.
  gc.applyGroupChatExtendedOverride({ maxRounds: 20, maxMessages: 50, wallClockMinutes: 5 })
  gc.applyGroupChatExtendedOverride(null)
  c = gc.getGroupChatCeilings()
  assert.equal(c.maxRounds, gc.GROUP_CHAT_EXTENDED_MAX_ROUNDS, 'null override resets to extended defaults, not a throw')

  gc.applyGroupChatExtendedOverride({ maxRounds: 20, maxMessages: 50, wallClockMinutes: 5 })
  gc.applyGroupChatExtendedOverride('nonsense')
  c = gc.getGroupChatCeilings()
  assert.equal(c.maxRounds, gc.GROUP_CHAT_EXTENDED_MAX_ROUNDS)

  // An override set while extended mode is OFF has zero effect until it's
  // turned back on — flipping off always means exact stock, full stop.
  gc.setGroupChatExtendedMode(false)
  gc.applyGroupChatExtendedOverride({ maxRounds: 99 })
  c = gc.getGroupChatCeilings()
  assert.equal(c.maxRounds, 3)
  assert.equal(c.wallClockMs, null)
})

test('fork change: a tuned-down extended-mode maxMessages cap is actually enforced by the loop', async () => {
  const gc = load((profile, prompt, n) => `message ${n} — @everyone keep going`)
  gc.setGroupChatExtendedMode(true)
  gc.applyGroupChatExtendedOverride({ maxRounds: 24, maxMessages: 2 })

  gc.sendToGroupChat('Capped', MEMBERS, 'go wild but capped')
  for (let i = 0; i < 400 && (gc.$groupChats.get().Capped || {}).running; i++) {
    await new Promise(resolve => setImmediate(resolve))
  }

  const memberMessages = roomLog(gc, 'Capped').filter(e => e.from.kind === 'member')
  assert.ok(memberMessages.length <= 2, `posted ${memberMessages.length}, expected <= 2`)
})

test('fork change: extended-mode wall-clock cap ends the drive early even when nobody settles via all-pass', async () => {
  // Every turn takes 300ms of REAL async work (a genuine setTimeout in the
  // outer Node context — turnScript runs outside the vm sandbox, so this is
  // real wall-clock time, not the vm's synchronous setTimeout mock) before
  // replying with fresh (non-pass) text — simulates a room that keeps
  // producing real-looking output and never naturally settles via the
  // all-pass exit. Round/message ceilings are set high enough that ONLY the
  // wall-clock deadline can be what stops this drive. wallClockMs is set to
  // the minimum allowed (1000ms, the hard floor in applyGroupChatExtendedOverride)
  // so real turn latency (300ms x up to 3 members/round) crosses it within a
  // couple of rounds.
  const gc = load(async (profile, prompt, n) => {
    await new Promise(resolve => setTimeout(resolve, 300))
    return `still working, turn ${n} — @everyone`
  })
  gc.setGroupChatExtendedMode(true)
  gc.applyGroupChatExtendedOverride({ maxRounds: 100, maxMessages: 500, wallClockMs: 1000 })
  const before = Date.now()

  gc.sendToGroupChat('Marathon', MEMBERS, 'keep at it')
  for (let i = 0; i < 100 && (gc.$groupChats.get().Marathon || {}).running; i++) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }

  const elapsed = Date.now() - before
  assert.equal((gc.$groupChats.get().Marathon || {}).running, false, 'drive stopped')
  // At ~300ms/turn x 3 members/round, the 1000ms deadline should stop this
  // within 2 rounds (well under the 100-round/500-message ceilings).
  const memberMessages = roomLog(gc, 'Marathon').filter(e => e.from.kind === 'member')
  assert.ok(memberMessages.length < 100 * MEMBERS.length, `expected an early stop, posted ${memberMessages.length}`)
  assert.ok(elapsed < 5000, `expected the deadline to end this quickly, took ${elapsed}ms`)
})

test('fork change: stock mode never applies a wall-clock cap, even with an extended-mode override staged', async () => {
  // A staged override only ever takes effect once extended mode is actually
  // on (per the earlier "flip off restores exact stock" test) — this proves
  // the same thing from the loop's perspective: a room run under stock mode
  // never terminates early via a wall-clock check it doesn't have, even
  // when a (valid, non-clamped-away) override sits staged in storage.
  const gc = load((profile, prompt, n) => `message ${n} — @everyone keep going`)
  gc.applyGroupChatExtendedOverride({ wallClockMs: 1000 }) // valid value, would fire in ~1s if wrongly honored
  // extended mode intentionally left OFF (the default)

  gc.sendToGroupChat('StockOnly', MEMBERS, 'go')
  for (let i = 0; i < 400 && (gc.$groupChats.get().StockOnly || {}).running; i++) {
    await new Promise(resolve => setImmediate(resolve))
  }

  const memberMessages = roomLog(gc, 'StockOnly').filter(e => e.from.kind === 'member')
  // Stopped by the STOCK maxMessages=10 cap (near-instant, no real per-turn
  // delay in this test's turnScript), not the staged 1000ms deadline.
  assert.ok(memberMessages.length <= 10, `posted ${memberMessages.length}`)
})

test('failed member turn is a pass, not a room error', async () => {
  const gc = load(profile => {
    if (profile === 'builder') {
      throw new Error('gateway hiccup')
    }
    return '(pass)'
  })

  gc.sendToGroupChat('Flaky', MEMBERS, 'anyone around?')
  for (let i = 0; i < 200 && (gc.$groupChats.get().Flaky || {}).running; i++) {
    await new Promise(resolve => setImmediate(resolve))
  }

  const log = roomLog(gc, 'Flaky')
  assert.equal(log.length, 1) // just the user message; no error entries
})

test('delta injection: a second user send only feeds members the NEW messages', async () => {
  const prompts = []
  const gc = load((profile, prompt) => {
    prompts.push({ profile, prompt })
    return '(pass)'
  })

  gc.sendToGroupChat('Delta', [{ name: 'research', title: '' }], 'first message')
  for (let i = 0; i < 200 && (gc.$groupChats.get().Delta || {}).running; i++) {
    await new Promise(resolve => setImmediate(resolve))
  }
  const firstCount = prompts.length
  gc.sendToGroupChat('Delta', [{ name: 'research', title: '' }], 'second message')
  for (let i = 0; i < 200 && (gc.$groupChats.get().Delta || {}).running; i++) {
    await new Promise(resolve => setImmediate(resolve))
  }

  const second = prompts.slice(firstCount).find(p => p.prompt.includes('second message'))
  assert.ok(second, 'second turn ran')
  assert.equal(second.prompt.includes('first message'), false, 'first message was already seen — not re-injected')
})

test('needs-you: a member reply mentioning @user badges the group; user send clears it', async () => {
  const gc = load(profile => (profile === 'research' ? 'Blocked on billing access — @user which account?' : '(pass)'))

  gc.sendToGroupChat('Escalate', [{ name: 'research', title: '' }], 'sort out the invoices')
  for (let i = 0; i < 200 && (gc.$groupChats.get().Escalate || {}).running; i++) {
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.equal(gc.$groupNeedsYou.get().Escalate, true)

  const gc2 = gc // same room: user reply clears
  gc2.sendToGroupChat('Escalate', [{ name: 'research', title: '' }], 'use the ops account')
  assert.equal(gc2.$groupNeedsYou.get().Escalate, false)
})

test('turn transport is gateway-native (session RPCs) and hostile text rides verbatim', async () => {
  const gc = load(() => '(pass)')

  gc.sendToGroupChat('Rpc', [{ name: 'research', title: '' }], 'hello "there" `whoami` $(id)')
  for (let i = 0; i < 200 && (gc.$groupChats.get().Rpc || {}).running; i++) {
    await new Promise(resolve => setImmediate(resolve))
  }

  const call = gc.calls[0]
  assert.equal(call.profile, 'research')
  // Hostile text is a JSON string in an RPC param — never a shell string.
  assert.equal(call.prompt.includes('hello "there" `whoami` $(id)'), true)
  // The per-group session is created with the room title.
  assert.match(pluginSource, /title,\n/)
  assert.match(pluginSource, /const title = `Group: \$\{group\}`/)
})

test('log trimming keeps watermarks consistent', () => {
  const gc = load(() => '(pass)')
  const log = Array.from({ length: 200 }, (_, i) => ({ from: { kind: 'user', name: 'You' }, text: `m${i}`, at: i }))
  const { log: trimmed, watermarks } = gc.trimGroupChatLog(log, { research: 150, builder: 10 }, 96)
  assert.equal(trimmed.length, 96)
  assert.equal(watermarks.research, 150 - 104)
  assert.equal(watermarks.builder, 0)
})

test('source contract: workspace + main-window door + prompt rules are wired', () => {
  assert.match(pluginSource, /function GroupChatWorkspace\(/)
  // Group rows open through the main-window door, feature-detected with the
  // in-panel room as the older-desktop fallback.
  assert.match(pluginSource, /function openGroupChat\(/)
  assert.match(pluginSource, /typeof host\.openWorkspace === 'function'/)
  assert.match(pluginSource, /\$groupChatWorkspace\.set\(group\)/)
  assert.match(pluginSource, /reply with exactly "\(pass\)"/i)
  assert.match(pluginSource, /\[Group chat: "\$\{groupName\}"\]/)
})

test('disband: clears grouping meta, room log, workspace, needs-you; keeps sessions in storage map only for other rooms', async () => {
  const gc = load(() => '(pass)')

  // Two rooms; disband one.
  gc.sendToGroupChat('Keep', [{ name: 'research', title: '' }], 'hello keepers')
  for (let i = 0; i < 200 && (gc.$groupChats.get().Keep || {}).running; i++) {
    await new Promise(resolve => setImmediate(resolve))
  }
  gc.sendToGroupChat('Gone', [{ name: 'builder', title: '' }], 'hello goners')
  for (let i = 0; i < 200 && (gc.$groupChats.get().Gone || {}).running; i++) {
    await new Promise(resolve => setImmediate(resolve))
  }

  gc.$botMeta.set({ builder: { group: 'Gone' }, research: { group: 'Keep' } })
  gc.$groupChatWorkspace.set('Gone')
  gc.$groupNeedsYou.set({ Gone: true, Keep: true })

  await gc.disbandGroupChat('Gone', ['builder'])

  // Room state: gone from the atom (no running drive, so no tombstone).
  assert.equal(gc.$groupChats.get().Gone, undefined)
  assert.ok(gc.$groupChats.get().Keep, 'other rooms untouched')
  // The open room view closed; needs-you cleared for the disbanded room only.
  assert.equal(gc.$groupChatWorkspace.get(), null)
  assert.equal(gc.$groupNeedsYou.get().Gone, undefined)
  assert.equal(gc.$groupNeedsYou.get().Keep, true)
  // Members ungrouped; other bots keep their group.
  assert.equal(gc.$botMeta.get().builder.group, null)
  assert.equal(gc.$botMeta.get().research.group, 'Keep')
  // Persisted room map no longer carries the room.
  const durable = gc.storageWrites.get('group-chats')
  assert.ok(durable && !('Gone' in durable), 'disbanded room not persisted')
  assert.ok('Keep' in durable, 'surviving room still persisted')
})

test('disband: a running room leaves an epoch-bumped empty tombstone so in-flight turns bail', async () => {
  const gc = load(() => '(pass)')

  gc.sendToGroupChat('Live', [{ name: 'research', title: '' }], 'kick off')
  for (let i = 0; i < 200 && (gc.$groupChats.get().Live || {}).running; i++) {
    await new Promise(resolve => setImmediate(resolve))
  }

  // Simulate a drive still in flight at disband time.
  const rooms = { ...gc.$groupChats.get() }
  rooms.Live = { ...rooms.Live, running: true, epoch: 3 }
  gc.$groupChats.set(rooms)

  await gc.disbandGroupChat('Live', ['research'])

  const tomb = gc.$groupChats.get().Live
  assert.ok(tomb, 'tombstone present while a drive is mid-turn')
  assert.equal(tomb.log.length, 0)
  assert.equal(tomb.running, false)
  assert.equal(tomb.epoch, 4, 'epoch bumped so the loop bails at its member boundary')
  const durable = gc.storageWrites.get('group-chats')
  assert.ok(!durable || !('Live' in (durable || {})), 'tombstone is never persisted')
})

test('source contract: workspace header offers disband behind a ConfirmDialog', () => {
  assert.match(pluginSource, /function disbandGroupChat\(/)
  assert.match(pluginSource, /Disband group chat\?/)
  assert.match(pluginSource, /title: `Disband the \$\{group\} group chat`/)
})

test('default profile speaks as Hermes in room transcripts, not @default', () => {
  const gc = load(() => '(pass)')
  const line = gc.formatGroupChatLine({ from: { kind: 'member', name: 'default' }, text: 'hello room' }, 'builder')
  assert.equal(line, 'Hermes: hello room')
  assert.doesNotMatch(line, /default/)

  // Other members keep their profile name; the (you) suffix survives.
  const you = gc.formatGroupChatLine({ from: { kind: 'member', name: 'default' }, text: 'hi' }, 'default')
  assert.equal(you, 'Hermes (you): hi')
  const plain = gc.formatGroupChatLine({ from: { kind: 'member', name: 'builder' }, text: 'yo' }, 'research')
  assert.equal(plain, 'builder: yo')
})

test('turn prompt addresses the default profile as @hermes', () => {
  const gc = load(() => '(pass)')
  const prompt = gc.buildGroupChatTurnPrompt({
    groupName: 'Core',
    members: [{ name: 'default', title: '' }, { name: 'builder', title: '' }],
    viewer: { name: 'default', title: '' },
    deltaLines: []
  })
  assert.match(prompt, /You are @hermes,/)
  assert.doesNotMatch(prompt, /@default\b/)

  const peerView = gc.buildGroupChatTurnPrompt({
    groupName: 'Core',
    members: [{ name: 'default', title: '' }, { name: 'builder', title: '' }],
    viewer: { name: 'builder', title: '' },
    deltaLines: []
  })
  assert.match(peerView, /group chat with @hermes/)
})

test('mention routing: @hermes resolves to the default member', () => {
  const gc = load(() => '(pass)')
  const members = [{ name: 'default', title: '' }, { name: 'builder', title: '' }]
  const parsed = gc.parseGroupChatMentions('@hermes take a look', members)
  assert.equal(parsed.mentioned.has('default'), true)
  assert.equal(parsed.mentioned.size, 1)
})

test('source contract: workspace speaker labels use displayName with a click-to-reveal handle', () => {
  // Speaker labels come from the roster displayName (default → Hermes)…
  assert.match(pluginSource, /displayName\(member \|\| \{ name: entry\.from\.name \}, meta\)/)
  // …and clicking a speaker reveals the full disambiguated handle, with the
  // gateway/device name appended for cross-connection speakers.
  assert.match(pluginSource, /setRevealedSpeaker\(revealed \? null : entryKey\)/)
  assert.match(pluginSource, /\$\{display\}\$\{entry\.from\.source \? `-\$\{entry\.from\.source\}` : ''\} \(@\$\{botHandle\(entry\.from\.name, member \|\| undefined\)\}\)/)
})

test('source contract: room messages carry the speaker avatar via the roster appearance pipeline', () => {
  const start = pluginSource.indexOf('function GroupChatWorkspace(')
  const end = pluginSource.indexOf('function BotsPane(')
  const workspace = pluginSource.slice(start, end === -1 ? undefined : end)

  // Per-message avatar: appearance resolved the same way as BotRow (custom
  // image/pet honored, backfilled PNG dropped so the math face animates).
  assert.match(workspace, /botAppearance\(entry\.from\.name, meta\)/)
  assert.match(workspace, /image && !isBackfilledFacePng\(image\)/)
  assert.match(workspace, /jsx\(BotFace, \{\s*shape,\s*color,\s*image: photo \? image : null,\s*size: 24,\s*name: entry\.from\.name/)

  // Header shows the member faces (capped) with a names tooltip.
  assert.match(workspace, /members\.slice\(0, 6\)\.map\(/)
  assert.match(workspace, /title: members\.map\(b => displayName\(b, botRosterMeta\(b, allMeta\)\)\)\.join\(', '\)/)
})
