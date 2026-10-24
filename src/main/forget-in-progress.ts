// Protect the file-delete window before inventory commits the durable Forget selection.
const models = new Set<number>()
const versions = new Set<number>()
const busyModels = new Set<number>()
export function beginForget(modelId: number, versionId?: number): () => void {
  const set = versionId == null ? models : versions
  const key = versionId ?? modelId
  if (busyModels.has(modelId) || set.has(key)) throw new Error('Forget is already in progress')
  busyModels.add(modelId)
  set.add(key)
  return () => { set.delete(key); busyModels.delete(modelId) }
}
export const isForgettingModel = (modelId: number): boolean => models.has(modelId)
export const isForgettingVersion = (versionId: number): boolean => versions.has(versionId)
