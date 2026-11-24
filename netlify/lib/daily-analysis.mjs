import { createHash, randomUUID } from 'node:crypto';
import { getStore } from '@netlify/blobs';
import { ACTIVITY_JOURNAL_TITLE, formatActivityJournal, saveActivityJournal } from './activity-journal.mjs';
import { notionRequest } from './notion.mjs';
import { CURRENT_SCORE_PROPERTIES, SCORE_PROPERTIES } from './report-checklist.mjs';

export { SCORE_PROPERTIES };

const LEGACY_CHECKLIST = { properties: SCORE_PROPERTIES, maximum: 5 };
const CURRENT_CHECKLIST = { properties: CURRENT_SCORE_PROPERTIES, maximum: 3 };
const TOPICS = [
  ['집결·장소 안내', /집결|장소|위치|길 안내|주소/],
  ['시간·일정', /지연|늦|일정|시간|연기/],
  ['진행 절차', /순서|절차|진행|역할|분담/],
  ['활동 범위', /범위|구역|누락|빠뜨/],
  ['기록·공유', /기록|사진|공유|예시|보고/],
  ['장비·준비물', /장비|준비물|물품|도구/],
  ['안전·기상', /안전|날씨|기상|우천/],
];
const MARKER = 'https://havefunsam.netlify.app/#daily-ai-analysis';
export const ORGANIZER_BODY_MARKER = 'https://havefunsam.netlify.app/#generated-organizer-report';
const RESPONSES_MARKER = 'https://havefunsam.netlify.app/#linked-participant-reports';
const PRODUCTION_ANALYSIS_PAGE_ID = '8de5b0d49df448308221bf88cbef18df';
const PRODUCTION_JOURNAL_PAGE_ID = '421ad3bf99578155b45dfef59c50ab3e';
const PENDING = 'pending/';
const LOCK = 'worker';

function store() {
  return getStore({ name: 'daily-analysis', consistency: 'strong' });
}

export async function queueDailyAnalysis(date, sessionId) {
  const queue = store();
  const key = `${PENDING}${date}/${sessionId}/${randomUUID()}`;
  try {
    await queue.set(key, '');
  } catch {
    await queue.set(key, '');
  }
}

const value = (page, name, type) => page.properties[name]?.[type];
const plain = (page, name) => (value(page, name, 'rich_text') ?? []).map(item => item.plain_text).join('');
const number = (page, name) => value(page, name, 'number') ?? null;
const average = values => values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length * 100) / 100 : null;
const remarks = page => plain(page, '비고').trim() || plain(page, '건의사항').trim();

function checklistFor(page) {
  return CURRENT_SCORE_PROPERTIES.some(property => number(page, property) !== null)
    ? CURRENT_CHECKLIST
    : LEGACY_CHECKLIST;
}

function checklistScore(page, property, maximum) {
  const score = number(page, property);
  return Number.isInteger(score) && score >= 1 && score <= maximum ? score : null;
}

function checklistAverages(participants, { properties, maximum }) {
  const scores = properties.map(property => participants.map(page => checklistScore(page, property, maximum))
    .filter(score => score !== null));
  return {
    overall: average(scores.flat()),
    byQuestion: Object.fromEntries(scores.map((values, index) => [`${index + 1}번`, average(values)])),
  };
}

function countTopics(notes) {
  const counts = {};
  for (const note of notes) {
    if (!note.trim() || /^(없음|없습니다\.?|해당 없음)$/.test(note.trim())) continue;
    const topics = TOPICS.filter(([, pattern]) => pattern.test(note)).map(([label]) => label);
    for (const topic of topics.length ? topics : ['기타 의견']) counts[topic] = (counts[topic] ?? 0) + 1;
  }
  return counts;
}

export function collectDailyStats(sessions, participants) {
  const organizers = sessions.filter(page => value(page, '주관자 제출 완료', 'checkbox'));
  const byChecklist = Map.groupBy(participants, checklistFor);
  const legacyScores = checklistAverages(byChecklist.get(LEGACY_CHECKLIST) ?? [], LEGACY_CHECKLIST);
  const currentScores = checklistAverages(byChecklist.get(CURRENT_CHECKLIST) ?? [], CURRENT_CHECKLIST);
  const sum = (pages, name) => {
    const values = pages.map(page => number(page, name)).filter(Number.isFinite);
    return values.length ? values.reduce((a, b) => a + b, 0) : null;
  };
  return {
    sessions: sessions.length,
    organizers: organizers.length,
    headcount: sum(organizers, '실제 참여 인원'),
    organizerFindings: sum(organizers, '전체 찾기 건수'),
    participants: participants.length,
    participantFindings: sum(participants, '본인 찾기 건수'),
    scoreAverage: legacyScores.overall,
    questionAverages: legacyScores.byQuestion,
    currentScoreAverage: currentScores.overall,
    currentQuestionAverages: currentScores.byQuestion,
    organizerIssues: countTopics(organizers.map(page => plain(page, '변경·지연·누락 사유'))),
    organizerNotes: countTopics(organizers.map(page => plain(page, '특이사항'))),
    participantSuggestions: countTopics(participants.map(remarks)),
  };
}

async function notionPages(notion, source, filter) {
  const pages = [];
  let cursor;
  do {
    const result = await notion(`data_sources/${source}/query`, 'POST', {
      filter, page_size: 100, ...(cursor && { start_cursor: cursor }),
    });
    pages.push(...result.results);
    cursor = result.next_cursor;
  } while (cursor);
  return pages;
}

async function* childBlocks(notion, page) {
  let cursor;
  do {
    const query = new URLSearchParams({ page_size: '100' });
    if (cursor) query.set('start_cursor', cursor);
    const result = await notion(`blocks/${page}/children?${query}`);
    yield* result.results;
    cursor = result.next_cursor;
  } while (cursor);
}

async function analyze(stats, env) {
  const base = (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
  const response = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 450,
      system: '즐기삼 활동의 일별 집계와 주제 분류를 읽고, 확인된 경향과 다음 회차에서 확인할 사항을 한국어 3문장 이내로 작성하세요. 미제출과 0을 구별하세요. 주관자 전체 찾기와 활동자 본인 찾기를 더하지 마세요. 기존 5점 척도와 현재 3점 척도의 체크리스트 평균은 각각 해석하세요. 주제는 키워드 분류이므로 사건의 상세 내용이나 원인을 추측하지 마세요. 근거가 부족하면 그 사실을 적으세요.',
      messages: [{ role: 'user', content: JSON.stringify(stats) }],
    }),
    signal: AbortSignal.timeout(9000),
  });
  if (!response.ok) throw new Error(`AI Gateway request failed (${response.status})`);
  const output = (await response.json()).content.filter(block => block.type === 'text')
    .map(block => block.text).join('\n').trim();
  if (!output) throw new Error('AI Gateway returned empty analysis');
  return output.slice(0, 1800);
}

const text = (content, url) => ({ type: 'text', text: { content, ...(url && { link: { url } }) } });

export function organizerResponses(participants) {
  const heading = participants.length ? `활동자 응답 ${participants.length}건` : '연결된 활동자 응답이 아직 없습니다.';
  const groups = [[text('\u2063', RESPONSES_MARKER), text(heading)]];
  for (const [index, page] of participants.entries()) {
    if (index > 0 && index % 40 === 0) groups.push([text('\u2063', RESPONSES_MARKER)]);
    const title = Object.values(page.properties).find(property => property.type === 'title');
    const name = title?.title.map(item => item.plain_text).join('') || '활동자 응답';
    const findings = number(page, '본인 찾기 건수');
    const { properties, maximum } = checklistFor(page);
    const scores = properties.map((property, index) => {
      const score = checklistScore(page, property, maximum);
      return `${index + 1}번 ${score === null ? '미응답' : `${score}/${maximum}`}`;
    }).join(' · ');
    const note = remarks(page).slice(0, 1500) || '없음';
    const details = [
      `본인 찾기 ${findings === null ? '미입력' : `${findings}건`}`,
      `체크리스트 · ${scores}`,
      `비고 · ${note}`,
    ].join('\n');
    groups.at(-1).push(text(`\n\n• ${name.slice(0, 160)}`, page.url), text(`\n${details}`));
  }
  return groups.map(richText => ({ type: 'paragraph', paragraph: { rich_text: richText } }));
}

async function readOrganizerReport(notion, sessionId) {
  const wrapperIds = [];
  for await (const block of childBlocks(notion, sessionId)) {
    if (block.type === 'synced_block' && block.synced_block.synced_from === null && block.has_children) {
      wrapperIds.push(block.id);
    }
  }
  // The organizer writes the replacement before retiring the previous section.
  for (const wrapperId of wrapperIds.reverse()) {
    const blocks = [];
    for await (const block of childBlocks(notion, wrapperId)) blocks.push(block);
    if (blocks[0]?.heading_2?.rich_text.some(item => item.href === ORGANIZER_BODY_MARKER)) return { wrapperId, blocks };
  }
}

async function updateOrganizerResponses(notion, { wrapperId, blocks }, participants) {
  const existing = blocks.filter(block => block.paragraph?.rich_text[0]?.href === RESPONSES_MARKER);
  const updated = organizerResponses(participants);
  for (const [index, { paragraph }] of updated.slice(0, existing.length).entries()) {
    const oldBlock = existing[index];
    const displayed = oldBlock.paragraph.rich_text.map(item => [item.plain_text, item.href ?? null]);
    const next = paragraph.rich_text.map(item => [item.text.content, item.text.link?.url ?? null]);
    if (JSON.stringify(displayed) !== JSON.stringify(next)) {
      await notion(`blocks/${oldBlock.id}`, 'PATCH', { paragraph });
    }
  }
  const heading = blocks.find(block => block.heading_2?.rich_text[0]?.plain_text === '활동자 사후내역');
  const missing = updated.slice(existing.length);
  let after = existing.at(-1)?.id ?? heading?.id;
  for (let index = 0; after && index < missing.length; index += 100) {
    const added = await notion(`blocks/${wrapperId}/children`, 'PATCH', {
      position: { type: 'after_block', after_block: { id: after } },
      children: missing.slice(index, index + 100),
    });
    after = added.results.at(-1)?.id;
  }
  for (const stale of existing.slice(updated.length)) {
    await notion(`blocks/${stale.id}`, 'PATCH', { in_trash: true });
  }
}

function analysisBlock(stats, analysis, sessions, participants) {
  const unit = (count, suffix) => count === null ? '미집계' : `${count}${suffix}`;
  const checklist = (score, averages, maximum) => {
    const suffix = `/${maximum}`;
    const questions = Object.entries(averages).map(([key, value]) => `${key} ${unit(value, suffix)}`).join(' · ');
    return `체크리스트 평균 (${maximum}점 척도) ${unit(score, suffix)}\n${questions}`;
  };
  const totals = [
    `타임 ${stats.sessions}개 · 주관자 제출 ${stats.organizers}건 · 활동자 응답 ${stats.participants}건`,
    `실제 참여 ${unit(stats.headcount, '명')} · 주관자 전체 찾기 ${unit(stats.organizerFindings, '건')} · 활동자 본인 찾기 ${unit(stats.participantFindings, '건')}`,
  ];
  if (stats.scoreAverage !== null || stats.currentScoreAverage === null) {
    totals.push(checklist(stats.scoreAverage, stats.questionAverages, LEGACY_CHECKLIST.maximum));
  }
  if (stats.currentScoreAverage !== null) {
    totals.push(checklist(stats.currentScoreAverage, stats.currentQuestionAverages, CURRENT_CHECKLIST.maximum));
  }
  const sources = [
    ...sessions.map(page => [page, '타임']),
    ...participants.map(page => [page, '활동자 응답']),
  ];
  const richText = [text('자동 일별 집계', MARKER), text(`\n\n${totals.join('\n')}\n\n`), text(analysis), text('\n\n원본 ')];
  sources.slice(0, 35).forEach(([page, label], i) => {
    if (i) richText.push(text(' · '));
    richText.push(text(`${label} ${i + 1}`, page.url));
  });
  if (sources.length > 35) richText.push(text(` 외 ${sources.length - 35}건`));
  return { type: 'callout', callout: { icon: { type: 'emoji', emoji: '📊' }, rich_text: richText } };
}

function topicSummary(stats, aiEnabled) {
  const groups = [
    ['변경·지연·누락 사유', stats.organizerIssues],
    ['주관자 특이사항', stats.organizerNotes],
    ['활동자 비고', stats.participantSuggestions],
  ];
  return [
    aiEnabled ? 'AI 해석 연결 대기 · 제출 내용의 키워드 분류입니다.' : '제출 내용의 키워드 분류',
    ...groups.map(([label, topics]) => {
      const summary = Object.entries(topics).map(([topic, count]) => `${topic} ${count}건`).join(' · ');
      return `${label} · ${summary || '분류된 의견 없음'}`;
    }),
  ].join('\n');
}

export async function updateDailyAnalysis(date, sessionIds, env = process.env) {
  const notion = (path, method = 'GET', body) => notionRequest(path, method, body, env.NOTION_TOKEN);
  const sessions = await notionPages(notion, env.NOTION_SESSIONS_DATA_SOURCE_ID, {
    property: '타임 키', rich_text: { starts_with: `${date} | ` },
  });
  if (!sessions.length) return;

  const participants = [];
  for (let index = 0; index < sessions.length; index += 30) {
    const relations = sessions.slice(index, index + 30).map(page =>
      ({ property: '타임', relation: { contains: page.id } }));
    participants.push(...await notionPages(notion, env.NOTION_PARTICIPANTS_DATA_SOURCE_ID,
      relations.length === 1 ? relations[0] : { or: relations }));
  }
  const uniqueParticipants = [...new Map(participants.map(page => [page.id, page])).values()];
  const bySession = new Map();
  for (const participant of uniqueParticipants) {
    for (const { id } of value(participant, '타임', 'relation') ?? []) {
      if (!bySession.has(id)) bySession.set(id, []);
      bySession.get(id).push(participant);
    }
  }
  const organizerReports = new Map();
  async function getOrganizerReport(sessionId) {
    if (!organizerReports.has(sessionId)) organizerReports.set(sessionId, await readOrganizerReport(notion, sessionId));
    return organizerReports.get(sessionId);
  }
  for (const session of sessions) {
    if (sessionIds.has(session.id) && value(session, '주관자 제출 완료', 'checkbox')) {
      const report = await getOrganizerReport(session.id);
      if (report) await updateOrganizerResponses(notion, report, bySession.get(session.id) ?? []);
    }
  }
  const parent = env.NOTION_DAILY_ANALYSIS_PAGE_ID?.trim();
  const production = parent?.replaceAll('-', '').toLowerCase() === PRODUCTION_ANALYSIS_PAGE_ID;
  const directJournal = env.NOTION_ACTIVITY_JOURNAL_PAGE_ID?.trim() || (production ? PRODUCTION_JOURNAL_PAGE_ID : undefined);
  if (!parent && !directJournal) return;
  const childrenOf = pageId => childBlocks(notion, pageId);
  let journalError;
  const refreshJournal = async journalId => {
    try {
      const readOrganizerDetails = async sessionId => (await getOrganizerReport(sessionId))?.blocks ?? [];
      const content = await formatActivityJournal(sessions, bySession, readOrganizerDetails, childrenOf);
      await saveActivityJournal(notion, childrenOf, parent, journalId, date, content);
    } catch (error) {
      journalError = error;
    }
  };

  if (directJournal) await refreshJournal(directJournal);
  if (!parent) {
    if (journalError) throw journalError;
    return;
  }

  const matching = [];
  const journals = [];
  for await (const block of childrenOf(parent)) {
    if (block.type !== 'child_page') continue;
    if (block.child_page.title === date) matching.push(block.id);
    if (!directJournal && block.child_page.title === ACTIVITY_JOURNAL_TITLE) journals.push(block.id);
  }
  if (!directJournal) {
    if (journals.length > 1) journalError = new Error('Multiple activity journal parent pages have the same title');
    else await refreshJournal(journals[0]);
  }
  if (matching.length > 1) throw new Error('Multiple daily pages have the same date');

  const stats = collectDailyStats(sessions, uniqueParticipants);
  const aiEnabled = env.DAILY_AI_ENABLED === 'true';
  let aiError;
  let analysis = topicSummary(stats, aiEnabled);
  if (aiEnabled && env.ANTHROPIC_API_KEY) {
    try {
      analysis = await analyze(stats, env);
    } catch (error) {
      aiError = error;
    }
  }
  await saveDateAnalysis(notion, parent, date, matching[0], analysisBlock(stats, analysis, sessions, uniqueParticipants));
  if (journalError) throw journalError;
  if (aiError) throw aiError;
  return { waitingForAI: aiEnabled && !env.ANTHROPIC_API_KEY };
}

async function saveDateAnalysis(notion, parent, date, page, result) {
  if (!page) {
    await notion('pages', 'POST', {
      parent: { type: 'page_id', page_id: parent },
      properties: { title: { type: 'title', title: [text(date)] } },
      children: [result],
    });
    return;
  }
  for await (const block of childBlocks(notion, page)) {
    if (block.type === 'callout' && block.callout.rich_text[0]?.href === MARKER) {
      await notion(`blocks/${block.id}`, 'PATCH', { callout: result.callout });
      return;
    }
  }
  await notion(`blocks/${page}/children`, 'PATCH', { children: [result] });
}

export async function refreshQueuedDay() {
  if (!process.env.NOTION_TOKEN || !process.env.NOTION_SESSIONS_DATA_SOURCE_ID ||
      !process.env.NOTION_PARTICIPANTS_DATA_SOURCE_ID) return;
  const queue = store();
  const current = await queue.getWithMetadata(LOCK, { type: 'json' });
  if (current?.data.expires > Date.now()) return;
  const lease = await queue.setJSON(LOCK, { expires: Date.now() + 60_000 },
    current ? { onlyIfMatch: current.etag } : { onlyIfNew: true });
  if (!lease.modified) return;

  try {
    const { blobs } = await queue.list({ prefix: PENDING });
    const dates = Map.groupBy(blobs, ({ key }) => key.split('/')[1]);
    for (const [date, entries] of dates) {
      const retryKey = `retry/${date}`;
      const retry = await queue.get(retryKey, { type: 'json' });
      const revision = createHash('sha256').update(entries.map(({ key }) => key).sort().join('\n')).digest('hex');
      const aiEnabled = process.env.DAILY_AI_ENABLED === 'true';
      if (retry?.revision === revision &&
          (retry.after > Date.now() || (retry.waitingForAI && aiEnabled && !process.env.ANTHROPIC_API_KEY))) continue;
      try {
        const sessionIds = new Set(entries.map(({ key }) => key.split('/')[2]));
        const result = await updateDailyAnalysis(date, sessionIds);
        if (result?.waitingForAI) {
          await queue.setJSON(retryKey, { revision, waitingForAI: true });
        } else {
          await Promise.all(entries.map(({ key }) => queue.delete(key)));
          if (retry) await queue.delete(retryKey);
        }
      } catch (error) {
        console.error('Daily analysis failed', date, error.message);
        const attempts = (retry?.attempts ?? 0) + 1;
        await queue.setJSON(retryKey, {
          revision, attempts, after: Date.now() + Math.min(2 ** attempts, 60) * 60_000,
        });
      }
      break;
    }
  } finally {
    await queue.setJSON(LOCK, { expires: 0 }, { onlyIfMatch: lease.etag });
  }
}
