import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // req.cookies를 채워준다 — 로그인/게이트 토큰을 쿠키에서 읽는 가드·전략이 이걸 전제로 한다.
  app.use(cookieParser());

  // apps/web(다른 포트=다른 origin)이 쿠키를 실어 보내려면 credentials:true +
  // 구체적인 origin이 필요하다(와일드カード '*'는 쿠키 인증과 함께 못 쓴다 — 스펙 제약).
  app.enableCors({
    origin: process.env.WEB_APP_URL ?? 'http://localhost:3000',
    credentials: true,
  });

  // 전역 입력 검증. DTO 규칙 위반은 자동 400 응답.
  // whitelist: DTO에 없는 필드 제거 / forbidNonWhitelisted: 모르는 필드가 오면 거부.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const port = process.env.PORT ?? 3001;
  await app.listen(port);
  console.log(`Sunchak API listening on http://localhost:${port}`);
}

void bootstrap();
