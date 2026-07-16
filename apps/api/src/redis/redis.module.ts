import { Global, Module } from '@nestjs/common';
import { RedisService } from './redis.service';

/**
 * @Global — RedisService를 한 번만 등록하면 어느 모듈에서든 주입 가능.
 * (PrismaModule과 동일한 전역 노출 패턴)
 */
@Global()
@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}
