import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
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
    PrismaModule,
    RedisModule,
    AuthModule,
    EventsModule,
    ReservationsModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
