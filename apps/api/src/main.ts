import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

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
