export const ACTIVITY_JOURNAL_TITLE = '일별 활동 일지';

const JOURNAL_MARKER = 'https://havefunsam.netlify.app/#generated-activity-journal';
const SLOTS = ['1타임', '2타임', '3타임', '4타임', '그 외'];
const TIME_RANGE = /^((?:[01]\d|2[0-3]):[0-5]\d)\s*[-–—~]\s*((?:[01]\d|2[0-3]):[0-5]\d)$/;
const RICH_TEXTS_PER_BLOCK = 75;
const collator = new Intl.Collator('ko');

const plain = items => (items ?? []).map(item => item.plain_text ?? item.text?.content ?? '').join('');
const propertyText = (page, name) => plain(page.properties[name]?.rich_text);
const line = value => value.replace(/[\r\n]+/g, ' ').trim();
const text = (content, url) => ({ type: 'text', text: { content, ...(url && { link: { url } }) } });

function timeRanges(value) {
  return value.split(/[\n,]/).flatMap(item => {
    const range = item.trim().match(TIME_RANGE);
    return range && range[1] < range[2] ? [`${range[1]}-${range[2]}`] : [];
  });
}

async function reportFields(blocks, timeLabel) {
  const fields = {};
  let inActivityInfo = false;
  for await (const block of blocks) {
    if (block.type === 'heading_3') {
      if (inActivityInfo) break;
      inActivityInfo = plain(block.heading_3.rich_text).includes('활동 정보');
    }
    if (!inActivityInfo || block.type !== 'bulleted_list_item') continue;
    const detail = plain(block.bulleted_list_item.rich_text);
    const separator = detail.indexOf(':');
    if (separator === -1) continue;
    const label = detail.slice(0, separator).trim();
    if (label === timeLabel || label === '활동 장소') fields[label] = detail.slice(separator + 1).trim();
  }
  return fields;
}

async function journalEntry(page, name, timeLabel, readDetails, includeLocation = true) {
  let times = timeRanges(propertyText(page, timeLabel));
  let location = line(propertyText(page, '활동 장소'));
  if (!times.length || (includeLocation && !location)) {
    const fields = await reportFields(await readDetails(page.id), timeLabel);
    if (!times.length) times = timeRanges(fields[timeLabel] ?? '');
    if (!location) location = line(fields['활동 장소'] ?? '');
  }
  return { name: line(name) || '이름 미기록', time: times.join(', ') || '시간 미기록', location: location || '장소 미기록' };
}

function sortEntries(entries) {
  return entries.sort((left, right) => collator.compare(left.name, right.name) ||
    collator.compare(left.time, right.time) || collator.compare(left.location, right.location));
}

export async function formatActivityJournal(sessions, bySession, readOrganizerDetails, readParticipantDetails) {
  const groups = new Map();
  for (const session of sessions) {
    const slot = propertyText(session, '타임 키').split('|')[1]?.trim();
    if (!SLOTS.includes(slot)) continue;
    if (!groups.has(slot)) groups.set(slot, { organizers: [], participants: new Map() });
    const group = groups.get(slot);
    if (session.properties['주관자 제출 완료']?.checkbox) {
      const name = propertyText(session, '주관자 이름');
      group.organizers.push(await journalEntry(session, name, '주관 시간', readOrganizerDetails));
    }
    for (const participant of bySession.get(session.id) ?? []) {
      if (group.participants.has(participant.id)) continue;
      const title = Object.values(participant.properties).find(property => property.type === 'title');
      group.participants.set(participant.id,
        await journalEntry(participant, plain(title?.title), '활동 시간', readParticipantDetails, slot === '그 외'));
    }
  }

  const sections = [];
  for (const slot of SLOTS) {
    const group = groups.get(slot);
    if (!group || (!group.organizers.length && !group.participants.size)) continue;
    const organizers = sortEntries(group.organizers);
    const participants = [...group.participants.values()];
    if (slot === '그 외') {
      const entries = sortEntries([...organizers, ...participants]);
      sections.push(['그외 활동', ...entries.map(entry => `${entry.name}/${entry.time}/${entry.location}`)].join('\n'));
      continue;
    }
    const time = organizers[0]?.time ?? '시간 미기록';
    const location = organizers[0]?.location ?? '장소 미기록';
    sections.push([
      `${slot} 활동 (${time})/${location}`,
      `- 주관자: ${organizers.map(entry => entry.name).join(', ') || '미제출'}`,
      ...sortEntries(participants).map(entry => `${entry.name}(${entry.time})`),
    ].join('\n'));
  }
  return sections.join('\n\n');
}

async function datePage(childrenOf, parent, date) {
  let id;
  for await (const block of childrenOf(parent)) {
    if (block.type !== 'child_page' || block.child_page.title !== date) continue;
    if (id) throw new Error('Multiple activity journal pages have the same date');
    id = block.id;
  }
  return id;
}

function codeBlocks(content) {
  // Keep each rich text within 2,000 UTF-16 units and each block request under 500 KB.
  const parts = content.match(/.{1,1000}/gsu) ?? [];
  const blocks = [];
  for (let index = 0; index < parts.length; index += RICH_TEXTS_PER_BLOCK) {
    blocks.push({
      type: 'code',
      code: {
        language: 'plain text',
        rich_text: parts.slice(index, index + RICH_TEXTS_PER_BLOCK).map(part => text(part)),
        caption: [text('\u2063', JOURNAL_MARKER)],
      },
    });
  }
  return blocks;
}

async function createPage(notion, parent, title, children = []) {
  const page = await notion('pages', 'POST', {
    parent: { type: 'page_id', page_id: parent },
    properties: { title: { type: 'title', title: [text(title)] } },
    children,
  });
  return page.id;
}

export async function saveActivityJournal(notion, childrenOf, parent, journalId, date, content) {
  if (!content) return;
  const result = codeBlocks(content);
  const journal = journalId ?? await createPage(notion, parent, ACTIVITY_JOURNAL_TITLE);
  let page = journalId ? await datePage(childrenOf, journal, date) : undefined;
  const existing = [];
  if (page) {
    for await (const block of childrenOf(page)) {
      if (block.type === 'code' && block.code.caption?.some(item => item.href === JOURNAL_MARKER)) existing.push(block);
    }
  } else {
    page = await createPage(notion, journal, date, result.splice(0, 1));
  }

  let after;
  for (const [index, block] of result.entries()) {
    const previous = existing[index];
    if (previous) {
      if (previous.code.language !== block.code.language || plain(previous.code.rich_text) !== plain(block.code.rich_text)) {
        await notion(`blocks/${previous.id}`, 'PATCH', { code: block.code });
      }
      after = previous.id;
    } else {
      const response = await notion(`blocks/${page}/children`, 'PATCH', {
        children: [block],
        ...(after && { position: { type: 'after_block', after_block: { id: after } } }),
      });
      after = response.results[0].id;
    }
  }
  for (const stale of existing.slice(result.length)) await notion(`blocks/${stale.id}`, 'PATCH', { in_trash: true });
}
