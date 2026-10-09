# B20-M1 광역 개발 프로그램 지도 계약

`transitline.regional-development-program/1`은 여러 B19 개발안과 기존 철도 계획을 한 장의 캠페인 프로그램에 **참조로만** 묶는다. 경영 프로그램의 상태와 ID는 B20-E1이 별도로 소유한다.

## 정본과 식별자

- `programId`는 `sourcePackId + key`로 결정된다. 이름, 목록의 입력 순서, 연결 대상의 상태는 바뀌어도 유지된다.
- `programRevision`은 플레이어가 적은 링크, 마일스톤의 순서·목표 월·기간, 정책·우선순위 변경에서만 바뀐다. 이름과 `linkFacts`의 측정 결과는 제외한다.
- `milestoneId`는 `programId + milestone key`로 결정된다.
- 편집 문서는 `transitline.regional-development-program` 문서이며, 삭제한 key는 묘비로 남는다. 다른 팩 문서는 현재 편집본을 바꾸지 않고 거절한다.

## 프로그램 필드

각 프로그램에는 `sourcePackId`, `sourcePackVersion`, `key`, `name`, `active`, 프로그램 수준의 네 링크 목록(`linkedDevelopmentIds`, `linkedPlanIds`, `linkedStationSiteIds`, `linkedServicePlanIds`), `playerStatedPolicy`, `playerStatedPriority`, `milestones`, `linkFacts`, `unknown`, `unknownReasons`, `warnings`, `license`가 있다.

마일스톤에는 `key`, `sequence`, `name`, `targetMonth`, `durationMonths`, 그리고 같은 네 링크 목록이 있다. `targetMonth`와 `durationMonths`는 0 이상의 정수 또는 `null`이다. 캠페인 월은 기존 30일 경영 월이고, 12개월은 표시상 1년이다.

`null` 링크 목록은 플레이어가 적지 않았다는 뜻이고 `[]`는 없다고 명시한 뜻이다. `targetMonth: 0`은 명시된 첫 월이며 `null`은 미상이다.

## linkFacts

각 링크는 `{ refKind, refId, milestoneId, found, geometryStatus, referencedRevision }`이다. `milestoneId: null`은 프로그램 수준 링크다.

- `found: true`는 참조 컬렉션에서 찾은 사실, `false`는 제공된 컬렉션에 없음, `null`은 컬렉션 자체가 주어지지 않았다는 뜻이다.
- `geometryStatus`는 `current`, `inactive`, `other-pack`, `missing` 중 하나다. 이는 가능 여부 판정이 아니다.
- B19 development export, plan export, station site 목록, service plan 목록은 각각 선택 입력이다. 입력하지 않은 컬렉션은 `unknown`과 `reference-collection-not-provided` 이유를 낸다.

## 금지 경계

이 계약은 비용, 인구, 수요, 승객, 운임, 용량, 혼잡, 점수, 성공 가능성, 시간표를 계산하거나 저장하지 않는다. 시간을 전진시키거나 이벤트·원장·난수를 쓰지 않는다. B15의 demand node·access link·allocation link는 읽거나 바꾸지 않는다.

## API

```js
buildRegionalDevelopmentProgram(drawnProgram, context)
buildRegionalDevelopmentProgramExport({ pack, programs, newTownDevelopmentExport, mapExport, stationSites, servicePlans })
```

문서 API는 `newRegionalDevelopmentProgramDoc`, `addRegionalDevelopmentProgram`, `addRegionalDevelopmentMilestone`, `update...`, `reorder...`, `serializeRegionalDevelopmentProgramDoc`, `restoreRegionalDevelopmentProgramDoc`, `drawnRegionalDevelopmentProgramsOf`다.

E1은 `programId`, `programRevision`, source pack, milestone ID와 지도 참조만 받아 별도 `campaign-program:N` 기록을 만든다. `linkFacts`가 current라고 해서 자동 채택하거나 다음 단계로 전진해서는 안 된다.
