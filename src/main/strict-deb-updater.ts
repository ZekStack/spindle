import updaterPackage from 'electron-updater'
import { chooseDebAsset } from './deb-feed'

const { DebUpdater } = updaterPackage

/**
 * The upstream Linux updater accepts alternative artifacts if a .deb is absent.
 * Filter the update metadata *before* the download task is constructed. This
 * also applies to RC releases: it does not rely on channel names, which
 * GitHubProvider changes automatically for prereleases.
 */
export class SpindleDebUpdater extends DebUpdater {
  protected override async getUpdateInfoAndProvider() {
    const resolved = await super.getUpdateInfoAndProvider()
    const selected = chooseDebAsset(resolved.info)
    return {
      ...resolved,
      info: {
        ...resolved.info,
        files: [selected],
        path: selected.url,
        sha512: selected.sha512,
      },
    }
  }
}
