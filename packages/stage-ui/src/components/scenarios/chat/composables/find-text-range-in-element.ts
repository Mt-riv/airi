const WHITESPACE_RUN_RE = /\s+/g
const WHITESPACE_CHAR_RE = /\s/

interface TextNodeEntry {
  node: Text
  start: number
  end: number
}

function collectTextNodes(element: Element): { entries: TextNodeEntry[], text: string } {
  const entries: TextNodeEntry[] = []
  let text = ''

  const walker = element.ownerDocument?.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  if (!walker)
    return { entries, text }

  let node = walker.nextNode() as Text | null
  while (node) {
    const value = node.nodeValue ?? ''
    const start = text.length
    const end = start + value.length
    entries.push({ node, start, end })
    text += value
    node = walker.nextNode() as Text | null
  }

  return { entries, text }
}

function normalizeWhitespace(value: string): string {
  return value.replace(WHITESPACE_RUN_RE, ' ').trim()
}

function findEntryContaining(entries: TextNodeEntry[], position: number, inclusive: boolean): TextNodeEntry | null {
  for (const entry of entries) {
    if (inclusive ? position >= entry.start && position <= entry.end : position >= entry.start && position < entry.end)
      return entry
  }

  return null
}

/**
 * Locate a spoken text segment inside a rendered chat message element and
 * return a DOM Range that covers the matched substring.
 *
 * Design purpose:
 *
 * - Chat messages render through Markdown, so the rendered text nodes do not
 *   line up with the raw tokens that were sent to the TTS pipeline. The
 *   currently-playing segment's text is the most reliable anchor we have.
 * - Long messages can contain the same phrase multiple times. Segments play
 *   in order, so the caller tracks the cumulative character offset of the
 *   previous segment and passes it as `fromCharOffset` to avoid matching
 *   already-spoken occurrences.
 * - Whitespace (newlines, indentation, collapsed spaces) often differs between
 *   the TTS input stream and the rendered DOM. A raw `indexOf` is tried first
 *   for accuracy; a whitespace-normalized fallback keeps things working when
 *   the rendered text flattens or re-wraps whitespace.
 *
 * When to use:
 *
 * Use this in the chat history surface when scrolling to follow spoken audio.
 * The caller is expected to resolve the target message element (for example by
 * `[data-chat-message-key]`), the text of the active TTS segment, and the
 * character offset where the previous segment ended inside the same intent.
 *
 * How to use:
 *
 * 1. Find the message element that owns the currently-playing intent.
 * 2. Pass the element, segment text, and the intent's running char offset.
 * 3. If a result is returned, scroll the range into view and update the
 *    running offset to `charEnd` for the next segment in the same intent.
 * 4. If `null` is returned, fall back to a message-level scroll.
 *
 * Returns `null` when the element has no text, the segment is empty, or no
 * match can be found even after whitespace normalization.
 */
export function findTextRangeInElement(
  element: Element,
  segmentText: string,
  fromCharOffset: number = 0,
): { range: Range, charEnd: number } | null {
  const trimmedSegment = segmentText.trim()
  if (!trimmedSegment)
    return null

  const { entries, text } = collectTextNodes(element)
  if (entries.length === 0 || !text)
    return null

  const doc = element.ownerDocument
  if (!doc)
    return null

  const safeFrom = Math.max(0, Math.min(fromCharOffset, text.length))

  // Attempt raw match first. This preserves exact character offsets and is the
  // cheap path when the rendered text matches the spoken text one-to-one.
  let matchStart = text.indexOf(trimmedSegment, safeFrom)
  let matchEnd = matchStart >= 0 ? matchStart + trimmedSegment.length : -1

  if (matchStart < 0) {
    // Whitespace-normalized fallback. Build a map from normalized positions
    // back to raw positions so the returned Range still points at the real
    // DOM text nodes.
    const normalizedSegment = normalizeWhitespace(trimmedSegment)
    if (!normalizedSegment)
      return null

    const normalizedTextChars: string[] = []
    const normalizedToRaw: number[] = []
    let lastWasSpace = false
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]
      if (WHITESPACE_CHAR_RE.test(ch)) {
        if (!lastWasSpace && normalizedTextChars.length > 0) {
          normalizedTextChars.push(' ')
          normalizedToRaw.push(i)
        }
        lastWasSpace = true
      }
      else {
        normalizedTextChars.push(ch)
        normalizedToRaw.push(i)
        lastWasSpace = false
      }
    }

    // Drop any trailing single space (mirrors the `.trim()` at the head).
    while (normalizedTextChars.length > 0 && normalizedTextChars.at(-1) === ' ') {
      normalizedTextChars.pop()
      normalizedToRaw.pop()
    }

    const normalizedText = normalizedTextChars.join('')
    if (!normalizedText)
      return null

    // Translate the incoming raw offset into normalized coordinates so we do
    // not re-scan text that belongs to an earlier segment.
    let normalizedFrom = 0
    while (normalizedFrom < normalizedToRaw.length && normalizedToRaw[normalizedFrom] < safeFrom)
      normalizedFrom++

    const normalizedMatch = normalizedText.indexOf(normalizedSegment, normalizedFrom)
    const fallbackMatch = normalizedMatch < 0
      ? normalizedText.indexOf(normalizedSegment)
      : normalizedMatch
    if (fallbackMatch < 0)
      return null

    matchStart = normalizedToRaw[fallbackMatch]
    const endNormalized = fallbackMatch + normalizedSegment.length - 1
    const lastRawIndex = endNormalized < normalizedToRaw.length ? normalizedToRaw[endNormalized] : text.length - 1
    matchEnd = lastRawIndex + 1
  }

  const startEntry = findEntryContaining(entries, matchStart, false) ?? findEntryContaining(entries, matchStart, true)
  const endEntry = findEntryContaining(entries, Math.max(matchEnd - 1, matchStart), false) ?? findEntryContaining(entries, matchEnd, true)
  if (!startEntry || !endEntry)
    return null

  const range = doc.createRange()
  range.setStart(startEntry.node, matchStart - startEntry.start)
  range.setEnd(endEntry.node, Math.min(matchEnd, endEntry.end) - endEntry.start)

  return { range, charEnd: matchEnd }
}
