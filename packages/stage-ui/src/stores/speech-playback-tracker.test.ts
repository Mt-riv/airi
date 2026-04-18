import type {
  PlaybackEndEvent,
  PlaybackInterruptEvent,
  PlaybackItem,
  PlaybackStartEvent,
} from '@proj-airi/pipelines-audio'

import type { PlaybackEventSource } from './speech-playback-tracker'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { useSpeechPlaybackTrackerStore } from './speech-playback-tracker'

type Audio = ArrayBuffer

function createFakePlaybackSource() {
  const startListeners: Array<(event: PlaybackStartEvent<Audio>) => void> = []
  const endListeners: Array<(event: PlaybackEndEvent<Audio>) => void> = []
  const interruptListeners: Array<(event: PlaybackInterruptEvent<Audio>) => void> = []

  const source: PlaybackEventSource<Audio> = {
    onStart: listener => void startListeners.push(listener),
    onEnd: listener => void endListeners.push(listener),
    onInterrupt: listener => void interruptListeners.push(listener),
  }

  return {
    source,
    emitStart: (item: PlaybackItem<Audio>) => startListeners.forEach(l => l({ item, startedAt: Date.now() })),
    emitEnd: (item: PlaybackItem<Audio>) => endListeners.forEach(l => l({ item, endedAt: Date.now() })),
    emitInterrupt: (item: PlaybackItem<Audio>, reason = 'test') =>
      interruptListeners.forEach(l => l({ item, reason, interruptedAt: Date.now() })),
  }
}

function makeItem(partial: Partial<PlaybackItem<Audio>> & Pick<PlaybackItem<Audio>, 'intentId' | 'segmentId' | 'sequence' | 'text'>): PlaybackItem<Audio> {
  return {
    id: `${partial.intentId}-${partial.segmentId}`,
    streamId: partial.streamId ?? `stream-${partial.intentId}`,
    priority: partial.priority ?? 0,
    special: partial.special ?? null,
    audio: partial.audio ?? new ArrayBuffer(0),
    createdAt: partial.createdAt ?? Date.now(),
    ownerId: partial.ownerId,
    ...partial,
  }
}

describe('useSpeechPlaybackTrackerStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('exposes the active segment while playback is running', () => {
    const tracker = useSpeechPlaybackTrackerStore()
    const { source, emitStart } = createFakePlaybackSource()
    tracker.registerHost(source)

    const item = makeItem({ intentId: 'i1', segmentId: 's1', sequence: 0, text: 'Hello world.' })
    emitStart(item)

    expect(tracker.activeSegment).toEqual({
      intentId: 'i1',
      segmentId: 's1',
      sequence: 0,
      text: 'Hello world.',
      ownerId: undefined,
    })
  })

  it('advances the per-intent offset when a segment ends cleanly', () => {
    const tracker = useSpeechPlaybackTrackerStore()
    const { source, emitStart, emitEnd } = createFakePlaybackSource()
    tracker.registerHost(source)

    const first = makeItem({ intentId: 'i1', segmentId: 's1', sequence: 0, text: 'Hello world.' })
    emitStart(first)
    emitEnd(first)

    expect(tracker.activeSegment).toBeNull()
    expect(tracker.getIntentOffset('i1')).toBe('Hello world.'.length)

    const second = makeItem({ intentId: 'i1', segmentId: 's2', sequence: 1, text: ' Nice to meet you.' })
    emitStart(second)
    emitEnd(second)

    expect(tracker.getIntentOffset('i1')).toBe('Hello world.'.length + ' Nice to meet you.'.length)
  })

  it('does not advance the offset when a segment is interrupted', () => {
    const tracker = useSpeechPlaybackTrackerStore()
    const { source, emitStart, emitInterrupt } = createFakePlaybackSource()
    tracker.registerHost(source)

    const item = makeItem({ intentId: 'i1', segmentId: 's1', sequence: 0, text: 'Hello world.' })
    emitStart(item)
    emitInterrupt(item, 'barge-in')

    expect(tracker.activeSegment).toBeNull()
    expect(tracker.getIntentOffset('i1')).toBe(0)
  })

  it('ignores end events for items that are not the active segment', () => {
    const tracker = useSpeechPlaybackTrackerStore()
    const { source, emitStart, emitEnd, emitInterrupt } = createFakePlaybackSource()
    tracker.registerHost(source)

    const stolen = makeItem({ intentId: 'i1', segmentId: 's1', sequence: 0, text: 'Stolen.' })
    emitStart(stolen)
    emitInterrupt(stolen, 'steal-oldest')

    // A late `end` for the stolen item should not bump the offset nor resurrect
    // the active segment snapshot.
    emitEnd(stolen)

    expect(tracker.activeSegment).toBeNull()
    expect(tracker.getIntentOffset('i1')).toBe(0)
  })

  it('keeps offsets isolated between intents', () => {
    const tracker = useSpeechPlaybackTrackerStore()
    const { source, emitStart, emitEnd } = createFakePlaybackSource()
    tracker.registerHost(source)

    const a = makeItem({ intentId: 'A', segmentId: 's1', sequence: 0, text: 'Alpha.' })
    const b = makeItem({ intentId: 'B', segmentId: 's1', sequence: 0, text: 'Beta beta.' })

    emitStart(a)
    emitEnd(a)
    emitStart(b)
    emitEnd(b)

    expect(tracker.getIntentOffset('A')).toBe('Alpha.'.length)
    expect(tracker.getIntentOffset('B')).toBe('Beta beta.'.length)
  })

  it('resetIntent clears the offset and active segment for that intent', () => {
    const tracker = useSpeechPlaybackTrackerStore()
    const { source, emitStart, emitEnd } = createFakePlaybackSource()
    tracker.registerHost(source)

    const first = makeItem({ intentId: 'i1', segmentId: 's1', sequence: 0, text: 'Done.' })
    emitStart(first)
    emitEnd(first)

    const live = makeItem({ intentId: 'i1', segmentId: 's2', sequence: 1, text: 'Playing.' })
    emitStart(live)

    tracker.resetIntent('i1')

    expect(tracker.activeSegment).toBeNull()
    expect(tracker.getIntentOffset('i1')).toBe(0)
  })

  it('reset clears all state', () => {
    const tracker = useSpeechPlaybackTrackerStore()
    const { source, emitStart, emitEnd } = createFakePlaybackSource()
    tracker.registerHost(source)

    emitStart(makeItem({ intentId: 'i1', segmentId: 's1', sequence: 0, text: 'Hi.' }))
    emitEnd(makeItem({ intentId: 'i1', segmentId: 's1', sequence: 0, text: 'Hi.' }))
    emitStart(makeItem({ intentId: 'i2', segmentId: 's1', sequence: 0, text: 'Playing.' }))

    tracker.reset()

    expect(tracker.activeSegment).toBeNull()
    expect(tracker.getIntentOffset('i1')).toBe(0)
    expect(tracker.getIntentOffset('i2')).toBe(0)
  })
})
