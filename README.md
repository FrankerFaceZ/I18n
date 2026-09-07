# The FrankerFaceZ Localization Project

## Welcome!

Want to help translate FrankerFaceZ into your language? This isn't quite the
right place. We manage translations using [Weblate](https://weblate.frankerfacez.com/)
while this repository acts as a sort of back end storage and update system.

Please [find us on Discord](https://discord.gg/UrAkGhT) and ask about
translation to get started.


## I've Found a Typo

Please report localization issues on our [Discord](https://discord.gg/UrAkGhT).
Our community translators are all there and can be reached about fixing any
issues that way.


## What Is This Place?

This repository contains all localizable strings for the FrankerFaceZ project,
as well as all translations. This repository is intended for use with Weblate.

All updates to this repository are synced with Weblate, and when translations
are approved on Weblate, they're sent back here to this repository. When that
happens, CI actions are used to deploy the updated strings to our CDN.


## How Strings Get Here

Source strings are extracted automatically. A push to the
[FrankerFaceZ](https://github.com/FrankerFaceZ/FrankerFaceZ),
[Add-Ons](https://github.com/FrankerFaceZ/Add-Ons) or
[Link-Service](https://github.com/FrankerFaceZ/Link-Service) repository
dispatches the `Extract Strings` workflow in this repository, which:

1. checks out the source repository and runs `scripts/extract.js`, a static
   extractor that understands `t()` / `tList()` calls, `<t-list>`, the settings
   tree, and the other metadata patterns FFZ uses;
2. runs `scripts/merge.mjs` to add new keys to `strings.json` and the matching
   `strings/<component>/en-US.po`, update changed English phrases, and move keys
   (with their translations) between components when needed;
3. commits to `main`, triggers `Build and Deploy`, and posts a summary to
   Discord via `scripts/notify-discord.mjs`.

Keys the extractor no longer finds are **never deleted automatically**. They are
listed as *orphaned* in the workflow log, the job summary, and the Discord
message so they can be reviewed and removed by hand.

Components map to the chunks the client loads: `client` and `settings` for
core, `embed` for the link service's rich-content tokens, and `addon.<id>` for
each add-on, where `<id>` is the add-on's source directory name.

To run it locally:

```sh
pnpm install
node scripts/extract.js --root ../FrankerFaceZ --out extract
node scripts/merge.mjs extract/meta.json --report extract/report.json --dry-run
```


