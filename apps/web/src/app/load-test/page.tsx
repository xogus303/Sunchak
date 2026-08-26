"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";
import { BookingForm } from "../booking-form";
import { LoadTestDashboard } from "../load-test-dashboard";
import { useLoadTestStats } from "../use-load-test-stats";

// 캐주얼 데모(/events)와 완전히 분리된 별도 라우트(ADR 0016 백로그, 2026-08-26
// 신설) — 재고·투입 인원을 유저가 직접 정해 시작하는 대용량 트래픽 테스트 전용
// 화면. API(load-test.controller.ts)는 지난 세션에 이미 있었지만 대응하는
// 프론트 화면이 없어 /load-test로 들어가면 404였다.
//
// BookingForm 추가(2026-08-26) — 지금까지 이 화면은 "가상 유저를 투입하고
// 집계만 지켜보는" 관리자 콘솔이라, 방문자 본인이 표를 구하려고 경쟁하는
// 1인칭 체험이 없다는 지적을 받았다. events/[id]/page.tsx와 같은 컴포넌트를
// 재사용하되, eventId는 URL에 없어 join 응답(`POST /load-test/queue`)에서
// 얻고(joinQueueUrl/queueStreamUrl props), 크라우드는 아래 자동 세팅이
// 대신하므로 BookingForm 자체의 랜덤 자동투입(autoInjectCrowd)은 끈다.

// 마운트 시 자동으로 맞추는 "대용량" 기본값 — 사용자 확정(2026-08-26). 상한
// (LOAD_TEST_MAX_STOCK/VU, 기본 10,000)과 재고를 같게 둬 "최대 규모" 체감을
// 곧바로 준다.
const AUTO_SETUP_STOCK = 10_000;
const AUTO_SETUP_VU = 5_000;

// 리셋 직후 곧바로 본인을 대기열에 넣으면 가상 유저가 아직 거의 안 쌓인
// 상태라 순번이 작게(예: 45) 나와 "대용량" 체감이 안 된다는 지적(2026-08-26)
// — 대기열이 이만큼 쌓일 때까지 기다렸다가 본인을 참여시킨다.
//
// 이 값은 임의로 큰 수를 고르면 안 된다 — 입장 처리 워커(LoadTestAdmissionProcessor,
// 기본 1초 주기로 남은 인원의 20%, 최소 50명씩 배출)가 대기열을 계속 비우기
// 때문에, 투입 페이스(초당 200명, ADR 0016의 Postgres 보호용 실질 안전장치)와
// 배출 페이스가 맞물려 대기열 길이는 결국 평형에 수렴한다 — 재귀식
// R_{n+1} = 0.8*R_n + 160으로 근사하면 평형점은 800 근처(200 = remaining*0.2
// 이 되는 지점). 2,000처럼 그 평형보다 큰 값을 목표로 잡으면 절대 못 채워서
// 아래 타임아웃에만 계속 의존하게 된다 — 그래서 그 평형 아래인 600으로 잡았다.
const QUEUE_BUILDUP_THRESHOLD = 600;
// 위 평형 계산으로 600 근처는 대략 10초 안팎에 닿는다(초당 200명 유입 기준) —
// 그보다 페이스가 느린 환경(다른 env 설정)에서도 화면이 무한정 멈춰있지
// 않도록 넉넉히 잡은 안전장치.
const QUEUE_BUILDUP_TIMEOUT_MS = 15_000;

export default function LoadTestPage() {
  const { stats, streamError } = useLoadTestStats();
  // 리셋이 끝났는지(대기열을 비우는 purge가 끝나야 안전) — resetDone.
  // 대기열이 충분히 쌓였는지(또는 타임아웃) — ready. ready가 true일 때만
  // BookingForm(본인 대기열 입장)을 렌더한다.
  const [resetDone, setResetDone] = useState(false);
  const [ready, setReady] = useState(false);

  // StrictMode(개발 모드 기본값)가 마운트 시 effect를 두 번 실행하는 걸 막는다
  // (booking-form.tsx의 hasStartedRef와 같은 이유) — 가드 없이 두면 리셋을
  // 두 번 쏴서 두 번째 리셋이 첫 번째가 이미 투입 중이던 가상 유저까지 지운다.
  const hasStartedRef = useRef(false);
  useEffect(() => {
    if (hasStartedRef.current) return;
    hasStartedRef.current = true;

    apiFetch("/load-test/reset", {
      method: "POST",
      body: JSON.stringify({ totalQty: AUTO_SETUP_STOCK }),
    })
      .catch(() => {})
      .then(() => {
        setResetDone(true);
        // 리셋 완료 후에만 투입한다 — 동시에 쏘면 리셋의 purge가 이미 투입돼
        // 대기열에 선 가상 유저까지 지울 수 있다(reservations.service.ts의
        // 관문/HELD 순서 원칙과 같은 이유 — 파괴적 작업은 항상 먼저 끝나야 한다).
        return apiFetch("/load-test/simulate", {
          method: "POST",
          body: JSON.stringify({ virtualUserCount: AUTO_SETUP_VU }),
        }).catch(() => {}); // 쿨다운(429) 등은 조용히 무시 — 방금 다른 방문자가 이미 투입했을 뿐
      });
  }, []);

  // stats(1초 주기 SSE)의 admissionQueueCount가 곧 "지금 참여하면 내 앞에
  // 몇 명이 서 있을지"와 같다 — 이 값이 임계치를 넘는 순간 본인을 참여시킨다.
  useEffect(() => {
    if (!resetDone || ready) return;
    if ((stats?.admissionQueueCount ?? 0) >= QUEUE_BUILDUP_THRESHOLD) {
      setReady(true);
    }
  }, [resetDone, ready, stats?.admissionQueueCount]);

  // 안전장치 — 페이스가 느린 환경 등으로 임계치에 영영 못 닿아도 화면이
  // 무한정 멈춰있지 않게 한다.
  useEffect(() => {
    if (!resetDone || ready) return;
    const timer = setTimeout(() => setReady(true), QUEUE_BUILDUP_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [resetDone, ready]);

  return (
    <div className="flex flex-1 flex-col items-center gap-8 bg-zinc-50 px-6 py-16 dark:bg-black">
      <div className="flex w-full max-w-5xl flex-col gap-6">
        <Link href="/events" className="self-start text-sm text-zinc-500 hover:underline dark:text-zinc-400">
          ← 이벤트 목록으로
        </Link>

        {/* 페이지 인트로 — "이게 무슨 화면인지" 첫눈에 설명(2026-08-26, UI 개선
            옵션 B). 데이터 나열 전에 상황을 먼저 알려준다. */}
        <div className="rounded-lg bg-zinc-100 p-4 text-sm text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
          가상 유저 <b>5,000명</b>이 티켓 <b>10,000장</b>을 두고 동시에 예매를 시도하는 상황을 시뮬레이션합니다.
          왼쪽은 <b>나의 상황</b>, 오른쪽은 <b>전체 현황</b>입니다.
        </div>

        <div className="flex flex-col items-start gap-8 lg:flex-row lg:justify-center">
          {ready ? (
            <BookingForm
              eventTitle="대용량 트래픽 테스트"
              joinQueueUrl="/load-test/queue"
              queueStreamUrl="/load-test/queue/stream"
              autoInjectCrowd={false}
              sectionLabel="나의 상황"
            />
          ) : (
            <div className="flex w-full max-w-2xl flex-col gap-3">
              <div className="flex items-center gap-2">
                <span className="h-4 w-1 rounded-sm bg-zinc-950 dark:bg-zinc-50" />
                <span className="text-xs font-bold tracking-wide text-zinc-950 uppercase dark:text-zinc-50">
                  나의 상황
                </span>
              </div>
              <div className="flex flex-col gap-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
                <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">내 예매 — 대용량 트래픽 테스트</h2>
                <p className="text-sm text-zinc-500">
                  대기열 형성 중 — 현재{" "}
                  <span className="font-mono font-semibold text-zinc-950 dark:text-zinc-50">
                    {(stats?.admissionQueueCount ?? 0).toLocaleString()}
                  </span>
                  명 대기 중
                </p>
              </div>
            </div>
          )}
          <LoadTestDashboard stats={stats} streamError={streamError} sectionLabel="전체 현황" />
        </div>
      </div>
    </div>
  );
}
