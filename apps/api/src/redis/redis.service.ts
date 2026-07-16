import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * ioredis 클라이언트를 Nest 생명주기에 연결한다. (PrismaService와 같은 패턴)
 * - extends Redis: 이 서비스 인스턴스 자체가 Redis 클라이언트가 된다
 *   → 주입받은 곳에서 this.redis.decrby(...) 처럼 명령을 바로 호출.
 * - lazyConnect: 생성자에서 즉시 접속하지 않고, onModuleInit에서 명시적으로 connect.
 * - onModuleDestroy: 종료 시 연결을 닫아 그레이스풀 셧다운.
 */
@Injectable()
export class RedisService
  extends Redis
  implements OnModuleInit, OnModuleDestroy
{
  constructor(config: ConfigService) {
    super(config.get<string>('REDIS_URL') ?? 'redis://localhost:6379', {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    });
  }

  async onModuleInit() {
    await this.connect();
  }

  async onModuleDestroy() {
    // ioredis의 quit(): 남은 명령을 보내고 연결을 정상 종료
    await this.quit();
  }
}
