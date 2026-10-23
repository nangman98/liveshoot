# vendor/libraw

웹 편집기가 RAW(ARW·CR3·RAF·DNG 등)를 읽을 때 쓰는 해독기. 손대지 않고 그대로 넣음.

| 파일 | 출처 | 라이선스 |
|---|---|---|
| `index.js`, `worker.js`, `libraw.js`, `libraw.wasm` | [libraw-wasm](https://github.com/ybouane/LibRaw-Wasm) 1.6.0의 `dist/` (npm `libraw-wasm@1.6.0`), source map 주석만 뺌 | 감싼 코드 ISC |
| `libraw.wasm` 안의 LibRaw | [LibRaw](https://www.libraw.org/) | LGPL-2.1 또는 CDDL-1.0 ([LibRaw 라이선스](https://github.com/LibRaw/LibRaw/blob/master/COPYRIGHT)) |

- **카메라 목록**: `libraw.wasm` 안에 ILCE-7M4(a7 IV), GR III, X-H2S 등이 들어 있음(`strings libraw.wasm`으로 확인, 2026-10-23)
- **다시 만들기**: 위 저장소의 `compileLibraw.sh`(Emscripten 5.0.7)로 같은 파일을 만들 수 있음
