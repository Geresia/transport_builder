# 외부 철도 기술사양 출력 계약 (지도·팩 → 경영 엔진)

기존망(외부 철도)의 **노선 하나**가 가진 기술적 사실을, 출처와 함께 경영 엔진에 넘기는 계약이다. 궤간·집전·전압·차량한계·신호·승강장·편성·정비체계와 인프라 소유자만 담는다. 이 값으로 차량이 달릴 수 있는지, 개조가 필요한지, 비용·공기·승인·선로사용계약은 어떤지는 **경영 엔진**(`management/technical-compatibility.mjs`)이 판단한다. 이 코드는 그 값을 만들지 않고 `management`를 import하지도 않는다(테스트가 검사). 결측·ID 규칙은 [through-route-contract.md](through-route-contract.md), [depot-site-contract.md](depot-site-contract.md)와 같은 방식이다.

연결 관계는 이렇다.

```
ExternalNetwork 노선 ──(externalNetworkId + externalLineId)── ExternalRailSpecification
ThroughRouteGeometry 의 external leg ──(같은 두 키, legId)──── ExternalInfrastructureCatalog 항목
```

## 코드 위치

| 파일 | 역할 |
|---|---|
| `engine/src/map/external-rail-technical-specification.mjs` | 진입점 `buildExternalRailSpecificationExport()` / `buildExternalRailSpecification()`, 직통 경로 연결 `buildExternalInfrastructureCatalog()`, 저장 문서 `newExternalRailSpecificationDoc` / `serializeExternalRailSpecificationDoc` / `restoreExternalRailSpecificationDoc` |
| `engine/test/external-rail-technical-specification.test.mjs` | 계약 테스트와 예제 검증 |
| `scripts/build-external-rail-technical-examples.mjs` | 예제 생성(`npm run external-rail-technical-examples`). 시계·난수를 쓰지 않아 다시 만들면 바이트 단위로 같다 |
| `packs/<id>/external-rail-technical-examples/*.spec.json`, `*.catalog.json` | 예제 |

## 입력 (출처가 말한 것)

```js
{ externalNetworkId, externalLineId, name?,
  sources: [{
    sourceId, kind, name, license,              // 필수. 하나라도 없으면 그 출처는 무시하고 source-invalid 경고
    attribution?, reference?, note?, quality?,  // quality: high|medium|low, 없으면 low
    facts: { <기술 사실 15개>, infrastructureOwnerId?, technicalProfileId?, status?, capacityTrainsPerHour? },
    notApplicable?: ["gaugeMm"]                 // "이 값은 이 노선에 적용되지 않는다"는 출처의 진술
  }] }
```

- `kind`: `survey`, `operator-publication`, `government-dataset`, `community-dataset`, `synthetic-fixture`.
- 노선당 항목은 하나다. 같은 노선에 항목이 둘이면 **둘 다 거절**한다(`duplicate-external-line-specification`). 어느 쪽이 이기는지는 입력 순서에 달리기 때문이다.
- 팩의 `ExternalNetwork`에 없는 망·노선이면 거절한다(`external-network-unresolved`, `external-line-unresolved`).

## 출력 `ExternalRailTechnicalSpecification`

`schema: "transitline.external-rail-technical-specification/1"`, `contractVersion: 1`. `buildExternalRailSpecificationExport()`는 `{ schema: "transitline.external-rail-technical-specification-export/1", packId, packVersion, specifications[], warnings[] }`를 낸다(`specificationId` 순).

| 분류 | 필드 |
|---|---|
| 연결 | `specificationId`, `specificationRevision`, `externalNetworkId`, `externalLineId`, `sourcePackId`, `sourcePackVersion`, `infrastructureOwnerId` |
| 표시 | `name`(ID·revision에 쓰이지 않음) |
| 기술 사실 | `technicalSpecification{ runningSystemId, gaugeMm, carWidthM, maxAxleLoadTonnes, collectionSystemId, currentSystem, voltageV, minimumCurveRadiusMeters, maxGradientPermille, signalSystemIds, platformHeightMm, doorLayoutId, minCars, maxCars, maintenanceSystemId }` |
| 출처가 명시한 때만 | `technicalProfileId`, `status`, `capacityTrainsPerHour` |
| 적용 안 됨 | `notApplicable[]`(현재 `gaugeMm`만) |
| 출처 추적 | `fieldSources{필드: [sourceId…]}`, `conflicts[{field, values[{sourceId, value}]}]`, `sources[{sourceId, kind, name, license, attribution, reference, note, quality, facts[], notApplicable[]}]` |
| 자료 | `dataQuality`, `unknown[]`, `unknownReasons{필드: 사유}`, `warnings[]`, `license{pack, attribution}` |

값의 형식: 문자열 ID는 비어 있지 않은 문자열, 숫자는 유한한 양수(`maxGradientPermille`은 0 이상, `minCars`/`maxCars`는 1 이상의 정수), `signalSystemIds`는 비어 있지 않은 문자열 목록(정렬된 집합). 형식이 틀리면 **변환하지 않고** 그 출처는 그 필드를 말하지 않은 것으로 보며 `invalid-value` 경고를 남긴다(`"1067"`을 1067로 바꾸지 않는다). 식별자 값(`steel-wheel`, `overhead`, `ats-p` 등)은 자유 문자열이고 경영 쪽 어휘와 맞추는 일은 경영 엔진 연결 단계의 몫이다.

## 결측 규칙: 알 수 없는 것은 null이다

출처가 말하지 않은 값은 **0·false·`[]`·"일본 철도의 보통 값"이 아니라 `null`**, 이름은 `unknown[]`에, 사유는 `unknownReasons`에 적는다. `unknown[]`의 모든 항목에 사유가 있고 그 역도 성립한다(테스트가 검사). `signalSystemIds`는 모르면 `[]`이 아니라 `null`이며, 빈 목록을 받으면 "신호체계 없음"으로 읽지 않고 `invalid-value`로 거절한다. 운영사 태그를 소유자로 추정하지 않으며 "일본이니 1067 mm" 같은 기본값도 없다.

| 사유 | 뜻 |
|---|---|
| `no-source` | 이 노선에 출처가 하나도 없다 |
| `no-attribute` | 출처는 있으나 이 속성을 말하지 않는다(명시적 `null` 포함) |
| `conflicting-sources` | 출처들이 서로 다른 값을 말한다. 어느 쪽도 고르지 않고 `null`, `conflicts`와 경고 `source-values-conflict`를 남긴다 |
| `invalid-value` | 말했지만 형식이 틀렸다(문자열 숫자, 0 이하, 빈 목록, 최소>최대 편성) |

`external-network-unresolved`는 속성 사유가 아니라 연결 실패 코드다(위 거절 참조). 출처의 적용 범위 밖이라는 뜻의 `outside-coverage`는 구현하지 않았다.

### 적용되지 않는 값 (`notApplicable`)

고무차륜 안내궤도(AGT)나 모노레일에는 궤간이 없다. 이것을 "모름"과 섞지 않도록, 출처가 `notApplicable: ["gaugeMm"]`을 명시하면 `gaugeMm`은 `null`이되 `unknown[]`에는 들어가지 않고 `notApplicable`에 오른다. 값과 적용 안 됨을 함께 말하는 출처가 있으면 충돌이다. 지도는 주행방식에서 이를 **추정하지 않는다**(출처가 말해야 한다). 철제차륜 노선의 `gaugeMm: null`은 모름이다.

### 충돌

같은 값을 말하는 출처가 여럿이면 합의(`fieldSources`에 모두 기록)이고, 값이 하나라도 다르면 충돌이다. 목록은 정렬된 집합으로 비교하므로 순서만 다른 목록은 같은 값이다. 네트워크 자료가 말한 소유자(`infrastructureOwnerId`)도 하나의 출처로 합쳐지며 다른 출처와 다르면 충돌이다.

## 품질

`dataQuality`는 미상 개수(기술 사실 15개 + 소유자; 프로필·상태·용량은 흔히 공개되지 않아 세지 않음)로 정하고, 값을 준 출처의 `quality`가 더 나쁘면 그것을 따른다. 출처가 품질을 말하지 않으면 `low`, `synthetic-fixture`는 항상 `low`다. 미상이 하나라도 있으면 `high`가 아니다.

## ID와 revision

- `specificationId` = 팩 ID + `externalNetworkId` + `externalLineId`. 노선 이름·입력 순서·출처 순서와 무관하다.
- `specificationRevision` = `specificationId` + **사실**(기술 사양 15개, 소유자, 프로필·상태·용량, `notApplicable`, `conflicts`). 표시 이름이나 출처 이름·참조·메모를 바꿔도 그대로이고, 값이 바뀌거나 적용 안 됨이 모름으로 바뀌면 달라진다.

## 직통 경로 연결 `ExternalInfrastructureCatalog`

`buildExternalInfrastructureCatalog({ specificationExport, routeExport })`는 `ThroughRouteGeometry`의 **external leg**를 `externalNetworkId` + `externalLineId`로 사양에 잇는다. 경영 엔진의 `infrastructureCatalog`가 읽는 형태다.

```js
{ schema: "transitline.external-infrastructure-catalog/1", packId, packVersion, entries: [{
    legId, throughRouteId, routeGeometryRevision,
    externalNetworkId, externalLineId, specificationId, specificationRevision,
    infrastructureOwnerId, technicalProfileId,           // 원천이 명시한 경우에만, 아니면 null
    technicalSpecification: { …기술 사실 15개 },
    notApplicable, status, capacityTrainsPerHour,        // 자료가 없으면 null
    unknown, unknownReasons
  }], unmatchedLegIds: [], warnings: [] }
```

- 사양이 없는 external leg는 항목을 만들지 않고 `unmatchedLegIds`에 올린다. 빈 항목을 채우지 않는다.
- 소유자는 사양의 소유자를 쓰고, 없으면 leg가 말한 소유자를 쓴다. 둘이 다르면 `null` + `leg-owner-conflicts-specification` 경고다.
- 다른 팩의 경로는 건너뛰고 `route-other-pack` 경고를 남긴다.
- 판정·점수·비용·승인·계약 필드는 없다. 테스트가 모든 키 이름을 검사한다.

## 저장 문서

`{ version: 1, packId, packVersion, specifications[] }`. `restoreExternalRailSpecificationDoc()`은 다른 팩의 저장본을 적용하지 않고(`external-rail-spec-doc-other-pack`, 빈 문서 반환), 팩 버전이 다르면 경고(`pack-version-mismatch`)하며, 읽을 수 없거나 버전이 다르면 빈 문서(`…-unreadable` / `…-version`)를 돌려준다.

## 경고와 거절

거절(사양을 만들지 않음): `spec-entry-invalid`, `external-network-unresolved`, `external-line-unresolved`, `duplicate-source-id`, `duplicate-external-line-specification`. 경고(사양은 만듦): `source-invalid`, `unknown-fact-field`(알려진 필드가 아니면 무시. `cost`나 `retrofitRequired` 같은 경영 필드도 여기서 걸러짐), `invalid-value`, `cars-range-invalid`, `not-applicable-field-invalid`, `source-values-conflict`.

## 예제

| 팩 | 파일 | 내용 |
|---|---|---|
| tokyo | `01-toei-shinjuku-wikidata-partial` | **실제 자료.** 도에이 신주쿠선의 궤간 1372 mm, 전압 1500 V, 직류, 가공선 집전만 Wikidata 인용으로 입력. 나머지는 모두 `null` |
| tokyo | `02-minatomirai-no-technical-data` | 실제 노선, 출처 없음: 전부 `null`(`no-source`) |
| tokyo | `01-east-river-koto.catalog.json` | 도쿄 직통 경로 예제 두 개의 외부 구간(신주쿠선)을 위 사양에 잇는 카탈로그 |
| example-radial | `01-fully-verified-steel-wheel` | 일반 철제차륜, 기술 사실 15개와 소유자가 모두 확인됨 |
| example-radial | `02-gauge-only` | 궤간만 확인, 신호·승강장 자료 없음 |
| example-radial | `03-multiple-signal-systems` | 신호체계 두 개가 명시됨 |
| example-radial | `04-third-rail` | 제3궤조 750 V 직류 |
| example-radial | `05-conflicting-sources` | 두 출처가 궤간·신호를 다르게 말함 → `null` + 충돌 |
| example-radial | `06-agt-gauge-not-applicable` | AGT, 궤간 적용 안 됨 |
| example-corridor | `01-no-technical-data` | 출처 없음 |
| example-corridor | `02-monorail-gauge-not-applicable` | 모노레일, 궤간 적용 안 됨, 소유자 미상 |

예제 생성 규칙: **합성 팩에는 기존망이 없으므로** `radial`·`corridor` 예제는 자기 안에 작은 **픽스처 기존망**(`source.fixtureExistingNetwork`)을 담고, 모든 출처를 `synthetic-fixture`로 표시한다. 이 값들은 계약을 시험하려고 지어낸 것이며 실제 철도 사실이 아니다. 도쿄만 실제 노선을 쓰고, 출처가 확인한 값 외에는 넣지 않았다.

### 사용한 실제 자료 (도쿄 예제)

| 값 | 자료 | 라이선스 |
|---|---|---|
| 궤간 1372 mm | Wikidata Q1374502(도에이 신주쿠선) `P1064` → Q5365683 "Scotch gauge"의 `P2049` = 1372 mm (개정 2526575441, 1924438618) | CC0 1.0 |
| 전압 1500 V, 가공선 집전 | 같은 항목 `P930` → Q21253457의 `P2436` = 1500 V, `P2283` → Q110701 "overhead contact line" (개정 2537140511) | CC0 1.0 |
| 직류 | Q21253457의 영문 라벨 "1500 V DC railway electrification" | CC0 1.0 |
| 노선 식별 | OSM 관계 443259의 `wikidata=Q1374502` 태그 | ODbL-1.0 |

조회일은 2026-10-03이다. Wikidata의 `P1064`·`P930` 진술에는 참조가 없어서 출처 품질을 `low`로 적었다. 직류는 구조화된 값이 아니라 항목 라벨의 문자열에서 읽었다는 점을 출처 메모에 남겼다.

## 알려진 한계

- 팩의 `existing-network.json`에는 기술 속성이 하나도 없다(노선당 `color, kind, name, name_en, network, operator, osmRelationId, stationIds`뿐). 실제 기술사양을 담은 것은 도에이 신주쿠선의 네 값이 전부이고, 나머지 194개 노선은 전부 `null`이다.
- 식별자 어휘(`steel-wheel`, `ats-p` 등)는 검증하지 않는다. Wikidata의 개념(예: "overhead contact line")을 게임 어휘(`overhead`)로 옮기는 것은 입력하는 쪽의 매핑이다.
- 구간 안의 값 변화(구간마다 궤간·곡선이 다름)는 노선 단위 한 값으로만 담는다. 직통 경로의 일부 구간만 쓰는 경우도 노선 전체의 사양을 준다.
- `status`·`capacityTrainsPerHour`·`technicalProfileId`는 출처가 명시할 때만 채운다. 현재 예제에는 이 값을 명시한 출처가 없다.
- 소유자 필드는 팩에 없고 예제에서도 합성 팩(가상 `owner:fixture-*`)에만 있다.
