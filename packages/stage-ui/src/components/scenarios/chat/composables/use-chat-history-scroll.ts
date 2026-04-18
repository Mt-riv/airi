import type { Ref } from 'vue'

import { computed, nextTick, onScopeDispose, readonly, shallowRef, watch } from 'vue'

import { findTextRangeInElement } from './find-text-range-in-element'

const ATTRIBUTE_QUOTE_RE = /"/g

export interface ActiveChatSpeechSegment {
  intentId: string
  segmentId: string
  sequence: number
  text: string
  ownerId?: string
}

// NOTICE: Keep a small tolerance for "near tail" detection so sub-pixel layout shifts,
// font swaps, and late content growth do not falsely disengage follow mode.
const TAIL_THRESHOLD = 24

function scheduleAfterLayoutSettles(task: () => void) {
  const requestFrame = globalThis.requestAnimationFrame?.bind(globalThis)
  if (!requestFrame) {
    queueMicrotask(task)
    return
  }

  requestFrame(() => {
    requestFrame(() => {
      task()
    })
  })
}

interface ChatHistoryScrollOptions<TMessage> {
  /**
   * The scroll container that owns the chat history viewport.
   *
   * Use this when the composable should manage scroll state for a specific
   * `<div>` or similar scrolling element. The element must be the same node
   * that receives the rendered `[data-chat-message-key]` children, because the
   * composable both measures the container and queries message elements inside it.
   *
   * In practice, pass a template ref from the chat history list component:
   *
   * ```ts
   * const chatHistoryRef = ref<HTMLDivElement>()
   *
   * useChatHistoryScroll({
   *   containerRef: chatHistoryRef,
   *   messages,
   *   getKey,
   * })
   * ```
   */
  containerRef: Ref<HTMLDivElement | undefined>
  /**
   * The ordered chat history currently rendered inside the container.
   *
   * Use this when the message list is reactive and new items or streaming updates
   * can arrive after mount. The composable compares the current tail key with the
   * previous tail key to distinguish between:
   *
   * - a genuinely new tail message
   * - more content being appended to the existing tail message
   *
   * Pass the exact list that the UI renders, including temporary or streaming
   * placeholders if those appear in the chat history surface.
   */
  messages: Ref<TMessage[]>
  /**
   * Returns the stable rendered identity for a message at a given index.
   *
   * Use this when messages have IDs, timestamps, or another stable identity that
   * matches the DOM node's `data-chat-message-key`. The composable relies on this
   * key for two behaviors:
   *
   * - detecting whether the tail changed between updates
   * - locating the newly inserted tail element to align it into view
   *
   * The returned key should be stable for the lifetime of a rendered message.
   * If the key changes while representing the same message, the composable will
   * treat that as a new tail insertion and may scroll unexpectedly.
   */
  getKey: (message: TMessage, index: number) => string | number
  /**
   * Optional policy hook for vetoing auto-scroll on new tail insertions.
   *
   * Use this when product behavior needs one more decision layer beyond the
   * composable's built-in intent tracking. For example, a caller might suppress
   * auto-scroll for a certain role, for a synthetic system row, or while a
   * separate overlay is active.
   *
   * This hook is only consulted for genuinely new tail messages. It is not used
   * for initial mount scroll or for streaming follow of the current tail.
   *
   * Return `false` to block the auto-scroll. Any other return value allows it.
   */
  shouldScroll?: (context: {
    reason: 'new-message'
    messageKey: string | number
    role?: string
    isFollowingTail: boolean
    isInspectingHistory: boolean
  }) => boolean
  /**
   * Reactive handle on the TTS segment currently being voiced.
   *
   * Use this to switch scroll behavior from "stick to the tail" to "keep the
   * currently-voiced sentence in view". While a segment is active, the
   * composable searches the owning message element for the segment text and
   * centers it in the viewport instead of pinning the tail to the bottom.
   *
   * Pass `null` (or leave unset) to opt out of segment-follow entirely.
   */
  activeSegment?: Ref<ActiveChatSpeechSegment | null>
  /**
   * Resolves the rendered message key that owns a given speech segment.
   *
   * The active intent is not trivially correlated with a specific rendered
   * message row — an intent's `ownerId` is typically a character card id, not
   * a message id. Provide a resolver that returns the `data-chat-message-key`
   * of the message whose rendered text is being voiced. Returning `null` or
   * `undefined` falls back to the last message in the list (safe when only
   * one assistant turn can be live at a time).
   */
  resolveMessageKeyForIntent?: (segment: ActiveChatSpeechSegment) => string | number | null | undefined
  /**
   * Returns the cumulative character offset already voiced for an intent.
   *
   * Use this together with `activeSegment` when long assistant messages can
   * repeat the same phrase; the offset lets the text-search skip occurrences
   * that were voiced by earlier segments. See `find-text-range-in-element`
   * for the exact contract.
   */
  getIntentOffset?: (intentId: string) => number
}

/**
 * Keeps chat history scrolling aligned with user intent instead of raw message churn.
 *
 * Design purpose:
 *
 * - Show the latest history on first mount, even if the final layout settles a bit later.
 * - Follow a live conversation while the user is still reading at the tail.
 * - Stop automatic movement once the user starts inspecting older history.
 * - Distinguish a newly inserted tail message from streaming growth of the same tail.
 * - Scroll to the bottom on both new insertions and streaming growth so the latest content is visible.
 *
 * When to use:
 *
 * Use this composable for vertically scrolling chat or timeline surfaces where the
 * latest item normally appears at the bottom and the UI should remain polite about
 * moving the viewport. It is a good fit when messages can arrive from local input,
 * remote sync, IPC, streaming generation, or any other reactive source.
 *
 * How to use:
 *
 * 1. Render the history inside a single scrolling container.
 * 2. Add `data-chat-message-key` to each rendered message wrapper.
 * 3. Pass the container ref, rendered message list, and stable key getter.
 * 4. Optionally provide `shouldScroll` if the caller needs extra veto logic.
 *
 * The composable tracks several signals of user intent, including tail proximity,
 * pointer/focus inspection of older messages, and text selection in history.
 * Automatic follow is preserved only while those signals still indicate that the
 * user wants to stay with the live edge.
 */
export function useChatHistoryScroll<TMessage extends { role?: string }>({
  containerRef,
  messages,
  getKey,
  shouldScroll,
  activeSegment,
  resolveMessageKeyForIntent,
  getIntentOffset,
}: ChatHistoryScrollOptions<TMessage>) {
  const isFollowingTail = shallowRef(true)
  const isFollowingConversation = shallowRef(true)
  const isInspectingOlderMessage = shallowRef(false)
  const isSelectionInspectingHistory = shallowRef(false)
  const isInspectingHistory = computed(() => !isFollowingTail.value || isInspectingOlderMessage.value || isSelectionInspectingHistory.value)
  const pendingScrollKey = shallowRef<string | number | null>(null)
  const pendingStreamingFollow = shallowRef(false)
  const previousLastMessageKey = shallowRef<string | number | null>(null)
  const stopListening = shallowRef<(() => void) | null>(null)
  const didInitialScroll = shallowRef(false)
  const isProgrammaticScroll = shallowRef(false)

  function getContainer() {
    return containerRef.value
  }

  function getLastMessageKey() {
    const lastIndex = messages.value.length - 1
    if (lastIndex < 0)
      return null

    return getKey(messages.value[lastIndex], lastIndex)
  }

  /**
   * Keep chat auto-scroll tied to user intent instead of raw data churn.
   *
   * Criteria:
   * - Scroll to the bottom once on mount so the latest history is visible initially.
   * - Only auto-scroll when a genuinely new tail message is inserted.
   * - Never treat streaming growth of the current tail message like a new tail insertion;
   *   keep bottom-follow only while the user is already following the conversation.
   * - Only follow the live edge while the user is already near the tail.
   * - Stop automatic movement while the user is inspecting older messages through
   *   scrolling, pointer interaction, focus, or text selection.
   * - Scroll to the bottom on new insertions so the tail of the latest message stays in view.
   *
   * This is especially important in Electron, where the chat list can be updated by
   * external synced sources and broadcast events, not just by the local input area.
   */
  function isNearTail(container: HTMLElement) {
    // A small threshold keeps "follow live edge" stable when layout and content height shift slightly.
    return container.scrollTop + container.clientHeight >= container.scrollHeight - TAIL_THRESHOLD
  }

  function updateFollowingTail() {
    const container = getContainer()
    if (!container) {
      isFollowingTail.value = true
      return
    }

    isFollowingTail.value = isNearTail(container)
  }

  function disengageConversationFollow() {
    isFollowingConversation.value = false
  }

  function syncConversationFollowFromTail() {
    if (isFollowingTail.value)
      isFollowingConversation.value = true
  }

  function findMessageElement(target: EventTarget | Node | null) {
    if (!(target instanceof Node))
      return null

    const container = getContainer()
    if (!container)
      return null

    const element = target instanceof Element ? target : target.parentElement
    if (!element)
      return null

    return element.closest<HTMLElement>('[data-chat-message-key]')
  }

  function isLastMessageElement(element: HTMLElement | null) {
    return element?.dataset.chatMessageKey === `${getLastMessageKey() ?? ''}`
  }

  function syncPointerOrFocusInspection(target: EventTarget | null) {
    const element = findMessageElement(target)
    isInspectingOlderMessage.value = !!element && !isLastMessageElement(element)
  }

  function syncSelectionInspection() {
    const selection = document.getSelection()
    if (!selection?.anchorNode) {
      isSelectionInspectingHistory.value = false
      return
    }

    const element = findMessageElement(selection.anchorNode)
    isSelectionInspectingHistory.value = !!element && !isLastMessageElement(element)
  }

  function scrollToBottom() {
    const container = getContainer()
    if (!container)
      return

    isProgrammaticScroll.value = true
    container.scrollTo({ top: container.scrollHeight })
    nextTick(() => {
      isProgrammaticScroll.value = false
      updateFollowingTail()
      syncConversationFollowFromTail()
    })
  }

  function resolveSegmentMessageElement(segment: ActiveChatSpeechSegment): HTMLElement | null {
    const container = getContainer()
    if (!container)
      return null

    // Callers are expected to correlate an intent to its owning rendered
    // message. When they cannot (or do not), fall back to the last message on
    // screen, which matches the common case where only one assistant turn is
    // voicing at a time.
    const resolvedKey = resolveMessageKeyForIntent?.(segment) ?? getLastMessageKey()
    if (resolvedKey == null)
      return null

    // Escape CSS-special characters in the message key before injecting it
    // into an attribute selector. Message keys are usually safe ids, but they
    // can include characters like `:` or `.` when they originate from
    // timestamps or composite strings.
    const escape = (CSS as { escape?: (value: string) => string } | undefined)?.escape
    const keyString = `${resolvedKey}`
    const selector = escape
      ? `[data-chat-message-key="${escape(keyString)}"]`
      : `[data-chat-message-key="${keyString.replace(ATTRIBUTE_QUOTE_RE, '\\"')}"]`

    return container.querySelector<HTMLElement>(selector)
  }

  /**
   * Scroll so the currently-voiced segment text is roughly centered in the
   * chat viewport. Returns whether a scroll actually happened so callers can
   * decide to fall back to tail-follow.
   */
  function scrollActiveSegmentIntoView(): boolean {
    const segment = activeSegment?.value
    if (!segment)
      return false

    if (isInspectingOlderMessage.value || isSelectionInspectingHistory.value)
      return false

    const container = getContainer()
    if (!container)
      return false

    const element = resolveSegmentMessageElement(segment)
    if (!element)
      return false

    const offset = getIntentOffset?.(segment.intentId) ?? 0
    const match = findTextRangeInElement(element, segment.text, offset)
    if (!match)
      return false

    const rangeRect = match.range.getBoundingClientRect()
    const containerRect = container.getBoundingClientRect()
    if (rangeRect.height <= 0 && rangeRect.width <= 0)
      return false

    // Center the voiced text vertically in the viewport. Clamp to valid
    // scroll bounds so we never overshoot past the top of the container or
    // below its current scroll maximum.
    const relativeTop = rangeRect.top - containerRect.top + container.scrollTop
    const target = relativeTop - (container.clientHeight - rangeRect.height) / 2
    const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight)
    const clamped = Math.max(0, Math.min(target, maxScroll))

    isProgrammaticScroll.value = true
    container.scrollTo({ top: clamped })
    nextTick(() => {
      isProgrammaticScroll.value = false
      updateFollowingTail()
    })
    return true
  }

  function bindContainer(container: HTMLDivElement) {
    const handleScroll = () => {
      updateFollowingTail()
      if (!isFollowingTail.value && !isProgrammaticScroll.value)
        disengageConversationFollow()
      else
        syncConversationFollowFromTail()

      if (isFollowingTail.value && !isSelectionInspectingHistory.value)
        isInspectingOlderMessage.value = false
    }

    const handlePointerOver = (event: Event) => {
      syncPointerOrFocusInspection(event.target)
    }

    const handlePointerOut = (event: Event) => {
      const relatedTarget = event instanceof PointerEvent ? event.relatedTarget : null
      syncPointerOrFocusInspection(relatedTarget)
    }

    const handleFocusIn = (event: FocusEvent) => {
      syncPointerOrFocusInspection(event.target)
    }

    const handleFocusOut = (event: FocusEvent) => {
      syncPointerOrFocusInspection(event.relatedTarget)
    }

    const handleSelectionChange = () => {
      syncSelectionInspection()
    }

    // NOTICE: Chat content height can keep growing after the initial DOM insert
    // (async markdown rendering, nested component hydration, image/Live2D layout, etc.).
    // A single scrollToBottom() at message-insert time captures only the height at that moment,
    // so the tail of a long reply can end up below the viewport. While the user is still
    // following the conversation, re-stick to the bottom on any content mutation.
    const contentMutationObserver = typeof MutationObserver !== 'undefined'
      ? new MutationObserver(() => {
          if (isInspectingOlderMessage.value || isSelectionInspectingHistory.value)
            return

          // Prefer keeping the currently-voiced segment in view over pinning
          // the tail; otherwise post-insert markdown hydration would yank the
          // viewport back to the bottom in the middle of a long reply.
          if (activeSegment?.value && scrollActiveSegmentIntoView())
            return

          if (!isFollowingConversation.value)
            return

          scrollToBottom()
        })
      : null

    contentMutationObserver?.observe(container, {
      childList: true,
      subtree: true,
      characterData: true,
    })

    container.addEventListener('scroll', handleScroll, { passive: true })
    container.addEventListener('pointerover', handlePointerOver)
    container.addEventListener('pointerout', handlePointerOut)
    container.addEventListener('focusin', handleFocusIn)
    container.addEventListener('focusout', handleFocusOut)
    document.addEventListener('selectionchange', handleSelectionChange)

    stopListening.value = () => {
      contentMutationObserver?.disconnect()
      container.removeEventListener('scroll', handleScroll)
      container.removeEventListener('pointerover', handlePointerOver)
      container.removeEventListener('pointerout', handlePointerOut)
      container.removeEventListener('focusin', handleFocusIn)
      container.removeEventListener('focusout', handleFocusOut)
      document.removeEventListener('selectionchange', handleSelectionChange)
    }
  }

  watch(containerRef, (container) => {
    stopListening.value?.()
    stopListening.value = null

    if (!container)
      return

    bindContainer(container)
    updateFollowingTail()
    syncConversationFollowFromTail()
    syncSelectionInspection()

    if (!didInitialScroll.value) {
      didInitialScroll.value = true
      nextTick(() => {
        scheduleAfterLayoutSettles(() => {
          scrollToBottom()
        })
      })
    }
  }, { immediate: true })

  watch(messages, (currentMessages) => {
    const currentLastIndex = currentMessages.length - 1
    if (currentLastIndex < 0) {
      previousLastMessageKey.value = null
      pendingScrollKey.value = null
      isInspectingOlderMessage.value = false
      isSelectionInspectingHistory.value = false
      return
    }

    const currentLastMessage = currentMessages[currentLastIndex]
    const currentLastKey = getKey(currentLastMessage, currentLastIndex)
    const previousTailKey = previousLastMessageKey.value
    previousLastMessageKey.value = currentLastKey

    // The last key change is the boundary between "a new message arrived" and "the current tail
    // is still streaming more content". Only the first case is allowed to move the viewport.
    if (previousTailKey == null) {
      pendingScrollKey.value = null
      pendingStreamingFollow.value = false
      return
    }

    if (previousTailKey === currentLastKey) {
      pendingScrollKey.value = null
      if (!isFollowingConversation.value || isInspectingOlderMessage.value || isSelectionInspectingHistory.value) {
        pendingStreamingFollow.value = false
        return
      }

      pendingStreamingFollow.value = true
      return
    }

    if (!isFollowingConversation.value || isInspectingOlderMessage.value || isSelectionInspectingHistory.value) {
      pendingScrollKey.value = null
      pendingStreamingFollow.value = false
      return
    }

    const shouldScrollResult = shouldScroll?.({
      reason: 'new-message',
      messageKey: currentLastKey,
      role: currentLastMessage.role,
      isFollowingTail: isFollowingConversation.value,
      isInspectingHistory: isInspectingOlderMessage.value || isSelectionInspectingHistory.value,
    })
    if (shouldScrollResult === false) {
      pendingScrollKey.value = null
      pendingStreamingFollow.value = false
      return
    }

    pendingScrollKey.value = currentLastKey
    pendingStreamingFollow.value = false
  }, { deep: false, immediate: true })

  watch(pendingScrollKey, async (messageKey) => {
    if (messageKey == null)
      return

    await nextTick()
    pendingScrollKey.value = null

    // Scroll to the bottom so the tail of the latest message stays visible.
    // `scrollToBottom()` handles the programmatic-scroll flag and re-syncs follow state.
    scrollToBottom()
  }, { flush: 'post' })

  watch(pendingStreamingFollow, async (shouldFollow) => {
    if (!shouldFollow)
      return

    await nextTick()
    pendingStreamingFollow.value = false

    // Segment-follow wins over tail-follow whenever a segment is voicing, so
    // streaming growth under the current segment keeps the spoken text in view
    // instead of dragging the viewport to the bottom.
    if (activeSegment?.value && scrollActiveSegmentIntoView())
      return

    scrollToBottom()
  }, { flush: 'post' })

  if (activeSegment) {
    watch(activeSegment, async (segment) => {
      if (!segment)
        return

      await nextTick()
      scrollActiveSegmentIntoView()
    }, { flush: 'post' })
  }

  onScopeDispose(() => {
    stopListening.value?.()
  })

  return {
    isFollowingTail: readonly(isFollowingTail),
    isInspectingHistory: readonly(isInspectingHistory),
    scrollToBottom,
  }
}
