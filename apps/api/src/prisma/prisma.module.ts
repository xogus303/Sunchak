import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * @Global — PrismaService를 한 번만 등록하면 어느 모듈에서든 주입 가능.
 * DB 접근은 거의 모든 도메인 모듈에서 필요하므로 전역으로 노출한다.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
