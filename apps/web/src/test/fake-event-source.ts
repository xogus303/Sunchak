// jsdom엔 EventSource가 없어 테스트용으로 최소 구현을 흉내낸다.
// DemoDashboard 테스트와 page(dashboard 분기) 테스트 둘 다 이 흉내를 필요로 해서 공유한다.
export class FakeEventSource {
  static instances: FakeEventSource[] = [];

  url: string;
  withCredentials: boolean;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string, options?: { withCredentials?: boolean }) {
    this.url = url;
    this.withCredentials = options?.withCredentials ?? false;
    FakeEventSource.instances.push(this);
  }

  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  close() {}
}
