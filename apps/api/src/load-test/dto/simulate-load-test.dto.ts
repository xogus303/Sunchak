import { IsInt, Min } from 'class-validator';

export class SimulateLoadTestDto {
  // 상한(LOAD_TEST_MAX_VU)은 서비스에서 검증한다 — DTO는 최소값만 방어.
  @IsInt()
  @Min(1)
  virtualUserCount: number;
}
