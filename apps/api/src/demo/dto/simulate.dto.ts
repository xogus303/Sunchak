import { IsBoolean, IsInt, IsOptional, Min } from 'class-validator';

export class SimulateDto {
  // 최소값만 여기서 검증한다. 상한(DEMO_SIM_MAX_VU)은 배포 시 env로 바뀌는
  // 값이라 데코레이터(컴파일 타임 고정)가 아니라 서비스에서 ConfigService로 검증한다.
  @IsInt()
  @Min(1)
  virtualUserCount: number;

  // 이벤트 상세 페이지 마운트 시 자동 투입인지 구분(2026-08-07) — 수동 "가상
  // 유저 투입" 버튼과 별개의 훨씬 짧은 쿨다운을 적용하기 위함(demo.service.ts 참고).
  @IsOptional()
  @IsBoolean()
  auto?: boolean;
}
