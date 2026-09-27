# LilacAnime Desktop

LilacAnime Android 프로젝트의 탐색 경험과 라일락 테마를 Windows 데스크톱에 맞게 재구성한 Electron 앱입니다.

## 실행

```powershell
npm install
npm start
```

## Windows 설치 파일 만들기

```powershell
npm run dist
```

완성된 설치 파일은 `dist/LilacAnime-Setup-0.3.8.exe`에 생성됩니다.

## 제공 기능

- 현재 시즌 및 인기 애니메이션 탐색
- 제목 검색과 작품 상세 정보
- 로컬 보관함 및 최근 재생 기록
- 로컬 영상, HTTPS 영상 URL, WebVTT 사용자 자막 재생
- 다크/라이트 테마

작품 메타데이터는 Jikan API를 사용합니다. 앱은 영상 콘텐츠를 제공하지 않으며, 사용자가 소유하거나 재생 권한이 있는 미디어만 재생해야 합니다.

## 크레딧

- 원작: [dream150/LilacAnime](https://github.com/dream150/LilacAnime) (Android) — 원작자의 허락을 받아 Windows 데스크톱(Electron)용으로 포팅한 프로젝트입니다.
