# vendor/lightcraft

RAW 카메라 JPEG 맞춤(`js/camera.js`)이 쓰는 LightCraft 자료. 파일은 손대지 않고 그대로 넣음.

| 파일 | 출처 | 라이선스 |
|---|---|---|
| `camera-profiles/*.json` | [LightCraft](https://github.com/storytold/lightcraft) `assets/camera-profiles/` (커밋 23e1812, 2026-10-22). 카메라마다 수백 장의 RAW와 카메라 JPEG로 맞춘 색 matrix + hue/sat/value 표. 기여자와 사진 수는 그 저장소 `assets/ATTRIBUTION.md` | MIT OR Apache-2.0 |
| `LICENSE-MIT`, `LICENSE-APACHE` | LightCraft 저장소 뿌리의 라이선스 원문 | — |

- **`js/camera.js`**: LightCraft `crates/engine/src/camera_preview.rs`, `crates/pipeline/src/tone.rs`, `crates/raw/src/profile.rs`, `crates/color/src/lib.rs`의 맞추기·적용 절차를 JavaScript로 옮긴 것 (같은 라이선스, 파일 머리말에 출처)
- **들어 있는 카메라**: ILCE-7M4(a7 IV), ILCE-7CR, ILCA-99M2, NIKON Z 6_2, NIKON Z 8, NIKON D5300, X-H2S, X-T4. 다른 카메라는 사진마다 그 사진의 JPEG로 matrix부터 맞춘다
