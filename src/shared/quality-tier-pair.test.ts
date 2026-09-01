import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildQualityTierPairUnits,
  detectQualityTier,
  detectQualityTierFromMetadataTitle,
  detectTierForScannable,
  qualityPairKey,
  tierScannableFromBrowse,
  tierScannableFromInventory
} from './quality-tier-pair'

describe('quality-tier-pair', () => {
  it('detects high/low from filename stems', () => {
    assert.equal(detectQualityTier('Wan22-I2V-A14B_HIGH'), 'high')
    assert.equal(detectQualityTier('Wan22-I2V-A14B_LOW'), 'low')
    assert.equal(detectQualityTier('foo_high_noise_bar'), 'high')
    assert.equal(detectQualityTier('foo_low_noise_bar'), 'low')
  })

  it('detects tier from title prefixes', () => {
    assert.equal(detectQualityTier('HIGH Wan Video 2.2'), 'high')
    assert.equal(detectQualityTier('LOW Wan Video 2.2'), 'low')
  })

  it('detects high/low noise in version titles', () => {
    assert.equal(detectQualityTierFromMetadataTitle('High noise - v1.0'), 'high')
    assert.equal(detectQualityTierFromMetadataTitle('Low noise - v1.0'), 'low')
  })

  it('pairs K3NK model despite different epoch in filenames', () => {
    const high = {
      id: 2237540,
      versionId: 2518841,
      versionName: 'High noise - v1.0',
      primaryFileName: 'wan22-69deepthroat-16epoc-high-k3nk.safetensors',
      baseModel: 'Wan Video 2.2 I2V-A14B'
    }
    const low = {
      id: 2237540,
      versionId: 2520421,
      versionName: 'Low noise - v1.0',
      primaryFileName: 'wan22-69deepthroat-24epoc-low-k3nk.safetensors',
      baseModel: 'Wan Video 2.2 I2V-A14B'
    }
    const highScan = tierScannableFromBrowse(high)
    const lowScan = tierScannableFromBrowse(low)
    assert.equal(qualityPairKey(highScan), qualityPairKey(lowScan))
    const units = buildQualityTierPairUnits([high, low], tierScannableFromBrowse)
    assert.equal(units.length, 1)
    assert.equal(units[0]?.kind, 'pair')
  })

  it('pairs library rows from version title even when slug epochs differ', () => {
    const high = {
      modelId: 2237540,
      versionId: 2518841,
      versionName: 'High noise - v1.0',
      slug: 'wan22-69deepthroat-16epoc-high-k3nk',
      modelPath: 'D:/loras/wan22-69deepthroat-16epoc-high-k3nk.safetensors',
      baseModel: 'Wan Video 2.2 I2V-A14B'
    }
    const low = {
      modelId: 2237540,
      versionId: 2520421,
      versionName: 'Low noise - v1.0',
      slug: 'wan22-69deepthroat-24epoc-low-k3nk',
      modelPath: 'D:/loras/wan22-69deepthroat-24epoc-low-k3nk.safetensors',
      baseModel: 'Wan Video 2.2 I2V-A14B'
    }
    assert.equal(detectTierForScannable(tierScannableFromInventory(high as any)), 'high')
    assert.equal(detectTierForScannable(tierScannableFromInventory(low as any)), 'low')
    const units = buildQualityTierPairUnits(
      [high, low],
      tierScannableFromInventory as (v: typeof high) => ReturnType<typeof tierScannableFromInventory>
    )
    assert.equal(units.length, 1)
    assert.equal(units[0]?.kind, 'pair')
  })

  it('pairs version names that differ only by HIGH/LOW suffix', () => {
    const items = [
      {
        id: 1928743,
        versionId: 2183000,
        versionName: 'v0.1 HIGH',
        baseModel: 'Wan Video 2.2 I2V-A14B'
      },
      {
        id: 1928743,
        versionId: 2182983,
        versionName: 'v0.1 LOW',
        baseModel: 'Wan Video 2.2 I2V-A14B'
      }
    ]
    const units = buildQualityTierPairUnits(items, tierScannableFromBrowse)
    assert.equal(units.length, 1)
    assert.equal(units[0]?.kind, 'pair')
  })

  it('pairs identical version names with different file tiers', () => {
    const items = [
      {
        id: 1831957,
        versionId: 2782203,
        versionName: 'Wan Video 2.2 I2V-A14B',
        primaryFileName: 'wan22_i2v_a14b_high.safetensors',
        baseModel: 'Wan Video 2.2'
      },
      {
        id: 1831957,
        versionId: 2782186,
        versionName: 'Wan Video 2.2 I2V-A14B',
        primaryFileName: 'wan22_i2v_a14b_low.safetensors',
        baseModel: 'Wan Video 2.2'
      }
    ]
    const units = buildQualityTierPairUnits(items, tierScannableFromBrowse)
    assert.equal(units.length, 1)
    assert.equal(units[0]?.kind, 'pair')
    if (units[0]?.kind === 'pair') {
      assert.equal(units[0].high.versionId, 2782203)
      assert.equal(units[0].low.versionId, 2782186)
    }
  })

  it('does not treat conflicting sources as ambiguous when using tier priority', () => {
    const tier = detectTierForScannable({
      modelId: 1,
      versionId: 1,
      versionName: 'High noise - v1.0',
      primaryFileName: 'wan22-69deepthroat-16epoc-high-k3nk.safetensors',
      baseModel: 'Wan'
    })
    assert.equal(tier, 'high')
  })

  it('pairs High Noise / Low Noise version titles (model 2413983)', () => {
    const items = [
      {
        id: 2413983,
        versionId: 2714223,
        versionName: 'High Noise - v1.0',
        primaryFileName: 'model-high-i2v.safetensors',
        baseModel: 'Wan Video 2.2 I2V-A14B'
      },
      {
        id: 2413983,
        versionId: 2714097,
        versionName: 'Low Noise - v1.0',
        primaryFileName: 'model-low-i2v.safetensors',
        baseModel: 'Wan Video 2.2 I2V-A14B'
      }
    ]
    const units = buildQualityTierPairUnits(items, tierScannableFromBrowse)
    assert.equal(units.length, 1)
    assert.equal(units[0]?.kind, 'pair')
  })

  it('pairs v1.0 - High / v1.0 - Low suffix titles (model 2121078)', () => {
    const items = [
      {
        id: 2121078,
        versionId: 2399398,
        versionName: 'v1.0 - High',
        primaryFileName: 'Wan22_BiggestCock_high_noise_V1.safetensors',
        baseModel: 'Wan Video 2.2 I2V-A14B'
      },
      {
        id: 2121078,
        versionId: 2399388,
        versionName: 'v1.0 - Low',
        primaryFileName: 'Wan22_BiggestCock_low_noise_V1.safetensors',
        baseModel: 'Wan Video 2.2 I2V-A14B'
      }
    ]
    const units = buildQualityTierPairUnits(items, tierScannableFromBrowse)
    assert.equal(units.length, 1)
    assert.equal(units[0]?.kind, 'pair')
  })

  it('pairs Highit/Lowit typo version names from library slugs (model 2426014)', () => {
    const items = [
      {
        modelId: 2426014,
        versionId: 2727687,
        versionName: 'Lowit_WAN2_2_I2V',
        slug: 'lowit_wan2_2_i2v',
        baseModel: 'Wan Video 2.2 I2V-A14B'
      },
      {
        modelId: 2426014,
        versionId: 2727638,
        versionName: 'Highit_WAN2_2_I2V',
        slug: 'highit_wan2_2_i2v',
        baseModel: 'Wan Video 2.2 I2V-A14B'
      }
    ]
    const units = buildQualityTierPairUnits(
      items,
      tierScannableFromInventory as (v: (typeof items)[number]) => ReturnType<typeof tierScannableFromInventory>
    )
    assert.equal(units.length, 1)
    assert.equal(units[0]?.kind, 'pair')
  })

  it('pairs K3NK library rows when slug epochs differ (model 2237540)', () => {
    const items = [
      {
        modelId: 2237540,
        versionId: 2518841,
        versionName: '',
        slug: 'wan22-69deepthroat-16epoc-high-k3nk',
        modelPath: 'D:/loras/wan22-69deepthroat-16epoc-high-k3nk.safetensors',
        baseModel: 'Wan Video 2.2 I2V-A14B'
      },
      {
        modelId: 2237540,
        versionId: 2520421,
        versionName: '',
        slug: 'wan22-69deepthroat-24epoc-low-k3nk',
        modelPath: 'D:/loras/wan22-69deepthroat-24epoc-low-k3nk.safetensors',
        baseModel: 'Wan Video 2.2 I2V-A14B'
      }
    ]
    const units = buildQualityTierPairUnits(
      items,
      tierScannableFromInventory as (v: (typeof items)[number]) => ReturnType<typeof tierScannableFromInventory>
    )
    assert.equal(units.length, 1)
    assert.equal(units[0]?.kind, 'pair')
  })

  it('pairs K3NK rows with shared generic version title and different epochs (model 2237540)', () => {
    const items = [
      {
        modelId: 2237540,
        versionId: 2518841,
        versionName: 'v1.0',
        slug: 'wan22-69deepthroat-16epoc-high-k3nk',
        baseModel: 'Wan Video 2.2 I2V-A14B'
      },
      {
        modelId: 2237540,
        versionId: 2520421,
        versionName: 'v1.0',
        slug: 'wan22-69deepthroat-24epoc-low-k3nk',
        baseModel: 'Wan Video 2.2 I2V-A14B'
      }
    ]
    const units = buildQualityTierPairUnits(
      items,
      tierScannableFromInventory as (v: (typeof items)[number]) => ReturnType<typeof tierScannableFromInventory>
    )
    assert.equal(units.length, 1)
    assert.equal(units[0]?.kind, 'pair')
  })

  it('pairs version titles that are only HIGH / LOW', () => {
    const items = [
      { modelId: 2141802, versionId: 2838538, versionName: 'HIGH', baseModel: 'Wan Video 2.2 I2V-A14B' },
      { modelId: 2141802, versionId: 2838545, versionName: 'LOW', baseModel: 'Wan Video 2.2 I2V-A14B' }
    ]
    const units = buildQualityTierPairUnits(
      items,
      tierScannableFromInventory as (v: (typeof items)[number]) => ReturnType<typeof tierScannableFromInventory>
    )
    assert.equal(units.length, 1)
    assert.equal(units[0]?.kind, 'pair')
  })

  it('pairs parenthesized high/low suffix titles', () => {
    const items = [
      { id: 2254822, versionId: 2836941, versionName: 'v1.0 (High)', baseModel: 'Wan Video 2.2 I2V-A14B' },
      { id: 2254822, versionId: 2836955, versionName: 'v1.0 (Low)', baseModel: 'Wan Video 2.2 I2V-A14B' }
    ]
    const units = buildQualityTierPairUnits(items, tierScannableFromBrowse)
    assert.equal(units.length, 1)
    assert.equal(units[0]?.kind, 'pair')
  })

  it('pairs wan22 - high / wan22 - low browse rows (model 2002532)', () => {
    const items = [
      {
        id: 2002532,
        versionId: 2266644,
        versionName: 'wan22 - high',
        primaryFileName: 'anal_insertion_HIGH_V01.safetensors',
        baseModel: 'Wan Video 2.2 I2V-A14B'
      },
      {
        id: 2002532,
        versionId: 2266652,
        versionName: 'wan22 - low',
        primaryFileName: 'anal_insertion_LOW_V01.safetensors',
        baseModel: 'Wan Video 2.2 I2V-A14B'
      }
    ]
    const units = buildQualityTierPairUnits(items, tierScannableFromBrowse)
    assert.equal(units.length, 1)
    assert.equal(units[0]?.kind, 'pair')
  })

  it('pairs highnoise1.0 / low noise 1.0 titles (model 2471910)', () => {
    const items = [
      {
        id: 2471910,
        versionId: 2779234,
        versionName: 'highnoise1.0',
        primaryFileName: 'high noise.safetensors',
        baseModel: 'Wan Video 2.2 I2V-A14B'
      },
      {
        id: 2471910,
        versionId: 2779292,
        versionName: 'low noise 1.0',
        primaryFileName: 'the low noise.safetensors',
        baseModel: 'Wan Video 2.2 I2V-A14B'
      }
    ]
    const units = buildQualityTierPairUnits(items, tierScannableFromBrowse)
    assert.equal(units.length, 1)
    assert.equal(units[0]?.kind, 'pair')
  })

  it('does not pair different base models on the same model id', () => {
    const items = [
      {
        modelId: 2002532,
        versionId: 1,
        versionName: 'High noise - v1.0',
        baseModel: 'LTXV 2.3'
      },
      {
        modelId: 2002532,
        versionId: 2,
        versionName: 'Low noise - v1.0',
        baseModel: 'Wan Video 2.2 I2V-A14B'
      }
    ]
    const units = buildQualityTierPairUnits(
      items,
      tierScannableFromInventory as (v: (typeof items)[number]) => ReturnType<typeof tierScannableFromInventory>
    )
    assert.equal(units.length, 2)
    assert.equal(units[0]?.kind, 'single')
    assert.equal(units[1]?.kind, 'single')
  })

  it('pairs high-noise / low-noise tier-only titles via filename (model 2492589)', () => {
    const items = [
      {
        id: 2492589,
        versionId: 2803010,
        versionName: 'high-noise',
        primaryFileName: 'high_提起裙子.safetensors',
        baseModel: 'Wan Video 2.2 I2V-A14B'
      },
      {
        id: 2492589,
        versionId: 2802107,
        versionName: 'low-noise',
        primaryFileName: 'low_提起裙子.safetensors',
        baseModel: 'Wan Video 2.2 I2V-A14B'
      }
    ]
    const units = buildQualityTierPairUnits(items, tierScannableFromBrowse)
    assert.equal(units.length, 1)
    assert.equal(units[0]?.kind, 'pair')
  })

  it('pairs nolightning SVI cf fp8 H/L with hyphen slug suffixes (model 2053259)', () => {
    const items = [
      {
        modelId: 2053259,
        versionId: 2609141,
        versionName: 'nolightning SVI cf fp8 H',
        slug: 'nolightning-svi-cf-fp8-h',
        baseModel: 'Wan Video 2.2 I2V-A14B'
      },
      {
        modelId: 2053259,
        versionId: 2609148,
        versionName: 'nolightning SVI cf fp8 L',
        slug: 'nolightning-svi-cf-fp8-l',
        baseModel: 'Wan Video 2.2 I2V-A14B'
      }
    ]
    const units = buildQualityTierPairUnits(
      items,
      tierScannableFromInventory as (v: (typeof items)[number]) => ReturnType<typeof tierScannableFromInventory>
    )
    assert.equal(units.length, 1)
    assert.equal(units[0]?.kind, 'pair')
  })
})
