import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { detectVideoModalities, embeddedTokenMatch } from './video-modality'

describe('embeddedTokenMatch', () => {
  it('matches standalone tokens', () => {
    assert.equal(embeddedTokenMatch('wan_i2v_high', 'i2v'), true)
    assert.equal(embeddedTokenMatch('(T2V)', 't2v'), true)
  })

  it('matches camelCase suffix', () => {
    assert.equal(embeddedTokenMatch('simpleI2V', 'i2v'), true)
    assert.equal(embeddedTokenMatch('packT2V', 't2v'), true)
  })

  it('rejects mid-word burying', () => {
    assert.equal(embeddedTokenMatch('mini2video', 'i2v'), false)
  })
})

describe('detectVideoModalities', () => {
  it('detects FL2V from name', () => {
    const badges = detectVideoModalities({ versionName: 'Minimax H3 FL2VA turbo' })
    assert.deepEqual(
      badges.map((b) => b.label),
      ['FL2V']
    )
    assert.equal(badges[0]?.source, 'name')
  })

  it('detects I2V and T2V from slash form', () => {
    const badges = detectVideoModalities({ modelName: 'WAN 2.2 I2V/T2V LoRA' })
    assert.deepEqual(
      badges.map((b) => b.label),
      ['T2V', 'I2V']
    )
  })

  it('detects T2V and I2V from underscore and ampersand forms', () => {
    assert.deepEqual(
      detectVideoModalities({ versionName: 'T2V_I2V pack' }).map((b) => b.label),
      ['T2V', 'I2V']
    )
    assert.deepEqual(
      detectVideoModalities({ versionName: 'T2V&I2V' }).map((b) => b.label),
      ['T2V', 'I2V']
    )
  })

  it('detects camelCase I2V', () => {
    const badges = detectVideoModalities({ versionName: 'simpleI2V style' })
    assert.deepEqual(
      badges.map((b) => b.label),
      ['I2V']
    )
  })

  it('detects R2V from ref2va', () => {
    const badges = detectVideoModalities({ versionName: 'ref2va style' })
    assert.deepEqual(
      badges.map((b) => b.label),
      ['R2V']
    )
  })

  it('uses description tier when names are clean', () => {
    const badges = detectVideoModalities({
      modelName: 'Cool LoRA',
      versionName: 'v1',
      versionDescription: 'Works great for text-to-video workflows'
    })
    assert.deepEqual(
      badges.map((b) => ({ label: b.label, source: b.source })),
      [{ label: 'T2V', source: 'description' }]
    )
  })

  it('prefers name tier over description', () => {
    const badges = detectVideoModalities({
      versionName: 'I2V edition',
      versionDescription: 'text-to-video only'
    })
    assert.equal(badges.find((b) => b.id === 'i2v')?.source, 'name')
    assert.equal(badges.find((b) => b.id === 't2v')?.source, 'description')
  })

  it('returns empty when nothing matches', () => {
    assert.deepEqual(detectVideoModalities({ versionName: 'mini2video pack' }), [])
  })
})
