const cover = document.querySelector('#cover');
const reportView = document.querySelector('#report-view');
const badge = document.querySelector('#report-role');
const roleStatus = document.querySelector('#role-status');
const steps = [...document.querySelectorAll('[data-step]')];
const roles = { organizer: '주관자', participant: '활동자' };
let pendingForm;

function focusScreen(section, step) {
  for (const item of steps) {
    if (item.dataset.step === step) item.setAttribute('aria-current', 'step');
    else item.removeAttribute('aria-current');
  }
  section.querySelector('h1, h3').focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

function goHome() {
  if (Object.hasOwn(roles, history.state?.role)) history.back();
  else if (pendingForm) loadScreen();
}

function mountScreen(role, content) {
  const hasRole = Boolean(content);
  cover.hidden = hasRole;
  reportView.hidden = !hasRole;
  reportView.replaceChildren();
  badge.textContent = hasRole ? roles[role] + '용' : '활동 기록';
  document.title = hasRole ? '즐기삼 | ' + roles[role] + ' 사후' : '즐기삼 | 활동 사후';

  if (!hasRole) {
    focusScreen(cover, 'cover');
    return;
  }

  reportView.append(content);
  const section = reportView.querySelector('#form');
  const form = section.querySelector('#report-form');
  const slot = form.elements.slot;
  const otherCode = form.elements.otherCode;
  const otherField = form.querySelector('#other-field');
  const errorMessage = form.querySelector('#submit-error');
  const submitButton = form.querySelector('#send');
  const ending = reportView.querySelector('#done');

  function syncOtherField() {
    const isOther = slot.value === '그 외';
    otherField.hidden = !isOther;
    otherCode.disabled = !isOther;
    otherCode.required = isOther;
  }

  for (const button of reportView.querySelectorAll('[data-home]')) {
    button.addEventListener('click', goHome);
  }
  slot.addEventListener('change', syncOtherField);
  syncOtherField();
  setupDatePicker(form);
  focusScreen(section, 'form');

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (submitButton.disabled) return;

    const answers = { ...Object.fromEntries(new FormData(form)), role };
    errorMessage.hidden = true;
    submitButton.disabled = true;
    const buttonLabel = submitButton.innerHTML;
    submitButton.textContent = '저장 중…';

    try {
      const response = await fetch('/.netlify/functions/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(answers),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.ok) {
        throw new Error(result?.error ?? '저장 서버에 연결할 수 없어요. 잠시 후 다시 시도해 주세요.');
      }
      if (!form.isConnected) return;

      ending.querySelector('#receipt').textContent = [answers.date, answers.slot, answers.otherCode?.trim()]
        .filter(Boolean).join(' · ');
      form.reset();
      section.hidden = true;
      ending.hidden = false;
      focusScreen(ending, 'done');
    } catch (error) {
      if (!form.isConnected) return;
      errorMessage.textContent = error instanceof TypeError
        ? '네트워크에 연결할 수 없어요. 입력 내용은 그대로 있으니 다시 시도해 주세요.'
        : error.message;
      errorMessage.hidden = false;
    } finally {
      submitButton.disabled = false;
      submitButton.innerHTML = buttonLabel;
    }
  });
}

async function loadScreen(role, fromCover = false) {
  pendingForm?.abort();
  pendingForm = null;
  roleStatus.textContent = '';
  if (!Object.hasOwn(roles, role)) {
    mountScreen();
    return;
  }

  const request = new AbortController();
  pendingForm = request;
  roleStatus.textContent = '작성 화면을 불러오는 중이에요…';

  try {
    const response = await fetch(`./forms/${role}.html`, { signal: request.signal });
    if (!response.ok) throw new Error('Form unavailable');

    const template = document.createElement('template');
    template.innerHTML = await response.text();
    if (request.signal.aborted) return;
    if (!template.content.querySelector(`#form form[data-role="${role}"]`) || !template.content.querySelector('#done')) {
      throw new Error('Invalid form');
    }

    mountScreen(role, template.content);
    if (fromCover) history.pushState({ role }, '');
    roleStatus.textContent = '';
  } catch {
    if (request.signal.aborted) return;
    if (!fromCover) history.replaceState(null, '');
    mountScreen();
    roleStatus.textContent = location.protocol === 'file:'
      ? '작성 화면을 열려면 로컬 미리보기 서버에서 접속해 주세요.'
      : '작성 화면을 불러오지 못했어요. 버튼을 다시 눌러 주세요.';
  } finally {
    if (pendingForm === request) pendingForm = null;
  }
}

if (['http:', 'https:'].includes(location.protocol) && location.pathname.endsWith('/index.html')) {
  const root = new URL('./', location.href);
  root.search = location.search;
  root.hash = location.hash;
  history.replaceState(history.state, '', root);
}

for (const button of cover.querySelectorAll('[data-role]')) {
  button.addEventListener('click', () => loadScreen(button.dataset.role, true));
}

document.querySelector('.brand').addEventListener('click', event => {
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  goHome();
});

window.addEventListener('popstate', event => loadScreen(event.state?.role));
if (Object.hasOwn(roles, history.state?.role)) loadScreen(history.state.role);

