import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { getStore } from '@netlify/blobs';

const NOTION_VERSION = '2026-03-11';
const SLOTS = new Set(['1타임', '2타임', '3타임', '그 외']);
const SCORE_PROPERTIES = ['활동 이해', '안내 준수', '활동 범위 확인', '찾기 기록'];
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
  return { rich_text: value ? [{ text: { content: value } }] : [] };
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

async function notionRequest(path, method, body, token) {
  const response = await fetch(`https://api.notion.com/v1/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Notion-Version': NOTION_VERSION,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => null);
    console.error('Notion request failed', response.status, error?.code);
    throw Object.assign(new Error('Notion request failed'), { notionStatus: response.status });
  }
  return response.json();
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
  const otherCode = slot === '그 외' ? text(input.otherCode, 40) : '';
  const name = text(input.name, 80);
  const findings = count(input.findings);
  const organizer = input.role === 'organizer';

  if (!organizer && input.role !== 'participant') {
    return reply(400, { error: '주관자 또는 활동자 양식을 선택해 주세요.' });
  }
  if (!validDate(date) || !SLOTS.has(slot) || !name || findings === null) {
    return reply(400, { error: '활동일, 활동 시간, 성명과 찾기 건수를 확인해 주세요.' });
  }
  if (slot === '그 외' && (!otherCode || otherCode.includes('|'))) {
    return reply(400, { error: '안내받은 추가 회차 코드를 확인해 주세요.' });
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
    saveReport = sessionId => notionRequest(`pages/${sessionId}`, 'PATCH', {
      properties: {
        '주관자 이름': richText(name),
        '실제 참여 인원': { number: headcount },
        '전체 찾기 건수': { number: findings },
        '변경·지연·누락 사유': richText(text(input.changes, 1500)),
        '특이사항': richText(text(input.notes, 1500)),
        '주관자 제출 완료': { checkbox: true },
      },
    }, token);
  } else {
    const scores = SCORE_PROPERTIES.map((_, index) => count(input[`score${index + 1}`]));
    if (scores.some(score => score === null || score < 1 || score > 5)) {
      return reply(400, { error: '체크리스트 문장마다 1~5 중 하나를 골라 주세요.' });
    }
    const scoreValues = Object.fromEntries(
      SCORE_PROPERTIES.map((property, index) => [property, { number: scores[index] }]),
    );
    saveReport = sessionId => notionRequest('pages', 'POST', {
      parent: { type: 'data_source_id', data_source_id: participantsSource },
      properties: {
        '응답명': { title: [{ text: { content: name } }] },
        '타임': { relation: [{ id: sessionId }] },
        '본인 찾기 건수': { number: findings },
        '건의사항': richText(text(input.suggestions, 1500)),
        ...scoreValues,
      },
    }, token);
  }

  const key = [date, slot, otherCode].filter(Boolean).join(' | ');
  try {
    const sessionId = await getOrCreateSession(key, sessionsSource, token);
    await saveReport(sessionId);
    return reply(200, { ok: true });
  } catch (error) {
    if (error instanceof SessionLookupError) return reply(error.status, { error: error.message });
    return reply(502, { error: '노션에 저장하는 중 오류가 발생했어요. 잠시 후 다시 시도해 주세요.' });
  }
}
