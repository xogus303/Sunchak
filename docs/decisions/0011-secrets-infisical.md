# 0011. 비밀값 관리: Infisical (시크릿 매니저)

- 상태: Accepted
- 날짜: 2026-07-14
- 관련: 0010(Neon — 두 기기 공유)

## 맥락 (Context)
두 기기에서 비밀값(DB 연결 문자열, JWT 시크릿, Redis URL 등)을 공유해야 한다(ADR 0010). `.env` 파일을 슬랙·USB로 수동으로 나르는 방식은 유출 위험이 크고, 동기화 실수가 잦다.

## 결정 (Decision)
시크릿 매니저 **Infisical**(무료·오픈소스)에 비밀값을 저장하고, 실행 시 `infisical run -- <명령>`으로 **런타임에 주입**한다. 디스크에 평문 `.env`를 두지 않는 것을 지향한다.

## 고려한 대안 (Alternatives)
| 대안 | 장점 | 단점 / 채택하지 않은 이유 |
|---|---|---|
| **로컬 `.env` 수동 공유** | 도구 불필요 | 유출 위험·기기 간 수동 동기화 실수. 이번 요구(안전한 공유) 불충족. |
| **Doppler** | 개인 무료, 셋업 가장 빠름 | 클로즈드 소스. 학습 투명성은 Infisical이 우위. |
| **1Password** | 이미 쓰면 편리, `op://` 참조는 커밋 가능 | 무료 단독 플랜 없음(유료 $7.99/월~). |
| **Infisical (채택)** | 무료 티어(3프로젝트/5아이덴티티), 오픈소스(자체호스팅 가능), CLI 주입, 원리가 투명해 학습에 좋음 | 유료 전환 시 identity 기반 과금, 약간의 러닝커브. |

## 근거 (Rationale)
무료 + 오픈소스 + 원리 투명이라 학습 프로젝트에 최적. `infisical run` 주입 방식은 `.env` 파일 자체를 없애 유출면(공격 표면)을 줄인다. 집 노트북에선 `infisical login`만 하면 동일 비밀값을 즉시 사용 → ADR 0010의 "두 기기 공유"를 안전하게 완성한다.

## 결과 (Consequences)
- 실행 형태가 바뀐다: `infisical run -- npm run start:dev`, `infisical run -- npx prisma migrate dev`.
- `apps/api/.env.example`은 **"필요한 키 목록·형식" 문서**로 유지한다(실제 값은 Infisical에 저장).
- 로컬 `.env`는 여전히 gitignore. 급할 땐 로컬 `.env`로도 실행 가능하지만, 공유가 필요한 비밀값은 Infisical을 단일 소스로 둔다.
