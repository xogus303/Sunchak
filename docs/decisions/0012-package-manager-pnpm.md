# 0012. 패키지 매니저: pnpm (corepack로 버전 고정)

- 상태: Accepted
- 날짜: 2026-07-14
- 관련: 0007(모노레포), 0010·0011(기기 간 재현성)

## 맥락 (Context)
모노레포(`apps/api`, 향후 `apps/web`)의 의존성을 관리할 패키지 매니저를 정한다. 두 기기(회사/집)에서 동일하게 재현돼야 한다.

## 결정 (Decision)
**pnpm**을 사용한다. Node에 내장된 **corepack**으로 `package.json`의 `packageManager` 필드에 pnpm 버전을 고정해, 두 기기가 정확히 같은 버전을 쓰게 한다.

## 고려한 대안 (Alternatives)
| 대안 | 장점 | 단점 / 채택하지 않은 이유 |
|---|---|---|
| **npm** | Node 내장, 설치 불필요, 가장 단순 | 느리고 디스크 중복(프로젝트마다 node_modules), 모노레포 워크스페이스 기능이 약함. |
| **yarn** | 중간, classic은 무난 | pnpm 대비 모노레포·디스크 이점이 적음. |
| **pnpm (채택)** | 빠름·디스크 절약(전역 저장소 + 하드링크), **엄격한 의존성 해석**(phantom dependency 차단), 모노레포 워크스페이스 강력, corepack 버전 고정 | 초기 설치(`corepack enable`) 한 번 필요. |

## 근거 (Rationale)
모노레포 + 재현성 요구에 pnpm이 가장 잘 맞는다. corepack의 버전 고정은 ADR 0010·0011의 "두 기기 동일 환경" 원칙과 맞물린다. 엄격한 의존성 해석은 "선언 안 한 패키지를 몰래 쓰는" 실수를 막아 학습 규율에도 좋다.

## 결과 (Consequences)
- 명령은 pnpm으로 통일: `pnpm install`, `pnpm exec prisma ...`, `infisical run -- pnpm ...`.
- 기존 `package-lock.json`(npm)을 제거하고 `pnpm-lock.yaml`을 커밋한다.
- **정식 pnpm 워크스페이스 구성**(root `pnpm-workspace.yaml`)은 `apps/web`을 추가하는 시점에 도입한다(ADR 0007의 "필요 시 도입" 방침).
