# LiveShoot: iPad 실시간 사진 뷰어

**카메라 공식 앱이 iPad 사진 보관함에 넣은 JPG를 들어오는 즉시 크게 띄우는 iPad 앱(1판, Swift Playgrounds 프로젝트).** 2026-10-23 macOS SDK로 문법 검사만 통과함(`swiftc -typecheck`, 오류 0). iPad에서 아직 실행해 보지 않음.

## 파일

| 파일 | 내용 |
|---|---|
| `LiveShoot.swiftpm.zip` | iPad로 옮길 앱 프로젝트 |
| `LiveShoot.swiftpm/` | 같은 프로젝트의 원본 (Swift 4개 파일, 349줄) |

## 흐름

| 단계 | 하는 일 |
|---|---|
| 카메라 → iPad | 소니는 Creators' App, 리코 GR III는 GR WORLD로 iPad에 사진을 보냄 |
| iPad 사진 보관함 | 카메라 앱이 받은 사진을 보관함에 넣음 |
| LiveShoot | 보관함에 새 사진이 들어오면 바로 맨 앞에 띄움 |
| 나중 보정 | Mac mini에서 `라이트크래프트_일괄보정/`의 `lc_batch.py`로 원본을 보정 |

- **들어온 순서로 정렬**: 촬영 시각이 아니라 보관함에 들어온 순서를 써서 두 카메라의 시계가 달라도 섞이지 않음
- **원본 불변**: 느낌 버튼(원본, 밝게, 따뜻하게, 선명하게)은 화면에서만 바뀌고 파일은 그대로임
- **하트**: 사진 보관함의 즐겨찾기로 표시됨. 사진을 두 번 눌러도 됨

## iPad에 설치

1. App Store에서 Swift Playgrounds를 설치함
2. 파일 앱 → Google Drive → `project/AI도구_사용법/아이패드_라이브뷰어/LiveShoot.swiftpm.zip`을 누르면 `LiveShoot.swiftpm`이 풀림
3. 풀린 `LiveShoot.swiftpm`을 "나의 iPad › Playgrounds"로 옮기고 Swift Playgrounds에서 엶
4. 오른쪽 위 실행 버튼(▶)을 누르면 빌드 뒤 앱이 뜸. 사진 보관함 접근을 허용함
5. 빌드 오류가 나면 오류 화면을 캡처해 Claude에게 보여 줌
6. 홈 화면 앱으로 두려면 Swift Playgrounds의 앱 설정에서 Apple 계정을 넣어야 함. 무료 계정 서명은 기간 제한이 있다고 알려져 있어 확인이 필요함 [잠정]

## 촬영할 때

1. 카메라 앱(Creators' App, GR WORLD)에서 촬영 중 전송을 켬
2. LiveShoot에서 "촬영 시작"을 누름. 이미 있던 최근 사진도 보려면 장수를 고름
3. 새 사진이 오면 자동으로 그 사진을 띄움. 필름 띠에서 이전 사진을 고르면 따라가기가 꺼짐. 맨 앞 사진을 누르면 다시 켜짐
4. "고객 보기"는 버튼 없이 사진만 보여 주고 좌우로 넘김. 1.2초 길게 누르면 돌아옴
5. 촬영 중에는 화면이 꺼지지 않음

## Still open

- **소니 기종**: Creators' App의 촬영 중 전송은 FX3, α7R V, α1 등 정해진 기종만 됨(2.5.0, 2024-09, [Sony](https://creatorscloud.sony.net/news/en-us/20240912.html)). 쓰는 기종이 목록에 있는지 확인해야 함
- **리코 GR III**: GR WORLD가 카메라 안 사진을 무선으로 가져오는 것은 확인했지만 찍는 즉시 자동 전송하는지는 확인 못 함([Ricoh](https://www.ricoh-imaging.co.jp/english/products/app/gr-world/)). 안 되면 사진을 골라 보내는 방식이 됨
- **PhotoKit in Playgrounds**: Swift Playgrounds에서 사진 보관함 권한(`.photoLibrary`)이 실제로 붙는지는 iPad에서 빌드해야 확인됨
