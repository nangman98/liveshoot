# LiveShoot 계획

**목표: 촬영 현장 iPad에서 Lightroom처럼 쉬운 화면으로 Capture One급 결과(속도·색·디테일·연결 촬영)를 내는 웹 편집기.** LightCraft 기능 목록을 넘어서는 것이 기준임(2026-10-23 사용자 지시).

## 측정 기준

| 항목 | 기준 |
|---|---|
| 속도 | iPad에서 슬라이더 반영 33 ms 이하, 1:1 확대 상태에서 끌기가 부드러울 것, RAW 가져오기 2 s 이하, 2400 px 내보내기 2 s 이하 |
| 화질 | 16비트 이상 처리, 노출 +3 EV에서 밴딩 없음, 노이즈 줄이기는 노이즈 σ 50 % 이상 감소와 가장자리 대비 90 % 이상 유지 |
| 색 | 회색은 모든 컬러 프로필에서 회색으로 남음, 인물 프로필에서 피부 색상각 변화 3° 이하 |
| 연결 촬영 | 셔터에서 iPad 화면까지 3 s 이하 (a7 IV FTP, JPEG) |

## 단계 (판정 후 순서)

| 순서 | 단계 | 내용 |
|---|---|---|
| 1 | 색감 | 프로필 22개(Basic·Film·Cinematic·Snap·B&W)와 강도 0–200 %, 지금 사진으로 그린 썸네일, Auto(톤 8개), 흑백과 B&W Mix, 구간 커브 |
| 2 | 기반·HDR | RGBA16F 처리, RAW 16비트 선형 입력, 넓은 색역 작업 공간, Display P3 출력, HDR 화면 편집과 gain map 내보내기, RAW Camera Match |
| 3 | Detail | 1:1 확대, 가장자리 보존 노이즈 줄이기(밝기·색), 캡처 샤픈과 마스킹 |
| 4 | 연결 촬영 | 받기 앱이 a7 IV FTP·GR III Wi-Fi 사진을 웹 편집기로 바로 넘김 |
| 5 | Capture One식 색 도구 | Color Editor(색 범위), Skin Tone(균일도), Levels, Luma 커브 |
| 6 | 부분 보정 | 레이어, 브러시·선형·원형·밝기 범위 마스크 |
| 7 | 작업 흐름 | 별점·비교 보기, 스타일 겹치기, 골라 붙여넣기, 내보내기 묶음, XMP(Mac mini LightCraft로 보정 넘기기) |

단계마다 배포하고 iPad에서 확인받음. 자동 시험(현재 46개)을 단계마다 늘림.

## 진행

| 단계 | 상태 (2026-10-23) |
|---|---|
| 1 색감 | 프로필 22개·강도·썸네일, Auto, 흑백·B&W Mix, 구간 커브 완료. 시험 11/11. HDR은 2단계로 |
| 2 기반·HDR | 조사 끝, 시작 전. iPad에서 `hdr-test.html` 결과를 받은 뒤 HDR 방식을 정함. RAW Camera Match는 사용자 승인(2026-10-23) |

## 2단계 HDR 방식 (조사 뒤)

- **캔버스가 HDR을 그리면**: Lightroom처럼 HDR 화면에서 바로 편집함(WebGPU `rgba16float` + `toneMapping: extended`)
- **캔버스가 못 그리면**: 편집은 SDR 화면에서 하고, "HDR 보기"는 보정 결과로 만든 gain map JPEG을 `<img>`로 띄움(Safari 26이 HDR 사진을 HDR로 보여 줌)
- **내보내기는 어느 쪽이든**: SDR 기본 그림 + gain map을 ISO 21496-1과 Ultra HDR(XMP hdrgm) 메타데이터로 함께 씀
- **RAW**: 16비트 선형으로 해독해 1.0을 넘는 하이라이트를 HDR 쪽에 남김

## 판정 기록

- **첫 판정 (수정 후 통과)**: 16비트 렌더가 iPad Safari에서 되는지 미확인이라 조사 1순위. "Capture One 같은 색"은 기준 데이터가 없어 숫자로 잴 수 있는 것(회색 유지, 피부 색상각, 밴딩)만 기준으로 둠. 연결 촬영은 Capture One의 핵심이라 뒤에서 앞으로 당김
- **조사 뒤 수정**: 이전 "16비트 기반을 먼저" → 프로필이 슬라이더 값 묶음이라 16비트와 무관함을 확인해 색감 단계를 먼저 둠. 16비트가 꼭 필요한 HDR과 밴딩 방지는 2단계로 묶음

## 조사 요약 (2026-10-23)

| 주제 | 결과 | 출처 |
|---|---|---|
| iPad Safari 부동소수점 렌더 | half-float(RGBA16F) 지원, 32비트는 기기·판에 따라 다름. 실행 중 확인하고 대안을 둠 | [WebKit 217107](https://bugs.webkit.org/show_bug.cgi?id=217107), [web3dsurvey](https://web3dsurvey.com/webgl2/extensions/EXT_color_buffer_float) |
| WebGPU | Safari 26(iPadOS 26)에서 기본으로 켜짐 | [WebKit 발표 인용](https://discuss.privacyguides.net/t/news-from-wwdc25-webkit-in-safari-26-beta/28226.md) |
| HDR 캔버스 | Chrome은 WebGPU `toneMapping: extended`. Safari는 확인 못 함 | [Chrome](https://developer.chrome.com/blog/new-in-webgpu-129) |
| Lightroom HDR | Edit in HDR 모드, HDR 히스토그램, Visualize HDR | [Adobe](https://helpx.adobe.com/lightroom/mobile/adjust-light-and-color/edit-hdr-photos.html) |
| Lightroom Auto | 학습 모델이 Exposure·Contrast·Highlights·Shadows·Whites·Blacks·Vibrance·Saturation을 정함 | [Adobe](https://developer.adobe.com/firefly-services/docs/lightroom/guides/auto-tone) |
| Capture One 강점 | 연결 촬영 안정성, Color Editor, Skin Tone 균일도, 레이어 | [DIYPhotography](https://www.diyphotography.net/lightroom-vs-capture-one/), [Format](https://www.format.com/magazine/resources/photography/capture-one-vs-lightroom/) |
| LightCraft 프로필 | 슬라이더 아래 깔리는 값 묶음 × 강도(0–200 %), 22개 | [profiles.rs](https://github.com/storytold/lightcraft/blob/main/crates/pipeline/src/profiles.rs) |
| HDR 캔버스 (추가 조사) | WebGL HDR은 표준 전(Khronos 제안). WebGPU `toneMapping: extended`는 Chrome에서 됨, Safari 동작은 미확인 | [Khronos PR 3668](https://github.com/KhronosGroup/WebGL/pull/3668), [WebGPU HDR](https://github.com/ccameron-chromium/webgpu-hdr/blob/main/EXPLAINER.md) |
| HDR 사진 표시 | Safari 26은 gain map JPEG·AVIF·HEIF HDR 사진을 HDR로 보여 줌. iPadOS 18부터 ISO 21496-1 | [Greg Benz](https://gregbenzphotography.com/photography-reviews/apple-safari-now-supports-hdr-photography/), [Greg Benz](https://gregbenzphotography.com/hdr-photos/apple-macos-ios-hdr-iso-gain-map-21496-1/) |
| LightCraft RAW 색감 | 카메라 JPEG 색감에 맞춰 시작 | [raw-photos-look-dull.md](https://github.com/storytold/lightcraft/blob/main/docs/user/troubleshooting/raw-photos-look-dull.md) |
