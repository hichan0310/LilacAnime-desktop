# Product

<!-- impeccable:product-schema 1 -->

## Platform

adaptive

## Users

애니메이션을 검색하고, 작품별 회차와 자막을 선택해 Windows 데스크톱에서 감상하려는 LilacAnime 사용자. 기존 Android 앱의 사용 방식과 설정을 그대로 기대한다.

## Product Purpose

작품 탐색부터 회차 선택, 자막 적용, 재생, 이어보기와 보관함 관리까지 하나의 앱에서 제공한다. 성공은 Android LilacAnime 사용자가 기능과 정보 구조를 다시 학습하지 않고 데스크톱 앱을 사용할 수 있는 것이다.

## Positioning

Linkkf, Animenosub, RE:Anime 카탈로그와 여러 자막 소스를 한 UI에서 선택하며 사용자 소유 미디어도 함께 재생하는 데스크톱용 LilacAnime 클라이언트다.

## Operating Context

Windows 데스크톱에서 마우스와 키보드로 사용한다. 홈, 전체 작품, 검색, 시청 기록, 내 목록, 설정의 Android 원본 탐색 구조를 유지한다. 외부 콘텐츠 서버가 내려가거나 응답 구조가 바뀔 수 있다.

## Capabilities and Constraints

- 콘텐츠 소스: Linkkf, Animenosub, RE:Anime.
- 작품 검색, 상세, 회차, 보관함, 시청 기록, 직접 영상 재생.
- Linkkf VTT, Kairan ASS, Csora ASS, 사용자 자막 선택 구조.
- 재생 속도, 화질, 자막 크기·위치·스타일·싱크, 탐색 간격, 자동 재생, OP/ED 스킵 설정.
- 외부 서비스의 가용성 및 이용 조건은 앱이 통제하지 못한다.
- Android 전용 Chromecast와 PIP는 Windows의 별도 재생 창 및 미니 플레이어로 대응한다.
- Android Service 기반 다운로드는 Windows 다운로드 큐와 로컬 저장소로 대응한다.

## Brand Commitments

이름은 LilacAnime를 유지한다. 라일락 `#C8A2C8`을 주 강조색으로 사용하고, Android Material 구조와 한국어 UI 문구를 데스크톱에서도 보존한다.

## Evidence on Hand

- Android 원본 구현: `app/src/main/kotlin/com/lilac/anime/`
- 기존 데스크톱 구현: `desktopApp/src/main/kotlin/com/lilac/anime/desktop/`
- Electron 포팅: `electron/`, `src/`
- 실제 외부 서비스 응답 외에 성능 또는 가용성에 대한 보장 자료는 없다.

## Product Principles

- 모바일 원본과 같은 위치에서 같은 기능을 찾을 수 있어야 한다.
- 외부 서버 장애가 앱 전체 장애가 되지 않아야 한다.
- 재생 중 인터페이스는 영상과 자막을 방해하지 않아야 한다.
- 사용자 기록과 설정은 로컬에 남고 다시 시작해도 복구되어야 한다.
- 권한과 출처가 분명한 콘텐츠만 사용하도록 상태와 책임 범위를 명확히 알린다.

## Accessibility & Inclusion

키보드 탐색, 명확한 포커스 표시, 충분한 대비, 축소 애니메이션 설정을 지원한다.
