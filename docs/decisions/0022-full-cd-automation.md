# 0022. CD 완전 자동화 — CI 통과 시 자동 빌드 + VM SSH 자동 배포

- 상태: Accepted
- 날짜: 2026-08-22
- 관련: (CI/CD 최초 구축, `.github/workflows/ci.yml`·`cd.yml`), 0019(배포 인프라), 0011(비밀값 관리 — 로컬 `.env`로 정식 확정된 방향과 같은 결의 트레이드오프)

## 맥락 (Context)
`cd.yml`은 CI/CD를 처음 만들 때부터 `workflow_dispatch`(수동 버튼)로만 동작했다. 당시 "VM 배포 job은 3번 작업(VM+Nginx) 완료 후 추가 예정"이라고 남겨뒀는데, VM 배포는 그날 바로 끝났음에도 이 항목은 다시 안 건드려져 방치돼 있었다 — 그 뒤로 배포할 때마다 사람이 GitHub Actions 버튼을 누르고, VM에는 SSH로 직접 접속해 `docker compose pull && up -d`를 손으로 실행해왔다.

## 결정 (Decision)
1. **이미지 빌드 트리거**: `main`에 push될 때 `ci.yml`이 성공(모든 테스트 통과)했을 때만 자동으로 빌드+GHCR push(`workflow_run` 트리거, `conclusion == 'success'` 조건). `workflow_dispatch`도 남겨 수동 재실행 통로는 유지.
2. **VM 반영**: `appleboy/ssh-action`으로 GitHub Actions가 VM에 직접 SSH 접속해 `docker compose pull && up -d`까지 자동 실행. SSH 개인키·호스트 지문을 GitHub Secrets에 저장.
3. **호스트 지문 고정**(`fingerprint`)으로 중간자 공격을 방어 — 이 정도는 비용이 거의 안 들어 굳이 생략할 이유가 없었음.
4. `workflow_run`으로 트리거되면 `github.sha`가 워크플로우 파일 자체의 커밋을 가리켜(CI가 실제로 검증한 커밋이 아님) 이미지 태그가 어긋날 수 있어, `github.event.workflow_run.head_sha`로 명시적으로 해석해 체크아웃·태깅 둘 다에 사용.

## 고려한 대안 (Alternatives)
| 대안 | 장점 | 단점 / 채택하지 않은 이유 |
|---|---|---|
| 지금처럼 완전 수동 유지 | 배포 시점을 사람이 항상 통제 | 매번 버튼 클릭+SSH 수작업, 자동화 이점 없음 |
| 이미지 빌드만 자동, VM 반영은 수동 | SSH 키를 GitHub에 안 올려도 됨(공격 표면 감소) | "완전 자동"이라는 목표에 못 미침, 결국 사람이 매번 확인·SSH해야 함 |
| **완전 자동(채택)** | push 한 번으로 테스트→빌드→배포까지 끝 | SSH 개인키를 GitHub Secrets에 저장(공격 표면 추가) + DB 마이그레이션(`prisma migrate deploy`)이 사람 검토 없이 바로 나감(컨테이너 시작 명령에 포함) |

## 근거 (Rationale)
개인 프로젝트라 배포 빈도가 낮고 트래픽도 적어, 완전 자동화의 리스크(마이그레이션 무검토 반영)보다 이점(수작업 제거)이 크다고 판단했다. SSH 키 노출 리스크는 ADR 0011이 이미 받아들인 "로컬 `.env` 평문 관리" 수준의 트레이드오프와 결이 같다 — 이 프로젝트는 애초에 "완벽한 보안"보다 "학습·포트폴리오 목적에 맞는 합리적 위험 감수"를 기준으로 삼아왔다. 호스트 지문 고정은 예외적으로 비용이 거의 0이라(명령 한 줄) 추가했다.

## 결과 (Consequences)
- `.github/workflows/cd.yml`: `workflow_run` 트리거 + `deploy` job(needs: build-and-push) 추가.
- **새 GitHub Secrets 4개 필요**(사람이 웹에서 직접 등록 — 자동화 불가): `VM_HOST`, `VM_USERNAME`, `VM_SSH_KEY`, `VM_HOST_FINGERPRINT`.
- 앞으로 `main`에 정상적으로 merge/push되는 모든 커밋이 자동으로 프로덕션까지 나간다 — PR 리뷰나 로컬 검증 없이 바로 push하는 습관은 이제 곧바로 배포로 이어진다는 뜻이라 더 신중해야 한다.
- 여전히 사람이 해야 하는 것: 마이그레이션이 필요한 스키마 변경처럼 위험도가 높은 커밋은 push 전에 로컬에서 `prisma migrate deploy`를 미리 검증하는 습관이 이전보다 더 중요해짐(자동 배포가 그 검증을 대신 안 해주므로).
