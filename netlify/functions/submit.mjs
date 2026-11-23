import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { getStore } from '@netlify/blobs';
import {
  organizerResponses, ORGANIZER_BODY_MARKER, queueDailyAnalysis, SCORE_PROPERTIES,
} from '../lib/daily-analysis.mjs';
import { notionRequest } from '../lib/notion.mjs';

const SLOTS = new Set(['1타임', '2타임', '3타임', '4타임', '그 외']);
const CLOCK_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const OMEGA3_ITEMS = [
  ['omega3AfterReport', '사후'],
  ['omega3Tm', '티엠'],
  ['omega3Prayer', '기도'],
];
const LEGACY_SCORE_QUESTIONS = [
  '활동을 시작하기 전에 오늘 할 일을 이해했다.',
  '안내받은 순서에 따라 활동했다.',
  '맡은 활동 범위를 끝까지 확인했다.',
  '찾은 내용을 빠짐없이 기록했다.',
];
const SCORE_QUESTIONS = [
  '나는 오늘 멘트가 준비 된 상태로 활동에 임하였다.',
  '나는 오늘 묵상 어록 나눔대로 활동에 임하였다.',
  '나는 오늘 내 활동에서 복기해야 할 부분에 대해 자가 피드백이 되었다.',
  '찾은 내용을 빠짐없이 기록했다.',
];
const SCORE_EXAMPLE = '*Ex) 자가피드백(잘한 점,부족한 점, 개선할 점과 실행할 점)';
const SESSION_RESERVATION_MS = 90_000;
const SESSION_WAIT_MS = 15_000;

class SessionLookupError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function reply(status, body) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

function text(value, limit) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, limit);
}

function count(value) {
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function richText(value) {
  // Notion limits each rich-text item's content to 2,000 characters.
  const parts = value.match(/.{1,2000}/gsu) ?? [];
  return { rich_text: parts.map(content => ({ text: { content } })) };
}

function block(type, value, options) {
  return { type, [type]: { ...richText(value), ...options } };
}

function omega3Details(input) {
  return [
    block('heading_2', '오메가-3'),
    ...OMEGA3_ITEMS.map(([field, label]) => block('to_do', label, { checked: input[field] === 'on' })),
  ];
}

function reportDetails(date, slot, roleLabel, timeRanges, name, results) {
  const bullet = value => block('bulleted_list_item', value);
  const times = timeRanges?.map(({ start, end }) => `${start} - ${end}`).join('\n');
  return [
    block('heading_2', '상세내역'),
    { type: 'divider', divider: {} },
    block('heading_3', '1️⃣ 활동 정보'),
    bullet(`활동일: ${date}`),
    bullet(`${roleLabel} 타임: ${slot}`),
    ...(times ? [bullet(`${roleLabel} 시간: ${times}`)] : []),
    bullet(`${roleLabel}자 이름: ${name}`),
    block('heading_3', '2️⃣ 활동 결과'),
    ...results.map(bullet),
  ];
}

function organizerDetails(date, slot, timeRanges, name, headcount, findings, changes, notes, omega3) {
  const details = reportDetails(date, slot, '주관', timeRanges, name, [
    `활동 인원수: ${headcount}명`, `전체 찾기 건수: ${findings}건`,
  ]);
  // Tag only our synced block so resubmissions never replace hand-written page sections.
  details[0].heading_2.rich_text.push({
    type: 'text', text: { content: '\u2063', link: { url: ORGANIZER_BODY_MARKER } },
  });
  const noteSection = (title, value) => block('heading_3', title, {
    is_toggleable: true, children: [block('paragraph', value || '없습니다.')],
  });
  return [
    ...details,
    block('heading_2', '활동 변경 지연/누락 사유'),
    { type: 'divider', divider: {} },
    noteSection('활동 변경 지연/누락 사유', changes),
    noteSection('특이사항', notes),
    ...omega3,
    block('heading_2', '활동자 사후내역'),
    ...organizerResponses([]),
  ];
}

function participantDetails(date, slot, timeRanges, name, findings, scores, suggestions, omega3) {
  const questions = timeRanges ? SCORE_QUESTIONS : LEGACY_SCORE_QUESTIONS;
  return [
    ...reportDetails(date, slot, '활동', timeRanges, name, [`찾기 건수: ${findings}건`]),
    block('bulleted_list_item', '체크리스트 내역', {
      children: questions.map((question, index) => {
        const example = timeRanges && index === 2 ? `\n${SCORE_EXAMPLE}` : '';
        return block('bulleted_list_item', `${question} : ${scores[index]}점${example}`);
      }),
    }),
    block('bulleted_list_item', `건의사항: ${suggestions || '없습니다.'}`),
    ...omega3,
  ];
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validTimeRange(range) {
  const { start, end } = range ?? {};
  return typeof start === 'string' && typeof end === 'string' &&
    CLOCK_TIME.test(start) && CLOCK_TIME.test(end) && start < end;
}

async function findSession(key, source, token) {
  const matches = await notionRequest(`data_sources/${source}/query`, 'POST', {
    filter: { property: '타임 키', rich_text: { equals: key } },
    page_size: 2,
  }, token);

  if (matches.results.length > 1 || matches.has_more) {
    throw new SessionLookupError(409, '같은 타임이 여러 개 등록되어 있어요. 운영 담당자에게 알려주세요.');
  }
  return matches.results[0]?.id;
}

async function getOrCreateSession(key, source, token) {
  const existingId = await findSession(key, source, token);
  if (existingId) return existingId;

  const store = getStore({ name: 'notion-session-creation', consistency: 'strong' });
  const reservationKey = `${source}/${key}`;
  const deadline = Date.now() + SESSION_WAIT_MS;

  while (Date.now() < deadline) {
    const entry = await store.getWithMetadata(reservationKey, { type: 'json' });
    if (entry?.data.expiresAt > Date.now()) {
      if (entry.data.sessionId) return entry.data.sessionId;
      await wait(350);
      continue;
    }

    // The lease outlasts a Netlify invocation, so a stopped creator cannot overlap its replacement.
    const reservation = await store.setJSON(reservationKey, {
      owner: randomUUID(),
      expiresAt: Date.now() + SESSION_RESERVATION_MS,
    }, entry ? { onlyIfMatch: entry.etag } : { onlyIfNew: true });
    if (!reservation.modified) continue;

    const owned = { onlyIfMatch: reservation.etag };
    let creatingPage = false;
    try {
      // Recheck after acquiring the lease in case another request already created the page.
      let sessionId = await findSession(key, source, token);
      if (!sessionId) {
        creatingPage = true;
        const page = await notionRequest('pages', 'POST', {
          parent: { type: 'data_source_id', data_source_id: source },
          properties: {
            '타임명': { title: [{ text: { content: key } }] },
            '타임 키': richText(key),
          },
        }, token);
        sessionId = page.id;
      }
      await store.setJSON(reservationKey, {
        sessionId,
        expiresAt: Date.now() + SESSION_RESERVATION_MS,
      }, owned);
      return sessionId;
    } catch (error) {
      // After an uncertain Notion write, leave time for the page to become visible before retrying creation.
      if (!creatingPage || [400, 401, 403, 404, 429].includes(error.notionStatus)) {
        await store.setJSON(reservationKey, { expiresAt: 0 }, owned).catch(() => {});
      }
      throw error;
    }
  }

  const sessionId = await findSession(key, source, token);
  if (sessionId) return sessionId;
  throw new SessionLookupError(503, '이 타임의 저장을 준비 중이에요. 잠시 후 다시 제출해 주세요.');
}

async function saveOrganizerReport(sessionId, properties, body, token) {
  const store = getStore({ name: 'notion-organizer-report', consistency: 'strong' });
  const entry = await store.getWithMetadata(sessionId, { type: 'json' });
  const busy = new SessionLookupError(409, '이 타임의 주관자 보고를 저장 중이에요. 잠시 후 다시 제출해 주세요.');
  if (entry?.data.expiresAt > Date.now()) throw busy;

  const lease = await store.setJSON(sessionId, { expiresAt: Date.now() + SESSION_RESERVATION_MS },
    entry ? { onlyIfMatch: entry.etag } : { onlyIfNew: true });
  if (!lease.modified) throw busy;

  try {
    await notionRequest(`pages/${sessionId}`, 'PATCH', { properties }, token);

    const childrenPath = `blocks/${sessionId}/children`;
    const previousReports = [];
    let cursor;
    do {
      const query = new URLSearchParams({ page_size: '100' });
      if (cursor) query.set('start_cursor', cursor);
      const page = await notionRequest(`${childrenPath}?${query}`, 'GET', undefined, token);
      for (const child of page.results) {
        if (child.type === 'callout' && child.callout.rich_text[0]?.plain_text === '주관자 사후 내용') {
          previousReports.push(child.id);
        }
        if (child.type === 'synced_block' && child.synced_block.synced_from === null && child.has_children) {
          const preview = await notionRequest(`blocks/${child.id}/children?page_size=1`, 'GET', undefined, token);
          const heading = preview.results[0]?.heading_2;
          if (heading?.rich_text.some(item => item.href === ORGANIZER_BODY_MARKER)) previousReports.push(child.id);
        }
      }
      cursor = page.next_cursor;
    } while (cursor);

    const [heading, ...details] = body;
    const report = await notionRequest(childrenPath, 'PATCH', { children: [{
      type: 'synced_block', synced_block: { synced_from: null, children: [heading] },
    }] }, token);
    await notionRequest(`blocks/${report.results[0].id}/children`, 'PATCH', { children: details }, token);
    for (const previousId of previousReports) {
      await notionRequest(`blocks/${previousId}`, 'PATCH', { in_trash: true }, token);
    }
  } finally {
    await store.setJSON(sessionId, { expiresAt: 0 }, { onlyIfMatch: lease.etag }).catch(() => {});
  }
}

export default async function submit(request) {
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  }
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    return reply(415, { error: '지원하지 않는 제출 형식이에요.' });
  }

  let input;
  try {
    const body = await request.text();
    if (body.length > 12000) return reply(413, { error: '입력 내용이 너무 길어요.' });
    input = JSON.parse(body);
  } catch {
    return reply(400, { error: '제출 내용을 읽을 수 없어요.' });
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return reply(400, { error: '제출 형식을 확인해 주세요.' });
  }

  const date = text(input.date, 20);
  const slot = text(input.slot, 20);
  const name = text(input.name, 80);
  const findings = count(input.findings);
  const organizer = input.role === 'organizer';
  const { timeRanges } = input;

  if (!organizer && input.role !== 'participant') {
    return reply(400, { error: '주관자 또는 활동자 양식을 선택해 주세요.' });
  }
  const slotIsValid = SLOTS.has(slot) && (!organizer || timeRanges === undefined || slot !== '4타임');
  if (!validDate(date) || !slotIsValid || !name || findings === null) {
    return reply(400, { error: '활동일, 타임, 성명과 찾기 건수를 확인해 주세요.' });
  }
  // Earlier form versions submit the original checklist without any time fields.
  if (timeRanges !== undefined && (!Array.isArray(timeRanges) || !timeRanges.length ||
      (organizer && timeRanges.length !== 1) || !timeRanges.every(validTimeRange))) {
    const label = organizer ? '주관 시간' : '활동 시간';
    return reply(400, { error: `${label}을 확인해 주세요. 종료 시간은 시작 시간보다 늦어야 해요.` });
  }
  const token = process.env.NOTION_TOKEN;
  const sessionsSource = process.env.NOTION_SESSIONS_DATA_SOURCE_ID;
  const participantsSource = process.env.NOTION_PARTICIPANTS_DATA_SOURCE_ID;
  if (!token || !sessionsSource || (!organizer && !participantsSource)) {
    return reply(503, { error: '아직 저장이 연결되지 않았어요. 운영 담당자에게 알려주세요.' });
  }

  let saveReport;
  if (organizer) {
    const headcount = count(input.headcount);
    if (headcount === null) return reply(400, { error: '활동 인원 수를 확인해 주세요.' });
    const changes = text(input.changes, 1500);
    const notes = text(input.notes, 1500);
    const properties = {
      '주관자 이름': richText(name),
      '실제 참여 인원': { number: headcount },
      '전체 찾기 건수': { number: findings },
      '변경·지연·누락 사유': richText(changes),
      '특이사항': richText(notes),
      '주관자 제출 완료': { checkbox: true },
    };
    const omega3 = omega3Details(input);
    const body = organizerDetails(date, slot, timeRanges, name, headcount, findings, changes, notes, omega3);
    saveReport = sessionId => saveOrganizerReport(sessionId, properties, body, token);
  } else {
    const scores = SCORE_PROPERTIES.map((_, index) => count(input[`score${index + 1}`]));
    if (scores.some(score => score === null || score < 1 || score > 5)) {
      return reply(400, { error: '체크리스트 문장마다 1~5 중 하나를 골라 주세요.' });
    }
    const scoreValues = Object.fromEntries(
      SCORE_PROPERTIES.map((property, index) => [property, { number: scores[index] }]),
    );
    const suggestions = text(input.suggestions, 1500);
    const omega3 = omega3Details(input);
    saveReport = sessionId => notionRequest('pages', 'POST', {
      parent: { type: 'data_source_id', data_source_id: participantsSource },
      properties: {
        title: { title: [{ text: { content: name } }] },
        '타임': { relation: [{ id: sessionId }] },
        '본인 찾기 건수': { number: findings },
        '건의사항': richText(suggestions),
        ...scoreValues,
      },
      children: participantDetails(date, slot, timeRanges, name, findings, scores, suggestions, omega3),
    }, token);
  }

  const key = `${date} | ${slot}`;
  try {
    const sessionId = await getOrCreateSession(key, sessionsSource, token);
    await saveReport(sessionId);
    await queueDailyAnalysis(date, sessionId).catch(() => console.error('Could not queue daily analysis'));
    return reply(200, { ok: true });
  } catch (error) {
    if (error instanceof SessionLookupError) return reply(error.status, { error: error.message });
    return reply(502, { error: '노션에 저장하는 중 오류가 발생했어요. 잠시 후 다시 시도해 주세요.' });
  }
}
