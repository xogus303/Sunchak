# 0013. 인증 방식: argon2 해싱 + JWT + DTO 검증

- 상태: Accepted
- 날짜: 2026-07-14
- 관련: 0001(NestJS), 0009(User 스키마)

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
- `User.password`에는 argon2 해시만 저장. 응답에 절대 포함하지 않음.
- 로그인 성공 시 JWT 발급 → 이후 요청은 `Authorization: Bearer <token>`로 인증.
- 보호 라우트는 passport-jwt Strategy + Guard로 게이팅(다음 단계).
