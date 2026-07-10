import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * PrismaClient를 Nest 생명주기에 연결한다.
 * - onModuleInit: 앱 부팅 시 DB 연결
 * - onModuleDestroy: 종료 시 커넥션 정리(그레이스풀 셧다운)
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
