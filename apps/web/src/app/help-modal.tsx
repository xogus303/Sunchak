"use client";

import { Modal } from "./modal";

interface HelpModalProps {
  open: boolean;
  onClose: () => void;
}

// 헤더의 "도움말" 버튼이 여는 전체 매뉴얼(2026-08-08) — 목적/사용법/케이스 3단.
// 이벤트 상세 페이지의 대기열 안내 팝업(queue-notice-modal.tsx)과는 완전히
// 별개다(사용자 확인, 2026-08-08) — 저건 상세 진입 시 자동으로 한 번 뜨는 짧은
// 안내고, 이건 버튼으로 언제든 다시 열어보는 전체 설명서.
export function HelpModal({ open, onClose }: HelpModalProps) {
  return (
    <Modal open={open} onClose={onClose} title="Sunchak 데모 안내">
      <section className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">목적</h3>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          이 사이트는 「선착순 티켓 예매」 서비스를 실제로 체험해볼 수 있는 학습·포트폴리오용
          공개 데모입니다. 대량 트래픽이 몰릴 때 대기열이 어떻게 순번을 매기고, 재고가
          어떻게 안전하게(초과판매 없이) 줄어드는지를 직접 눌러보며 확인할 수 있습니다.
        </p>
      </section>
      <section className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">사용법</h3>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-zinc-600 dark:text-zinc-400">
          <li>이벤트 목록에서 판매중(ON_SALE) 이벤트를 선택합니다.</li>
          <li>상세 페이지에 들어가는 순간 자동으로 대기열에 입장합니다(가상 참가자와 함께).</li>
          <li>순서가 되면 수량을 정해 「예매하기」를 누릅니다 — 좌석이 30초간 확보됩니다.</li>
          <li>「결제하기」를 눌러 결제를 완료합니다(80% 확률로 성공, 20%는 실패).</li>
          <li>우측 패널에서 가상 유저를 더 투입하거나, 데이터를 리셋해 처음부터 다시 볼 수 있습니다.</li>
        </ol>
      </section>
      <section className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">둘러볼 만한 케이스</h3>
        <ul className="list-disc space-y-1 pl-5 text-sm text-zinc-600 dark:text-zinc-400">
          <li>가상 유저를 재고보다 많이 투입해 「재고소진 실패」가 늘어나는 걸 관찰하기.</li>
          <li>결제를 여러 번 시도해 20% 확률로 「결제 실패」(CANCELLED) 티켓이 나오는지 보기.</li>
          <li>「예매하기」 후 결제 없이 30초를 흘려보내 「만료됨」(EXPIRED)으로 바뀌는지 보기.</li>
          <li>데이터 리셋 후 처음부터 다시 — 재고·대기열·티켓 목록이 전부 초기화됩니다.</li>
        </ul>
      </section>
    </Modal>
  );
}
