import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { AuthModule } from './auth/auth.module';
import { EventsModule } from './events/events.module';
import { ReservationsModule } from './reservations/reservations.module';
import { DemoModule } from './demo/demo.module';
import { DemoGateGuard } from './demo/guards/demo-gate.guard';
import { AppController } from './app.controller';

@Module({
  imports: [
    // .env를 전역 로드. isGlobal=true → 각 모듈에서 재-import 불필요.
    ConfigModule.forRoot({ isGlobal: true }),
    // BullMQ 전역 설정 — 큐/워커가 공유할 Redis 연결. (관문 DECRBY와 같은 Redis 인스턴스, 다른 용도)
    // 옵션(host/port)을 넘기면 BullMQ가 연결을 직접 만들며, 워커용 블로킹 연결에
    // 필요한 maxRetriesPerRequest:null도 알아서 세팅한다(인스턴스를 넘길 때와 달리).
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const url = new URL(
          config.get<string>('REDIS_URL') ?? 'redis://localhost:6379',
        );
        return {
          connection: {
            host: url.hostname,
            port: Number(url.port) || 6379,
            ...(url.password ? { password: url.password } : {}),
          },
        };
      },
    }),
    PrismaModule,
    RedisModule,
    AuthModule,
    EventsModule,
    ReservationsModule,
    DemoModule,
  ],
  controllers: [AppController],
  providers: [
    // 첫 전역 가드(ADR 0016 축 A) — APP_GUARD로 등록하면 컨트롤러마다
    // @UseGuards를 안 붙여도 모든 라우트에 자동 적용된다. @Public()이 붙은
    // 라우트(게이트 자신, 헬스체크)만 예외.
    { provide: APP_GUARD, useClass: DemoGateGuard },
  ],
})
export class AppModule {}
