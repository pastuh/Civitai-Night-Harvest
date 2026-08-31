import type { WatchRuleTestResult } from '../../../shared/types'

/** Move preferred preview URL to front for a model card in a Browse gallery snapshot. */
export function patchBrowseModelPreview(
  gallery: WatchRuleTestResult | null,
  modelId: number,
  versionId: number,
  previewUrl: string
): WatchRuleTestResult | null {
  if (!gallery?.sampleModels?.length) return gallery
  const idx = gallery.sampleModels.findIndex(
    (m) => m.id === modelId && (versionId <= 0 || m.versionId === versionId)
  )
  if (idx < 0) return gallery
  const model = gallery.sampleModels[idx]
  const baseUrls = model.previewUrls?.length
    ? model.previewUrls
    : model.previewUrl
      ? [model.previewUrl]
      : []
  const previewUrls = [previewUrl, ...baseUrls.filter((u) => u && u !== previewUrl)]
  const sampleModels = gallery.sampleModels.slice()
  sampleModels[idx] = { ...model, previewUrl, previewUrls }
  return { ...gallery, sampleModels }
}
