import type { ReactNode } from 'react'
import type { InventoryRecord } from '../../../shared/types'

export function buildModelNameIndex(inventory: InventoryRecord[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const rec of inventory) {
    const name = rec.modelName?.trim()
    if (!name) continue
    if (!map.has(name)) map.set(name, rec.modelId)
  }
  return map
}

export function linkifyActivityMessage(
  message: string,
  nameToModelId: Map<string, number>,
  onJumpToModel: (modelId: number) => void,
  entryModelId?: number
): ReactNode {
  const names = [...nameToModelId.keys()].sort((a, b) => b.length - a.length)
  if (!names.length && entryModelId == null) return message

  type Part = { kind: 'text'; value: string } | { kind: 'link'; name: string; modelId: number }

  function splitText(text: string): Part[] {
    if (!text) return []
    let best: { index: number; name: string; modelId: number } | null = null
    for (const name of names) {
      const idx = text.indexOf(name)
      if (idx < 0) continue
      if (!best || idx < best.index || (idx === best.index && name.length > best.name.length)) {
        best = { index: idx, name, modelId: nameToModelId.get(name)! }
      }
    }
    if (!best) return [{ kind: 'text', value: text }]
    const before = text.slice(0, best.index)
    const after = text.slice(best.index + best.name.length)
    return [...splitText(before), { kind: 'link', name: best.name, modelId: best.modelId }, ...splitText(after)]
  }

  const parts = splitText(message)
  if (parts.length === 1 && parts[0].kind === 'text' && entryModelId != null) {
    return (
      <>
        {message}{' '}
        <button type="button" className="log-model-link" onClick={() => onJumpToModel(entryModelId)}>
          View in Library →
        </button>
      </>
    )
  }

  return parts.map((part, i) =>
    part.kind === 'text' ? (
      <span key={i}>{part.value}</span>
    ) : (
      <button
        key={i}
        type="button"
        className="log-model-link"
        onClick={() => onJumpToModel(part.modelId)}
      >
        {part.name}
      </button>
    )
  )
}
