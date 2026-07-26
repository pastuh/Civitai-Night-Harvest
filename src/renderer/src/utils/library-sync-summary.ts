import type { InventoryGetResult } from '../../../shared/types'
import type { AppLocale } from '../../../shared/locale'
import { translate } from '../i18n/context'
import { formatModelWeight } from '../../../shared/utils'

export function formatLibrarySyncSummary(inv: InventoryGetResult, locale: AppLocale = 'en'): string {
  const checked = inv.checked ?? inv.items.length
  const parts: string[] = []
  if (inv.diskScanned != null && inv.diskScanned > 0) {
    parts.push(translate(locale, 'syncSummary.scanned', { count: inv.diskScanned }))
  }
  if (inv.importedFromDisk != null && inv.importedFromDisk > 0) {
    parts.push(translate(locale, 'syncSummary.imported', { count: inv.importedFromDisk }))
  }
  if (inv.relinkedFromDisk != null && inv.relinkedFromDisk > 0) {
    parts.push(translate(locale, 'syncSummary.relinked', { count: inv.relinkedFromDisk }))
  }
  if (inv.importedLocalFromDisk != null && inv.importedLocalFromDisk > 0) {
    parts.push(translate(locale, 'syncSummary.importedLocal', { count: inv.importedLocalFromDisk }))
  }
  if (inv.localDuplicatesMarked != null && inv.localDuplicatesMarked > 0) {
    parts.push(translate(locale, 'syncSummary.localDuplicates', { count: inv.localDuplicatesMarked }))
  }
  if (inv.localPromoted != null && inv.localPromoted > 0) {
    parts.push(translate(locale, 'syncSummary.localPromoted', { count: inv.localPromoted }))
  }
  if (inv.localStillUnrecognized != null && inv.localStillUnrecognized > 0) {
    parts.push(
      translate(locale, 'syncSummary.localUnrecognized', { count: inv.localStillUnrecognized })
    )
  }
  if (inv.removedMissing > 0) {
    parts.push(translate(locale, 'syncSummary.removed', { count: inv.removedMissing }))
  }
  if (inv.enrichedMeta && inv.enrichedMeta > 0) {
    parts.push(translate(locale, 'syncSummary.enriched', { count: inv.enrichedMeta }))
  }
  if (inv.hashesBackfilled && inv.hashesBackfilled > 0) {
    parts.push(translate(locale, 'syncSummary.hashed', { count: inv.hashesBackfilled }))
  }
  if (inv.repairedPreviews && inv.repairedPreviews > 0) {
    parts.push(translate(locale, 'syncSummary.previews', { count: inv.repairedPreviews }))
  }
  if (inv.repairedRatings && inv.repairedRatings > 0) {
    parts.push(translate(locale, 'syncSummary.ratings', { count: inv.repairedRatings }))
  }
  if (inv.repairedSwarmHints && inv.repairedSwarmHints > 0) {
    parts.push(translate(locale, 'syncSummary.swarmHints', { count: inv.repairedSwarmHints }))
  }
  if (inv.suspiciousFileCount && inv.suspiciousFileCount > 0) {
    parts.push(translate(locale, 'syncSummary.suspicious', { count: inv.suspiciousFileCount }))
    const samples = (inv.suspiciousFiles ?? []).slice(0, 3).map((f) => {
      const disk = formatModelWeight(f.diskBytes)
      const exp = f.expectedBytes ? formatModelWeight(f.expectedBytes) : null
      return exp ? `${f.modelName} (${disk}/${exp})` : `${f.modelName} (${disk})`
    })
    if (samples.length) {
      parts.push(translate(locale, 'syncSummary.suspiciousSamples', { list: samples.join('; ') }))
    }
  }
  if (!parts.length) {
    return translate(locale, 'syncSummary.allOk', { count: checked })
  }
  return translate(locale, 'syncSummary.summary', {
    count: inv.items.length,
    parts: parts.join(', ')
  })
}
