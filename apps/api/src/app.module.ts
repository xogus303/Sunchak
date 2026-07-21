import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { AuthModule } from './auth/auth.module';
import { EventsModule } from './events/events.module';
import { ReservationsModule } from './reservations/reservations.module';
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
  ],
  controllers: [AppController],
})
export class AppModule {}
