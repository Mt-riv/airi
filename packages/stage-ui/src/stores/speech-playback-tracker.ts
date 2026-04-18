import type {
  PlaybackEndEvent,
  PlaybackInterruptEvent,
  PlaybackItem,
  PlaybackStartEvent,
} from '@proj-airi/pipelines-audio'

import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * Playback manager surface that the tracker depends on.
 *
 * Mirrors the subset of `createPlaybackManager(...)` used here so unit tests
 * can swap in a fake without dragging in the whole audio pipeline.
 */
export interface PlaybackEventSource<TAudio> {
  onStart: (listener: (event: PlaybackStartEvent<TAudio>) => void) => void
  onEnd: (listener: (event: PlaybackEndEvent<TAudio>) => void) => void
  onInterrupt: (listener: (event: PlaybackInterruptEvent<TAudio>) => void) => void
}

/**
 * Snapshot of the TTS segment currently being played.
 *
 * Chat scroll-follow consumers use `text` as the anchor to look up inside the
 * rendered DOM and `intentId` as the key into the per-intent cumulative char
 * offset map so repeated phrases in the same message do not collapse onto the
 * first occurrence.
 */
export interface ActiveSpeechSegment {
  intentId: string
  segmentId: string
  sequence: number
  text: string
  ownerId?: string
}

/**
 * Tracks which TTS segment is currently playing, plus a cumulative "chars
 * already spoken" counter per intent.
 *
 * Why:
 *
 * - The chat-history scroll follower needs a reactive handle on the segment
 *   currently being voiced so it can scroll the corresponding rendered text
 *   into view.
 * - Long assistant messages can contain the same phrase more than once.
 *   Segments play in sequence, so we advance a per-intent offset each time a
 *   segment finishes cleanly. The scroll code searches the DOM starting from
 *   that offset and avoids matching phrases that were already voiced.
 *
 * Lifecycle:
 *
 * - `onStart` → set `activeSegment`.
 * - `onEnd`   → if the ending item matches the active segment, advance the
 *   intent's offset by the segment text length and clear `activeSegment`.
 *   Non-active ends (e.g., after an interrupt/steal) do not advance the
 *   offset, because the listener ordering between `interrupt` and `end` is
 *   not contractually fixed.
 * - `onInterrupt` → clear `activeSegment` if it matches, without advancing
 *   the offset (a barge-in cut the segment off partway).
 * - `resetIntent(intentId)` → drop the per-intent offset. Callers can invoke
 *   this when a new turn starts or when scroll-follow should re-anchor.
 * - `reset()` → clear everything (message list reset, host teardown).
 */
export const useSpeechPlaybackTrackerStore = defineStore('speech-playback-tracker', () => {
  const activeSegment = ref<ActiveSpeechSegment | null>(null)
  const intentOffsets = ref(new Map<string, number>())

  function toSnapshot<TAudio>(item: PlaybackItem<TAudio>): ActiveSpeechSegment {
    return {
      intentId: item.intentId,
      segmentId: item.segmentId,
      sequence: item.sequence,
      text: item.text,
      ownerId: item.ownerId,
    }
  }

  function isSameItem<TAudio>(item: PlaybackItem<TAudio>, segment: ActiveSpeechSegment | null) {
    if (!segment)
      return false
    return segment.intentId === item.intentId && segment.segmentId === item.segmentId && segment.sequence === item.sequence
  }

  function registerHost<TAudio>(source: PlaybackEventSource<TAudio>) {
    source.onStart(({ item }) => {
      activeSegment.value = toSnapshot(item)
    })

    source.onEnd(({ item }) => {
      if (!isSameItem(item, activeSegment.value))
        return

      const previous = intentOffsets.value.get(item.intentId) ?? 0
      intentOffsets.value.set(item.intentId, previous + item.text.length)
      activeSegment.value = null
    })

    source.onInterrupt(({ item }) => {
      if (isSameItem(item, activeSegment.value))
        activeSegment.value = null
    })
  }

  function getIntentOffset(intentId: string): number {
    return intentOffsets.value.get(intentId) ?? 0
  }

  function resetIntent(intentId: string) {
    intentOffsets.value.delete(intentId)
    if (activeSegment.value?.intentId === intentId)
      activeSegment.value = null
  }

  function reset() {
    activeSegment.value = null
    intentOffsets.value.clear()
  }

  return {
    activeSegment,
    registerHost,
    getIntentOffset,
    resetIntent,
    reset,
  }
})
