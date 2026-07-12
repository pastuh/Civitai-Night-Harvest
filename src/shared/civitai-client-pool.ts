import { CivitaiClient } from './civitai-client'
import type { CivitaiDomain, CivitaiDomainSetting } from './types'
import { resolveSearchDomains } from './utils'

export class CivitaiClientPool {
  private com: CivitaiClient
  private red: CivitaiClient
  private setting: CivitaiDomainSetting

  constructor(setting: CivitaiDomainSetting, apiKey: string) {
    this.setting = setting
    this.com = new CivitaiClient({ domain: 'com', apiKey })
    this.red = new CivitaiClient({ domain: 'red', apiKey })
  }

  update(setting: CivitaiDomainSetting, apiKey: string): void {
    this.setting = setting
    this.com.setApiKey(apiKey)
    this.red.setApiKey(apiKey)
  }

  getSetting(): CivitaiDomainSetting {
    return this.setting
  }

  forDomain(domain: CivitaiDomain): CivitaiClient {
    return domain === 'red' ? this.red : this.com
  }

  /** Primary client for enums / legacy single-domain flows */
  primary(): CivitaiClient {
    return this.forDomain(this.primaryDomain())
  }

  primaryDomain(): CivitaiDomain {
    return this.setting === 'red' ? 'red' : 'com'
  }

  activeDomains(): CivitaiDomain[] {
    return resolveSearchDomains(this.setting)
  }
}
