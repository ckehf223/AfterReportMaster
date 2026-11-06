const NOTION_VERSION = '2026-03-11';

export async function notionRequest(path, method, body, token) {
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
    const invalidProperty = error?.message?.match(/^(.+?) is not a property that exists\.?$/)?.[1];
    const invalidField = error?.message?.match(/\bbody\.[\w.\[\]]+/)?.[0];
    console.error('Notion request failed', method, path.split('/')[0], response.status, error?.code,
      invalidProperty || invalidField || '');
    throw Object.assign(new Error('Notion request failed'), { notionStatus: response.status });
  }
  return response.json();
}
