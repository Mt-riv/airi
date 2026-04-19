import type { UserMessage } from '@xsai/shared-chat'

import type { EphemeralDocAttachment } from '../../types/chat-attachment'

const AMP_RE = /&/g
const LT_RE = /</g
const GT_RE = />/g
const DQ_RE = /"/g
const SQ_RE = /'/g

function escapeXml(input: string): string {
  return input
    .replace(AMP_RE, '&amp;')
    .replace(LT_RE, '&lt;')
    .replace(GT_RE, '&gt;')
    .replace(DQ_RE, '&quot;')
    .replace(SQ_RE, '&apos;')
}

export function formatAttachmentPromptText(items: EphemeralDocAttachment[]): string {
  if (items.length === 0)
    return ''

  const documents = items
    .map((item) => {
      const safeName = escapeXml(item.name)
      return `<document name="${safeName}" mime="${item.mimeType}" size="${item.sizeBytes}">\n${item.content}\n</document>`
    })
    .join('\n')

  return ''
    + `<attached_documents count="${items.length}">\n`
    + `${documents}\n`
    + `</attached_documents>\n`
    + 'The user has attached these documents as reference context for this conversation. '
    + 'Use them as authoritative background when answering questions about their contents. '
    + 'Do not mention the XML wrapper itself.'
}

export function buildAttachmentPromptMessage(items: EphemeralDocAttachment[]): UserMessage | null {
  const promptText = formatAttachmentPromptText(items)
  if (!promptText)
    return null

  return {
    role: 'user',
    content: [
      {
        type: 'text',
        text: promptText,
      },
    ],
  }
}
