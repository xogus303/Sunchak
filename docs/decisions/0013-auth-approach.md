# 0013. 인증 방식: argon2 해싱 + JWT + DTO 검증

- 상태: Accepted (2026-08-08 — Google SSO·쿠키 전송 경로 추가 반영, 원안의 "Bearer 헤더만" 부분 Superseded)
- 날짜: 2026-07-14
- 관련: 0001(NestJS), 0009(User 스키마), 0006(SSE — 쿠키 전환의 계기)

> **개정 이력 (2026-08-08 — 배포 전 ADR 점검 중 발견한 드리프트 반영)**
> 원안은 "로그인 성공 시 JWT 발급 → 이후 요청은 `Authorization: Bearer <token>`로 인증"만 적었는데, 실제로는 두 가지가 그 뒤 조용히 추가돼 지금까지 이 ADR에 반영되지 않았다.
>
> 1. **Google SSO(방문자 예매 인증, 2026-08-01 도입)** — 이메일/비밀번호 회원가입 외에 `passport-google-oauth20` 기반 로그인이 추가됐다(`apps/api/src/auth/strategies/google.strategy.ts`, `AuthController`의 `GET /auth/google`·`/auth/google/callback`). Google 계정은 비밀번호가 없어 `User.password`가 `String?`(nullable)로 바뀌었다(원안은 이 컬럼이 항상 값이 있다고 암묵적으로 가정). 원래 "방문자가 직접 예매 가능해야 한다"는 요구가 이 ADR 밖에서 뒤늦게 나와, 별도 ADR 없이 이 문서를 갱신 안 한 채로 구현됐다 — 그게 이번에 발견된 드리프트다.
> 2. **토큰 전송 경로가 쿠키 우선으로 바뀜(2026-08-05, ADR 0006 SSE 작업 중 계기)** — 브라우저 `EventSource`(SSE)가 커스텀 `Authorization` 헤더를 못 붙이는 문제 때문에, `JwtStrategy`가 이제 **httpOnly 쿠키를 먼저 보고, 없으면 Bearer 헤더로 폴백**한다(`jwt.strategy.ts`의 `ExtractJwt.fromExtractors([cookie추출기, fromAuthHeaderAsBearerToken()])`). 로그인·회원가입·Google 콜백 모두 응답에 쿠키를 함께 심는다(`auth.controller.ts`, `common/auth-cookie.ts`). Bearer 헤더는 폐기되지 않았다 — curl 등 수동 검증용 경로로 여전히 살아있다. "무상태 JWT"라는 원안의 핵심 원칙은 안 바뀜(쿠키도 그 안에 무상태 JWT를 담아 옮기는 것뿐).
> 3. **로그아웃(2026-08-08 추가)** — 원안엔 없던 개념. `POST /auth/logout`이 httpOnly 쿠키를 지운다(JWT 자체는 무효화 불가 — 상태 없는 토큰의 근본 한계, 블랙리스트 미도입).
> 4. **`JwtStrategy.validate()`가 DB로 유저 존재를 한 번 더 확인(2026-08-08, 같은 날 실사용 중 발견)** — 원안의 "무상태 인증"은 "서명·만료만 보면 끝"을 뜻했는데, 실제로는 이게 문제였다. 개발 중 `jest`가 DB를 통째로 비우는 일이 잦아서, 브라우저에 남은 예전 쿠키(서명은 유효)가 "이제 DB엔 없는 유저"로 통과돼 이후 `demoOwnerId` 같은 FK를 참조하는 곳에서 원인 모를 500으로 이어지는 버그가 실제로 발생했다. `validate()`가 `prisma.user.findUnique`로 존재를 확인하고, 없으면 401을 던지도록 고쳤다 — **무상태 JWT의 "매 요청 DB 조회 없음" 이점을 일부 내주는 대신, "이 유저가 지금 실재하는가"를 정확히 보장**하는 쪽을 택했다(요청당 DB 히트 1회 추가, 이 프로젝트 규모에서는 무시할 수준). 개발 환경 특유의 문제만이 아니라, 실제 서비스에서도 유저 삭제/정지를 "즉시 반영"하려면 필요한 정상적인 보완이다.
>
> 실제 구현이 잘못된 게 아니라 **이 ADR이 그 변화를 안 따라간 것**이라 위 내용으로 "결정" 섹션을 갱신한다(아래 본문은 원안 그대로 보존).

## 맥락 (Context)
회원가입·로그인과 보호된 엔드포인트가 필요하다. 비밀번호를 안전하게 저장하고, 입력을 검증하며, 로그인 상태를 무상태(stateless)로 유지해야 한다.

## 결정 (Decision)
- **비밀번호 해싱: argon2.** 평문 저장 금지, 단방향 해시만 저장.
- **입력 검증: DTO + class-validator + 전역 `ValidationPipe`.** 컨트롤러에 도달하기 전 형식·규칙을 강제.
- **인증: JWT(액세스 토큰) + passport-jwt.** 서버가 세션을 들고 있지 않는 무상태 인증. (리프레시 토큰은 필요 시 후속 도입.)

## 고려한 대안 (Alternatives)
| 주제 | 대안 | 채택하지 않은 이유 |
|---|---|---|
| 해싱 | **bcrypt** | 검증된 표준이지만 argon2가 더 현대적(메모리-하드 함수). bcrypt는 72바이트 제한도 있음. argon2 채택. (네이티브 빌드 실패 시 `bcryptjs` 폴백.) |
| 해싱 | 평문/단순 해시(MD5·SHA) | 유출 시 즉시 위험. 절대 불가. |
| 세션 | 서버 세션(쿠키+세션스토어) | 상태를 서버가 들고 있어야 함. 무상태 JWT가 확장·학습에 더 적합. |
| 검증 | 컨트롤러에서 수동 if 검사 | 반복·누락 위험. 선언적 DTO 검증이 깔끔. |

## 근거 (Rationale)
argon2 + JWT + DTO 검증은 NestJS 생태계의 정석 조합이라 학습 가치가 크고, 무상태 JWT는 이후 배포·확장과도 잘 맞는다. 각 계층(컨트롤러=HTTP, 서비스=로직, DTO=입력계약)을 분리해 관심사를 나눈다.

## 결과 (Consequences)
- `User.password`에는 argon2 해시만 저장(단, 2026-08-01부터 Google 계정은 `null` — 위 개정 이력 참고). 응답에 절대 포함하지 않음.
- 로그인 성공 시 JWT 발급 → 이후 요청은 `Authorization: Bearer <token>`로 인증(2026-08-05부터 httpOnly 쿠키가 우선 경로, Bearer는 폴백 — 위 개정 이력 참고).
- 보호 라우트는 passport-jwt Strategy + Guard로 게이팅(다음 단계).
