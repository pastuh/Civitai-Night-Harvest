import { useEffect, useMemo, useState } from 'react'

import type { InventoryRecord, TagFolderRule } from '../../../shared/types'

import {

  parseTagRuleNames,

  ruleCoversTag,

  countInventoryInFolder

} from '../../../shared/tag-routing'

import { TagAutocompleteInput } from './TagAutocompleteInput'



interface Props {

  rules: TagFolderRule[]

  tagSuggestions?: string[]

  inventory?: InventoryRecord[]

  onSave: (rules: TagFolderRule[]) => Promise<void>

  onFilterLibrary?: (tag: string) => void

}



function newId(): string {

  return crypto.randomUUID()

}



type SaveState = 'idle' | 'saving' | 'saved' | 'error'



const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('')



export function TagsTab({ rules, tagSuggestions = [], inventory = [], onSave, onFilterLibrary }: Props) {

  const [draft, setDraft] = useState<TagFolderRule[]>(rules)

  const [saveState, setSaveState] = useState<SaveState>('idle')

  const [saveError, setSaveError] = useState<string | null>(null)

  const [librarySearch, setLibrarySearch] = useState('')

  const [letterFilter, setLetterFilter] = useState<string | null>(null)



  useEffect(() => {

    setDraft(rules)

    setSaveState('idle')

    setSaveError(null)

  }, [rules])



  useEffect(() => {

    if (saveState !== 'saved') return

    const t = window.setTimeout(() => setSaveState('idle'), 2500)

    return () => window.clearTimeout(t)

  }, [saveState])



  const configuredTags = useMemo(() => {

    const set = new Set<string>()

    for (const rule of draft) {

      for (const name of parseTagRuleNames(rule.tagName)) {

        set.add(name.toLowerCase())

      }

    }

    return set

  }, [draft])



  const unusedSuggestions = useMemo(

    () => tagSuggestions.filter((t) => !configuredTags.has(t.toLowerCase())),

    [tagSuggestions, configuredTags]

  )



  const availableLetters = useMemo(() => {

    const set = new Set<string>()

    for (const t of unusedSuggestions) {

      const c = t[0]?.toLowerCase()

      if (c && /[a-z]/.test(c)) set.add(c)

    }

    return set

  }, [unusedSuggestions])



  const libraryTags = useMemo(() => {

    const q = librarySearch.trim().toLowerCase()

    return unusedSuggestions

      .filter((t) => !letterFilter || t.toLowerCase().startsWith(letterFilter))

      .filter((t) => !q || t.toLowerCase().includes(q))

      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))

  }, [unusedSuggestions, librarySearch, letterFilter])

  const countInventoryTag = (tag: string) =>
    inventory.filter((r) =>
      (r.civitaiTags ?? []).some((t) => t.toLowerCase() === tag.toLowerCase())
    ).length



  const add = () => {

    setDraft([...draft, { id: newId(), tagName: '', folderPath: '' }])

  }



  const update = (id: string, patch: Partial<TagFolderRule>) => {

    setDraft(draft.map((r) => (r.id === id ? { ...r, ...patch } : r)))

    if (saveState === 'saved') setSaveState('idle')

  }



  const remove = (id: string) => {

    setDraft(draft.filter((r) => r.id !== id))

    if (saveState === 'saved') setSaveState('idle')

  }



  const pickFolder = async (id: string) => {

    const path = await window.api.pickFolder()

    if (path) update(id, { folderPath: path })

  }



  const addSuggestedTag = (tag: string) => {

    const empty = draft.find((r) => !r.tagName.trim())

    if (empty) {

      update(empty.id, { tagName: tag })

      return

    }

    const existing = draft.find((r) => ruleCoversTag(r, tag))

    if (existing) return

    setDraft([...draft, { id: newId(), tagName: tag, folderPath: '' }])

    if (saveState === 'saved') setSaveState('idle')

  }



  const save = async () => {

    const cleaned = draft

      .filter((r) => r.tagName.trim() && r.folderPath.trim())

      .map((r) => ({

        ...r,

        tagName: parseTagRuleNames(r.tagName).join(', '),

        folderPath: r.folderPath.trim()

      }))

    setSaveState('saving')

    setSaveError(null)

    try {

      await onSave(cleaned)

      setDraft(cleaned)

      setSaveState('saved')

    } catch (err) {

      setSaveState('error')

      setSaveError(err instanceof Error ? err.message : String(err))

    }

  }



  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(rules), [draft, rules])



  return (

    <div className="panel tags-tab">

      <div className="tags-tab-head">

        <h2>Tag → Folder routing</h2>
        <p className="muted">
          Maps Civitai tags to disk folders after download. To <strong>block or hide</strong> tags from
          auto-download, use <strong>Browse</strong> (blocked tags bar) or <strong>Settings → Blocked tags</strong>.
        </p>

        <span

          className={`tags-save-status ${saveState} ${dirty && saveState === 'idle' ? 'unsaved' : ''}`}

        >

          {saveState === 'saving' && 'Saving…'}

          {saveState === 'saved' && '✓ Saved'}

          {saveState === 'error' && 'Save failed'}

          {saveState === 'idle' && dirty && 'Unsaved changes'}

          {saveState === 'idle' && !dirty && 'Up to date'}

        </span>

      </div>

      <p className="muted tags-tab-hint">

        Map tag names to folders (comma-separated aliases, e.g. <code>tool, tools</code>). Start

        typing in a tag field for suggestions from your library.

      </p>



      {unusedSuggestions.length > 0 && (

        <div className="tag-library-browser">

          <div className="tag-library-toolbar">

            <input

              className="tag-library-search"

              value={librarySearch}

              onChange={(e) => setLibrarySearch(e.target.value)}

              placeholder="Search tags from library…"

            />

            <span className="muted tag-library-count">

              {libraryTags.length} of {unusedSuggestions.length}

            </span>

          </div>

          <div className="tag-library-letters" role="toolbar" aria-label="Filter by letter">

            <button

              type="button"

              className={`tag-library-letter ${letterFilter === null ? 'active' : ''}`}

              onClick={() => setLetterFilter(null)}

            >

              All

            </button>

            {LETTERS.map((letter) => (

              <button

                key={letter}

                type="button"

                className={`tag-library-letter ${letterFilter === letter ? 'active' : ''}`}

                disabled={!availableLetters.has(letter)}

                onClick={() => setLetterFilter(letterFilter === letter ? null : letter)}

              >

                {letter.toUpperCase()}

              </button>

            ))}

          </div>

          <ul className="tag-library-list">

            {libraryTags.map((tag) => (

              <li key={tag}>

                <div className="tag-library-item-row">

                  <button type="button" className="tag-library-item" onClick={() => addSuggestedTag(tag)}>

                    {tag}

                    {inventory.length > 0 && (

                      <span className="muted tag-library-item-count">{countInventoryTag(tag)}</span>

                    )}

                  </button>

                  {onFilterLibrary && inventory.length > 0 && countInventoryTag(tag) > 0 && (

                    <button

                      type="button"

                      className="tag-library-filter-btn"

                      title="Show models with this tag in Library"

                      onClick={() => onFilterLibrary(tag)}

                    >

                      →

                    </button>

                  )}

                </div>

              </li>

            ))}

            {!libraryTags.length && (

              <li className="muted tag-library-empty">

                {librarySearch || letterFilter ? 'No matching tags' : 'All known tags configured'}

              </li>

            )}

          </ul>

        </div>

      )}



      <div className="card-list tags-rule-list">

        {draft.map((rule) => {

          const parsed = parseTagRuleNames(rule.tagName)

          return (

            <div key={rule.id} className="card tags-rule-card">

              <div className="row tags-rule-row">

                <div className="field tags-rule-names" style={{ margin: 0 }}>

                  <label>Tag names (comma-separated)</label>

                  <TagAutocompleteInput

                    value={rule.tagName}

                    onChange={(tagName) => update(rule.id, { tagName })}

                    suggestions={tagSuggestions}

                    placeholder="tool, tools, utility"

                  />

                  {parsed.length > 1 && (

                    <div className="tags-rule-parsed muted">

                      Matches: {parsed.join(' · ')}

                    </div>

                  )}

                </div>

                <div className="field tags-rule-folder" style={{ margin: 0, flex: 2 }}>

                  <label>

                    Folder path

                    {inventory.length > 0 && (

                      <span className="tags-rule-folder-count muted">

                        {' '}

                        · {countInventoryInFolder(rule, inventory)} in library

                      </span>

                    )}

                  </label>

                  <div className="row">

                    <input

                      value={rule.folderPath}

                      onChange={(e) => update(rule.id, { folderPath: e.target.value })}

                    />

                    <button

                      type="button"

                      onClick={() => void pickFolder(rule.id)}

                      style={{ flex: 'none' }}

                    >

                      Browse

                    </button>

                  </div>

                </div>

                <button

                  type="button"

                  onClick={() => remove(rule.id)}

                  style={{ flex: 'none', alignSelf: 'end' }}

                >

                  Remove

                </button>

              </div>

            </div>

          )

        })}

      </div>



      {saveError && <p className="tags-save-error">{saveError}</p>}



      <div className="row tags-tab-actions">

        <button type="button" onClick={add}>

          Add tag rule

        </button>

        <button

          type="button"

          className="primary"

          disabled={saveState === 'saving'}

          onClick={() => void save()}

        >

          {saveState === 'saving' ? 'Saving…' : 'Save tag rules'}

        </button>

      </div>

    </div>

  )

}

