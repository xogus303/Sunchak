import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// RTL의 자동 cleanup은 globalThis.afterEach를 전제로 하는데, 이 프로젝트는
// vitest globals를 켜지 않았으므로(테스트마다 명시적으로 import) 여기서 직접 등록한다.
// 안 하면 테스트 간 DOM이 안 비워져 "여러 개 찾힘" 에러가 난다.
afterEach(cleanup);
