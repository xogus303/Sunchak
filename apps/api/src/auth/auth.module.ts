import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';

/**
 * 모듈 = 관련된 컨트롤러·서비스를 하나로 묶는 단위.
 * JwtModule은 비밀키·만료를 .env(Infisical 주입)에서 읽어 비동기 등록한다.
 */
@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET'),
        signOptions: {
          // ms의 엄격한 StringValue 타입 회피: 제네릭 없이 받아 any로 넘긴다.
        expiresIn: config.get('JWT_EXPIRES_IN') ?? '1h',
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService],
})
export class AuthModule {}
