# Server assets

Files the server reads at run time, which `scripts/build-server.mjs` copies into `dist/server/assets/`
next to the bundled server.

- `fonts/Figtree-Regular.ttf`, `fonts/Figtree-SemiBold.ttf`: the static Figtree fonts from
  https://github.com/erikdkennedy/figtree (`fonts/ttf`), licensed under the SIL Open Font License 1.1
  (`fonts/OFL.txt`). The review card (`src/lib/reviewCard.ts`) draws its words with them.
- `licenses/resvg-wasm-LICENSE.txt`: the Mozilla Public License 2.0, under which
  `@resvg/resvg-wasm` 2.6.2 (https://github.com/yisibl/resvg-js) is licensed. Its WebAssembly file is
  copied next to it as `dist/server/assets/resvg.wasm`, unchanged.
