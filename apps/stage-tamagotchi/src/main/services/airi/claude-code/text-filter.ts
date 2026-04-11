// Module-scope regex patterns to avoid re-compilation on every call.
const FENCED_CODE_BLOCK_PATTERN = /```[\s\S]*?```/g
const IMAGE_MARKDOWN_PATTERN = /!\[([^\]]*)\]\([^)]*\)/g
const LINK_MARKDOWN_PATTERN = /\[([^\]]*)\]\([^)]*\)/g
const URL_PATTERN = /https?:\/\/[^\s)]+/g
const HORIZONTAL_RULE_PATTERN = /^[-*_]{3,}$/
const HEADING_PATTERN = /^#{1,6}\s(.+)$/
const UNORDERED_LIST_PATTERN = /^[-*]\s(.+)$/
const ORDERED_LIST_PATTERN = /^\d+\.\s(.+)$/
const INLINE_CODE_PATTERN = /`([^`]*)`/g
const SELF_CLOSING_TAG_PATTERN = /<[^>]+\/>/g
const HTML_TAG_PATTERN = /<[^>]+>/g
const GIT_HASH_PATTERN = /\b[0-9a-f]{7,40}\b/g
const MULTIPLE_NEWLINES_PATTERN = /\n+/g
const MULTIPLE_SPACES_PATTERN = / {2,}/g
const VERSION_BEFORE_PERIOD_PATTERN = /\d$/
const VERSION_AFTER_PERIOD_PATTERN = /^[0-9.]/
const ABBREVIATION_PATTERN = /\b[a-z]$/i
const ABBREVIATION_CONTINUATION_PATTERN = /^[a-z]/i

/**
 * Strip markdown, code blocks, URLs, and other non-speech content from
 * Claude Code's assistant text so it reads naturally when spoken aloud.
 */
export function cleanTextForSpeech(text: string): string {
  if (text.length === 0)
    return ''

  let result = text

  // 1. Remove fenced code blocks (with or without language tag)
  result = result.replace(FENCED_CODE_BLOCK_PATTERN, '')

  // 11. Remove image markdown: ![alt](url) -> alt
  result = result.replace(IMAGE_MARKDOWN_PATTERN, '$1')

  // 11. Remove link markdown: [text](url) -> text
  result = result.replace(LINK_MARKDOWN_PATTERN, '$1')

  // 9. Remove URLs (http:// and https://)
  result = result.replace(URL_PATTERN, '')

  // Process line by line for line-start patterns
  result = result
    .split('\n')
    .map((line) => {
      const trimmed = line.trim()

      // 5. Remove horizontal rules: ---, ***, ___ (3+ chars of same)
      if (HORIZONTAL_RULE_PATTERN.test(trimmed))
        return ''

      // 6. Remove table syntax: lines starting with |
      if (trimmed.startsWith('|'))
        return ''

      // 4. Remove markdown headings: # Heading -> Heading
      const headingMatch = trimmed.match(HEADING_PATTERN)
      if (headingMatch)
        return headingMatch[1]

      // 7. Remove blockquotes: > text -> text (supports nested)
      let processed = trimmed
      while (processed.startsWith('>')) {
        processed = processed.slice(1).trim()
      }
      if (processed !== trimmed)
        return processed

      // 8. Remove list markers: - item, * item, 1. item -> item
      const unorderedMatch = trimmed.match(UNORDERED_LIST_PATTERN)
      if (unorderedMatch)
        return unorderedMatch[1]

      const orderedMatch = trimmed.match(ORDERED_LIST_PATTERN)
      if (orderedMatch)
        return orderedMatch[1]

      return line
    })
    .join('\n')

  // 2. Remove inline code backticks but keep the text content
  result = result.replace(INLINE_CODE_PATTERN, '$1')

  // 3. Remove XML/HTML tags but keep inner content
  result = result.replace(SELF_CLOSING_TAG_PATTERN, '')
  result = result.replace(HTML_TAG_PATTERN, '')

  // 10. Remove git hashes: standalone 7-40 character hex strings
  result = result.replace(GIT_HASH_PATTERN, '')

  // 12. Collapse multiple newlines/spaces into single space
  result = result.replace(MULTIPLE_NEWLINES_PATTERN, ' ')
  result = result.replace(MULTIPLE_SPACES_PATTERN, ' ')

  // 13. Trim leading/trailing whitespace
  result = result.trim()

  return result
}

/**
 * Split cleaned text into individual sentences suitable for TTS chunking.
 * Splits on Japanese and English sentence terminators.
 */
export function splitIntoSentences(text: string): string[] {
  if (text.length === 0)
    return []

  const sentences: string[] = []
  let current = ''

  for (let i = 0; i < text.length; i++) {
    const char = text[i]

    // Split on newlines
    if (char === '\n') {
      if (current.trim().length > 0) {
        sentences.push(current.trim())
      }
      current = ''
      continue
    }

    current += char

    // Japanese sentence terminators
    if (char === '\u3002' || char === '\uFF01' || char === '\uFF1F') {
      sentences.push(current.trim())
      current = ''
      continue
    }

    // English ! and ?
    if (char === '!' || char === '?') {
      sentences.push(current.trim())
      current = ''
      continue
    }

    // English period: only split on ". " (period followed by space)
    if (char === '.' && i + 1 < text.length && text[i + 1] === ' ') {
      const before = current.slice(0, -1)
      const afterSpace = text.substring(i + 2)

      // Version numbers like "v2.1.96"
      if (VERSION_BEFORE_PERIOD_PATTERN.test(before) && VERSION_AFTER_PERIOD_PATTERN.test(afterSpace)) {
        continue
      }

      // Abbreviations like "e.g."
      if (ABBREVIATION_PATTERN.test(before) && i + 2 < text.length && ABBREVIATION_CONTINUATION_PATTERN.test(text[i + 2])) {
        continue
      }

      sentences.push(current.trim())
      current = ''
      i++ // Skip the space after the period
      continue
    }

    // Period at end of text (last char)
    if (char === '.' && i === text.length - 1) {
      sentences.push(current.trim())
      current = ''
      continue
    }
  }

  if (current.trim().length > 0) {
    sentences.push(current.trim())
  }

  return sentences.filter(s => s.length > 0)
}
