function setupDatePicker(form) {
  const input = form.elements.date;
  const dialog = document.createElement('dialog');
  dialog.className = 'date-picker';
  dialog.setAttribute('aria-labelledby', 'calendar-title');
  dialog.innerHTML = `
    <div class="calendar-heading">
      <h2 id="calendar-title">활동일 선택</h2>
      <button type="button" data-close>닫기</button>
    </div>
    <div class="calendar-nav">
      <button type="button" data-prev aria-label="이전 달">‹</button>
      <strong data-month aria-live="polite"></strong>
      <button type="button" data-next aria-label="다음 달">›</button>
    </div>
    <div class="calendar-week" aria-hidden="true">
      <span>일</span><span>월</span><span>화</span><span>수</span><span>목</span><span>금</span><span>토</span>
    </div>
    <div class="calendar-days" data-days role="group" aria-label="날짜"></div>`;
  form.querySelector('.date-field').append(dialog);

  const days = dialog.querySelector('[data-days]');
  const monthLabel = dialog.querySelector('[data-month]');
  const previous = dialog.querySelector('[data-prev]');
  const next = dialog.querySelector('[data-next]');
  const dayFormat = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'full', timeZone: 'UTC' });
  let active;

  function calendarDate(year, month, day) {
    const date = new Date(0);
    date.setUTCFullYear(year, month, day);
    return date;
  }

  function today() {
    const now = new Date();
    return calendarDate(now.getFullYear(), now.getMonth(), now.getDate());
  }

  function iso(date) {
    return date.toISOString().slice(0, 10);
  }

  function parse(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return null;
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && iso(date) === value ? date : null;
  }

  function select(date) {
    input.value = iso(date);
    input.setCustomValidity('');
    if (dialog.open) dialog.close();
  }

  function draw(focusDay = false) {
    const year = active.getUTCFullYear();
    const month = active.getUTCMonth();
    monthLabel.textContent = `${year}년 ${month + 1}월`;
    previous.disabled = year === 1 && month === 0;
    next.disabled = year === 9999 && month === 11;
    days.replaceChildren();

    const firstDay = calendarDate(year, month, 1).getUTCDay();
    const lastDate = calendarDate(year, month + 1, 0).getUTCDate();
    const todayIso = iso(today());
    for (let index = 0; index < firstDay; index++) days.append(document.createElement('span'));
    for (let day = 1; day <= lastDate; day++) {
      const date = calendarDate(year, month, day);
      const key = iso(date);
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = day;
      button.tabIndex = day === active.getUTCDate() ? 0 : -1;
      button.setAttribute('aria-label', dayFormat.format(date));
      button.setAttribute('aria-pressed', String(key === input.value));
      if (key === todayIso) button.setAttribute('aria-current', 'date');
      button.addEventListener('click', () => select(date));
      days.append(button);
    }
    if (focusDay) days.querySelector('[tabindex="0"]').focus();
  }

  function changeMonth(offset) {
    active = calendarDate(active.getUTCFullYear(), active.getUTCMonth() + offset, 1);
    draw();
  }

  input.addEventListener('input', () => {
    input.setCustomValidity(input.value && !parse(input.value)
      ? '올바른 활동일을 YYYY-MM-DD 형식으로 입력해 주세요.'
      : '');
  });
  function openCalendar() {
    active = parse(input.value) ?? today();
    dialog.showModal();
    draw(true);
  }

  input.addEventListener('click', openCalendar);
  input.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    openCalendar();
  });
  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
  previous.addEventListener('click', () => changeMonth(-1));
  next.addEventListener('click', () => changeMonth(1));
  days.addEventListener('keydown', event => {
    const offset = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
    if (!offset) return;
    event.preventDefault();
    const target = calendarDate(active.getUTCFullYear(), active.getUTCMonth(), active.getUTCDate() + offset);
    if (target.getUTCFullYear() < 1 || target.getUTCFullYear() > 9999) return;
    active = target;
    draw(true);
  });
}
