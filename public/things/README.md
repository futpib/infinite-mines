# Illustrated Thing assets

This directory contains the `svg/` catalog from Google Noto Emoji at commit
`8998f5dd683424a73e2314a8c1f1e359c19e8742`, excluding every pregnancy emoji
and every emoji that depicts two or more people. The multi-person exclusion
follows the Unicode 17 family, couple, kiss, holding-hands, bunny-pair,
wrestling/fighting, hugging, and group categories; the generator rejects any
excluded asset if it is reintroduced.

Source: <https://github.com/googlefonts/noto-emoji>

The assets are Apache-2.0 licensed; see `LICENSE`. Run
`npm run generate:thing-footprints` after changing the asset set. That generator
rebuilds the ordered catalog and every size, topology, and orientation alpha mask
used to keep visible artwork on clue-zero cells.
