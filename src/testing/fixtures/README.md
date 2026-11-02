Fixtures recorded from public endpoints on 2026-09-25, with unused fields removed:

- `curseforge-forever.json`: `https://www.curseforge.com/api/v1/mods/1708506/files?pageIndex=0&pageSize=50&sort=dateCreated&sortDescending=true`
- `cfwidget-auctionator.json`: `https://api.cfwidget.com/wow/addons/auctionator`
- `tukui-elvui.json` (2026-11-02, download token replaced): `https://api.tukui.org/v1/addon/elvui`

Discovery fixtures recorded on 2026-11-02, trimmed to the fields the parsers read:

- `ct-search-questie.json`: `https://api.curse.tools/v1/mods/search?gameId=1&classId=1&searchFilter=questie&gameVersionTypeId=67408`
- `ct-mod-questie.json`: `https://api.curse.tools/v1/mods/334372`
- `ct-description-questie.json`: `https://api.curse.tools/v1/mods/334372/description`
- `ct-categories.json`: `https://api.curse.tools/v1/categories?gameId=1&classId=1`
- `cf-changelog-questie.json`: `https://www.curseforge.com/api/v1/mods/334372/files/9406949/change-log`
- `cfwidget-questie.json`: `https://api.cfwidget.com/wow/addons/334372`
- `wowi-filelist.json` (five entries): `https://api.mmoui.com/v3/game/WOW/filelist.json`
- `wowi-filedetails.json`: `https://api.mmoui.com/v3/game/WOW/filedetails/3896.json`
- `wowi-categorylist.json`: `https://api.mmoui.com/v3/game/WOW/categorylist.json`
- `hub-search-questie.json`: `https://hub.wowup.io/addons/search/classic?query=questie&limit=20`
- `hub-featured.json`: `https://hub.wowup.io/addons/featured/classic?count=20`
- `tukui-addons.json` (download tokens replaced): `https://api.tukui.org/v1/addons`
- `github-questie-repo.json`: `https://api.github.com/repos/Questie/Questie`
- `github-questie-release.json`: `https://api.github.com/repos/Questie/Questie/releases/latest`

Tests inject fetch and build their ZIPs locally. These fixtures are never refreshed by tests.
