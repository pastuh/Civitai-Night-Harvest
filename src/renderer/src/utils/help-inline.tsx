import { Fragment, type ReactNode } from 'react'

/**
 * Lightweight inline markup for Help copy:
 * - **bold**
 * - `code` / paths
 * Plain text otherwise (no raw markdown symbols left visible).
 */
export function helpInline(text: string): ReactNode {
  if (!text) return text
  const nodes: ReactNode[] = []
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g
  let last = 0
  let m: RegExpExecArray | null
  let key = 0
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      nodes.push(<Fragment key={key++}>{text.slice(last, m.index)}</Fragment>)
    }
    const token = m[0]
    if (token.startsWith('**') && token.endsWith('**')) {
      nodes.push(<strong key={key++}>{token.slice(2, -2)}</strong>)
    } else if (token.startsWith('`') && token.endsWith('`')) {
      nodes.push(<code key={key++}>{token.slice(1, -1)}</code>)
    } else {
      nodes.push(<Fragment key={key++}>{token}</Fragment>)
    }
    last = m.index + token.length
  }
  if (last < text.length) {
    nodes.push(<Fragment key={key++}>{text.slice(last)}</Fragment>)
  }
  return nodes.length === 1 ? nodes[0] : <>{nodes}</>
}
