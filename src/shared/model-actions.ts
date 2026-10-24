export type ForgetSelection = { modelId: number; versionId?: number }
export type ForgetResult = ForgetSelection & { removedVersionIds: number[] }

export function matchesSelection(selection: ForgetSelection, modelId: number, versionId?: number): boolean {
  return selection.modelId === modelId && (selection.versionId == null || selection.versionId === versionId)
}
