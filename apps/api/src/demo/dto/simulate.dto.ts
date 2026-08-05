import { IsInt, Min } from 'class-validator';

export class SimulateDto {
  // 최소값만 여기서 검증한다. 상한(DEMO_SIM_MAX_VU)은 배포 시 env로 바뀌는
  // 값이라 데코레이터(컴파일 타임 고정)가 아니라 서비스에서 ConfigService로 검증한다.
  @IsInt()
  @Min(1)
  virtualUserCount: number;
}
