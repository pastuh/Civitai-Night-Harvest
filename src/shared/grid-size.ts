export const GRID_SIZE_MIN_PX = 96
export const GRID_SIZE_MAX_PX = 320
export const DEFAULT_GALLERY_GRID_MIN_PX = 160
export const DEFAULT_QUEUE_GRID_MIN_PX = 160

export function clampGridSizePx(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_GALLERY_GRID_MIN_PX
  return Math.min(GRID_SIZE_MAX_PX, Math.max(GRID_SIZE_MIN_PX, Math.round(value)))
}
