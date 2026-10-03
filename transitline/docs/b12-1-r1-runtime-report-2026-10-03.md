# B12-1 R1 런타임 보고 연결

`ScenarioRuntime`이 직통 서비스 경영 상태를 생성·재심사·승인·중단·재개·종료할 수 있도록 `ManagementGame` API를 위임한다.

`ScenarioRuntime.report()`에는 `throughServices`가 추가된다. 보고값은 구조화 복제본이므로 UI나 지도에서 값을 바꿔도 경영 엔진 원본은 변하지 않는다.

## API

- `createThroughService(route, input, infrastructureCatalog)`
- `reassessThroughService(throughServiceId, route, infrastructureCatalog)`
- `approveThroughService(throughServiceId)`
- `setThroughServiceStatus(throughServiceId, status)`
- `throughServiceReport(throughServiceId?)`
- `report().throughServices`

R1은 읽기 및 위임 경계까지만 담당한다. 직통 운행 전용 UI, 지도 편집, 3D 표시는 B12-5에서 구현한다.
