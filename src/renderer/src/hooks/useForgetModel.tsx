import { useEffect, useRef, useState } from 'react'
import type { ForgetSelection, ForgetResult } from '../../../shared/model-actions'
import { ConfirmModal } from '../components/ConfirmModal'
import { useT } from '../i18n/context'

type Target = ForgetSelection & { modelName: string; versionName?: string }
export function useOnModelForgotten(callback: (result: ForgetResult) => void): void {
  const current = useRef(callback)
  current.current = callback
  useEffect(() => window.api.onModelForgotten(result => current.current(result)), [])
}

export function useForgetModel(onForgotten?: (result: ForgetResult) => void) {
  const t = useT()
  const [target, setTarget] = useState<Target | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const run = async (wholeModel: boolean) => {
    if (!target || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = wholeModel || target.versionId == null
        ? await window.api.forgetModel(target.modelId, target.modelName)
        : await window.api.forgetVersion({ modelId: target.modelId, versionId: target.versionId })
      setTarget(null)
      onForgotten?.(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setBusy(false) }
  }
  const versionSelected = target?.versionId != null
  return {
    requestForget: (next: Target) => { setError(null); setTarget(next) },
    confirmation: target ? <ConfirmModal
      title={t('modelActions.forget')}
      message={t(versionSelected ? 'modelActions.confirmVersion' : 'modelActions.confirmModel', {
        name: target.modelName, version: target.versionName || String(target.versionId ?? '')
      })}
      detail={error ? <p role="alert">{error}</p> : busy ? <p>{t('common.loading')}</p> : undefined}
      confirmLabel={t(versionSelected ? 'modelActions.forgetVersion' : 'modelActions.forgetModel')}
      secondaryConfirmLabel={versionSelected && target.modelId > 0 ? t('modelActions.forgetModel') : undefined}
      onSecondaryConfirm={() => { void run(true) }}
      onConfirm={() => { void run(!versionSelected) }}
      onCancel={() => { if (!busy) setTarget(null) }}
      danger
    /> : null
  }
}
