const viewMeta = {
  today: { title: '今日', kicker: '学习总览' },
  tutor: { title: '辅导室', kicker: '循序提示与教材核查' },
  knowledge: { title: '知识库', kicker: '概念、方法与教材原页' },
  mistakes: { title: '错题本', kicker: '复盘失分原因' },
  profile: { title: '学习档案', kicker: '目标、节奏与掌握度' },
};

const hintDescriptions = {
  1: '只给方向，保留独立思考空间',
  2: '给关键公式和中间步骤，不直接收尾',
  3: '给完整讲解、步骤与核查路径',
};

const state = {
  activeView: 'today',
  connected: false,
  loading: false,
  sessionLoading: false,
  sessionError: '',
  sessionRequestId: 0,
  loadingSessionId: null,
  sessionId: null,
  hintLevel: 1,
  catalogFilter: 'all',
  mistakeFilter: 'all',
  searchResults: null,
  data: {
    mode: 'retrieval',
    provider: null,
    model: null,
    indexStats: {},
    profile: null,
    catalog: [],
    mastery: [],
    mistakes: [],
    sessions: [],
    plan: null,
  },
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function displayText(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  return String(value)
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .trim();
}

function clampNumber(value, minimum, maximum, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = displayText(text);
  return node;
}

function button(text, className = '') {
  const node = element('button', className, text);
  node.type = 'button';
  return node;
}

function progressBar(percent, className = '') {
  const progress = element('progress', `progress-bar${className ? ` ${className}` : ''}`);
  progress.max = 100;
  progress.value = clampNumber(percent, 0, 100);
  progress.textContent = `${Math.round(progress.value)}%`;
  progress.setAttribute('aria-label', `掌握度 ${Math.round(progress.value)}%`);
  return progress;
}

function replaceContent(target, ...nodes) {
  target.replaceChildren(...nodes.filter(Boolean));
}

function setText(selector, value) {
  const node = $(selector);
  if (node) node.textContent = displayText(value);
}

function unwrapPayload(payload) {
  if (payload && typeof payload === 'object' && payload.data && Object.keys(payload).length <= 3) {
    return payload.data;
  }
  return payload;
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  const request = { ...options, headers };
  if (options.body && typeof options.body !== 'string') {
    headers.set('Content-Type', 'application/json');
    request.body = JSON.stringify(options.body);
  }
  headers.set('Accept', 'application/json');

  const response = await fetch(path, request);
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    const message = payload?.error?.message || payload?.error || payload?.message || `请求失败，状态码 ${response.status}`;
    throw new Error(displayText(message, '请求失败'));
  }
  return unwrapPayload(payload);
}

function showToast(message, type = 'success') {
  const region = $('#toast-region');
  const toast = element('div', `toast${type === 'error' ? ' error' : ''}`, message);
  region.append(toast);
  window.setTimeout(() => toast.remove(), 3600);
}

function announce(message) {
  const region = $('#app-live-region');
  region.textContent = '';
  window.setTimeout(() => { region.textContent = displayText(message); }, 20);
}

function setBusy(buttonNode, busy, busyText = '处理中') {
  if (!buttonNode) return;
  if (busy) {
    buttonNode.dataset.originalText = buttonNode.textContent;
    buttonNode.textContent = busyText;
    buttonNode.disabled = true;
  } else {
    buttonNode.textContent = buttonNode.dataset.originalText || buttonNode.textContent;
    buttonNode.disabled = false;
    delete buttonNode.dataset.originalText;
  }
}

function modeInfo(mode = state.data.mode, model = state.data.model, provider = state.data.provider) {
  if (mode === 'model' || mode === 'openai') {
    const isDeepSeek = provider === 'deepseek' || /^deepseek-/i.test(displayText(model));
    return {
      label: isDeepSeek ? 'DeepSeek 模型辅导' : '模型辅导模式',
      detail: displayText(model, '模型已连接'),
      systemModel: displayText(model, '已连接'),
    };
  }
  return {
    label: '检索辅导模式',
    detail: '未配置 DeepSeek 密钥，教材检索仍可用',
    systemModel: '未配置',
  };
}

function renderConnection(error = null) {
  const card = $('#sidebar-mode-card');
  const pill = $('#connection-pill');
  card.classList.remove('is-online', 'is-error');
  pill.classList.remove('is-online', 'is-error');

  if (error) {
    card.classList.add('is-error');
    pill.classList.add('is-error');
    setText('#sidebar-mode-label', '本地服务未连接');
    setText('#sidebar-mode-detail', '请确认服务已启动');
    setText('#connection-label', '连接失败');
    setText('#system-mode', '服务未连接');
    return;
  }

  const info = modeInfo();
  if (state.connected) {
    card.classList.add('is-online');
    pill.classList.add('is-online');
  }
  setText('#sidebar-mode-label', info.label);
  setText('#sidebar-mode-detail', info.detail);
  setText('#connection-label', info.label);
  setText('#composer-mode', state.data.mode === 'model' ? `由 ${info.detail} 辅导，回答附教材定位` : '本地检索回答，附教材定位');
  setText('#system-mode', info.label);
  setText('#system-model', info.systemModel);
}

function initialTheme() {
  const stored = localStorage.getItem('kaoyan-tutor-theme');
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const toggle = $('#theme-toggle');
  const next = theme === 'dark' ? '浅色' : '深色';
  toggle.setAttribute('aria-label', `切换到${next}模式`);
  const meta = $('meta[name="theme-color"]');
  if (meta) meta.content = theme === 'dark' ? '#141a18' : '#f3f1e9';
}

function switchView(view, { focus = false, updateHash = true } = {}) {
  if (!viewMeta[view]) return;
  state.activeView = view;
  $$('.view').forEach((section) => {
    const active = section.dataset.view === view;
    section.hidden = !active;
    section.classList.toggle('is-active', active);
  });
  $$('[data-view-target]').forEach((item) => {
    const active = item.dataset.viewTarget === view;
    item.classList.toggle('is-active', active);
    if (active) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  });
  setText('#page-title', viewMeta[view].title);
  setText('#page-kicker', viewMeta[view].kicker);
  if (updateHash) history.replaceState(null, '', `#${view}`);
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (focus) $('#main-content').focus({ preventScroll: true });
  if (view === 'tutor') window.setTimeout(() => $('#chat-input')?.focus(), 80);
}

function formatDate(value, options = { month: 'short', day: 'numeric' }) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '';
  return new Intl.DateTimeFormat('zh-CN', options).format(date);
}

function todayPlanData() {
  const plan = state.data.plan;
  if (Array.isArray(plan)) return { items: plan, totalMinutes: null };
  if (!plan || typeof plan !== 'object') return { items: [], totalMinutes: null };
  const direct = plan.today || plan.items || plan.tasks;
  if (Array.isArray(direct)) return { items: direct, totalMinutes: plan.totalMinutes ?? plan.minutes };
  if (plan.today && typeof plan.today === 'object') {
    return {
      items: asArray(plan.today.items || plan.today.tasks),
      totalMinutes: plan.today.totalMinutes ?? plan.today.minutes ?? plan.totalMinutes,
    };
  }
  const days = asArray(plan.days);
  if (days.length) {
    const todayKey = new Date().toISOString().slice(0, 10);
    const day = days.find((item) => displayText(item.date).slice(0, 10) === todayKey) || days[0];
    return {
      items: asArray(day.items || day.tasks),
      totalMinutes: day.totalMinutes ?? day.minutes ?? plan.totalMinutes,
    };
  }
  return { items: [], totalMinutes: null };
}

function planItemTitle(item) {
  return displayText(item.title || item.topic || item.name || item.action || item.knowledgeTitle, '复习任务');
}

function planItemMinutes(item) {
  const value = item.minutes ?? item.durationMinutes ?? item.duration;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function renderToday() {
  const profile = state.data.profile || {};
  const name = displayText(profile.name);
  const examDate = profile.examDate ? new Date(profile.examDate) : null;
  let countdown = '';
  if (examDate && !Number.isNaN(examDate.valueOf())) {
    const days = Math.ceil((examDate.valueOf() - Date.now()) / 86400000);
    if (days >= 0) countdown = `，距离考试还有 ${days} 天`;
  }
  setText('#today-date', new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date()));
  setText('#today-greeting', name ? `${name}${countdown}。按计划完成一小步，再及时复盘。` : `先完成今天最重要的一项任务${countdown}。`);

  const planData = todayPlanData();
  const unresolved = asArray(state.data.mistakes).filter((item) => item.status !== 'resolved');
  const stats = state.data.indexStats || {};
  setText('#metric-plan', planData.items.length);
  setText('#metric-mistakes', unresolved.length);
  setText('#metric-pages', stats.ocrPageCount ?? stats.ocrPageChunkCount ?? 0);
  setText('#metric-mastery', asArray(state.data.mastery).length);

  const planMinutes = planData.totalMinutes ?? planData.items.reduce((sum, item) => sum + (planItemMinutes(item) || 0), 0);
  setText('#plan-duration', planMinutes ? `约 ${planMinutes} 分钟` : '按薄弱项生成');
  const list = $('#today-plan');
  if (!planData.items.length) {
    replaceContent(list, element('p', 'empty-inline', '完善学习档案并记录练习结果后，这里会生成今日安排。'));
  } else {
    replaceContent(list, ...planData.items.slice(0, 7).map((item, index) => {
      const row = element('div', 'task-item');
      row.append(element('span', 'task-marker', String(index + 1)));
      const copy = element('div', 'task-copy');
      copy.append(element('strong', '', planItemTitle(item)));
      const details = [displayText(item.type || item.kind || item.reason), planItemMinutes(item) ? `${planItemMinutes(item)} 分钟` : ''].filter(Boolean).join(' · ');
      copy.append(element('small', '', details || '完成后记录结果'));
      row.append(copy);
      const action = button('开始', 'task-action');
      action.dataset.ask = `请带我完成今天的学习任务：${planItemTitle(item)}`;
      row.append(action);
      return row;
    }));
  }

  const weak = [...asArray(state.data.mastery)]
    .sort((a, b) => Number(a.score ?? 0) - Number(b.score ?? 0))
    .slice(0, 5);
  const weakList = $('#weak-topics');
  if (!weak.length) {
    replaceContent(weakList, element('p', 'empty-inline', '还没有掌握度记录。完成一次练习后会显示薄弱项。'));
  } else {
    replaceContent(weakList, ...weak.map((item) => {
      const score = clampNumber(item.score, 0, 1) * 100;
      const row = element('div', 'topic-row');
      row.append(element('strong', '', item.title || item.knowledgeId || '未命名知识点'));
      row.append(element('small', '', `${Math.round(score)}%`));
      row.append(progressBar(score));
      row.role = 'button';
      row.tabIndex = 0;
      row.dataset.ask = `请围绕${displayText(item.title || item.knowledgeId)}给我一道由浅入深的练习，并先用提示等级 1 引导。`;
      return row;
    }));
  }
}

function masteryById() {
  return new Map(asArray(state.data.mastery).map((item) => [item.knowledgeId, item]));
}

function renderCatalog() {
  const target = $('#catalog-list');
  const mastery = masteryById();
  let items = asArray(state.data.catalog);
  if (state.catalogFilter !== 'all') items = items.filter((item) => item.type === state.catalogFilter || item.docType === state.catalogFilter);
  setText('#knowledge-result-title', '知识目录');
  setText('#knowledge-result-count', `${items.length} 项`);
  if (!items.length) {
    replaceContent(target, emptyState('当前分类下没有条目。'));
    return;
  }
  replaceContent(target, ...items.map((item) => {
    const card = element('article', 'catalog-card');
    const head = element('div', 'catalog-card-head');
    head.append(element('h4', '', item.title || item.id));
    const isMethod = (item.type || item.docType) === 'method_candidate';
    head.append(element('span', 'catalog-type', isMethod ? '方法' : '知识点'));
    card.append(head);
    card.append(element('p', '', displayText(item.domain || item.status, '知识关联候选页')));
    const record = mastery.get(item.id);
    const score = clampNumber(record?.score, 0, 1) * 100;
    const meta = element('div', 'catalog-meta');
    meta.append(element('span', '', displayText(item.status, '待校验')));
    meta.append(element('span', '', record ? `掌握度 ${Math.round(score)}%` : '尚未练习'));
    card.append(meta);
    card.append(progressBar(score, 'catalog-progress'));
    const actions = element('div', 'catalog-actions');
    const ask = button('向辅导员提问');
    ask.dataset.ask = `请从定义、适用条件和典型题型三个方面讲解${displayText(item.title)}，先给我提示等级 1。`;
    actions.append(ask);
    card.append(actions);
    return card;
  }));
}

function emptyState(message, compact = false) {
  const wrapper = element('div', `empty-state${compact ? ' compact' : ''}`);
  wrapper.append(element('span', 'empty-symbol', '⌁'));
  wrapper.append(element('p', '', message));
  return wrapper;
}

function sourceLocation(source) {
  if (source.page) return `PDF 第 ${source.page} 页`;
  if (source.heading) return source.heading;
  return '知识关联页';
}

function sourceImageUrl(image) {
  const raw = typeof image === 'object' && image
    ? image.url || image.src || image.path
    : image;
  const value = displayText(raw);
  if (!value) return null;
  if (value.startsWith('/api/')) return value;
  if (/^https?:\/\//i.test(value)) return value;
  return `/api/vault-file?path=${encodeURIComponent(value)}`;
}

function buildSourceCard(source, index) {
  const card = element('article', 'source-card');
  const head = element('div', 'source-card-head');
  head.append(element('span', 'source-label', displayText(source.label, `S${index + 1}`)));
  const title = element('div', 'source-title');
  title.append(element('strong', '', source.title || '未命名来源'));
  title.append(element('small', '', sourceLocation(source)));
  head.append(title);
  card.append(head);

  const isOcr = source.evidenceTier === 'ocr_source' || source.docType === 'ocr_page';
  const badge = element('span', `evidence-badge${isOcr ? '' : ' route'}`, isOcr ? '教材依据 · OCR 初稿' : '关联线索 · 待人工校验');
  card.append(badge);
  if (source.excerpt) card.append(element('blockquote', 'source-excerpt', source.excerpt));
  const path = [displayText(source.path), displayText(source.anchor)].filter(Boolean).join('#');
  if (path) {
    const pathNode = element('code', 'source-path', path);
    pathNode.title = path;
    card.append(pathNode);
  }

  const images = asArray(source.imageUrls?.length ? source.imageUrls : source.images).map(sourceImageUrl).filter(Boolean);
  if (images.length) {
    const details = element('details', 'source-images');
    const summary = element('summary', '', `查看原页图片 ${images.length} 张`);
    details.append(summary);
    const grid = element('div', 'source-images-grid');
    images.slice(0, 4).forEach((url, imageIndex) => {
      const link = element('a');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener';
      const image = element('img');
      image.src = url;
      image.loading = 'lazy';
      image.alt = `${displayText(source.title, '教材')} ${sourceLocation(source)} 原页图片 ${imageIndex + 1}`;
      image.addEventListener('error', () => link.remove());
      link.append(image);
      grid.append(link);
    });
    details.append(grid);
    card.append(details);
  }
  return card;
}

function renderSources(sources) {
  const items = asArray(sources);
  setText('#source-count', items.length);
  const list = $('#source-list');
  if (!items.length) {
    replaceContent(list, emptyState('没有检索到足够的教材证据。请补充完整题目和已知条件。', true));
    return;
  }
  replaceContent(list, ...items.map(buildSourceCard));
}

function sessionDateLabel(session) {
  const raw = session.updatedAt || session.startedAt || session.createdAt;
  if (!raw) return '时间未记录';
  const date = new Date(raw);
  if (Number.isNaN(date.valueOf())) return '时间未记录';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function sessionTitle(session) {
  return displayText(session.title || session.summary, '未命名对话');
}

function renderSessions() {
  const items = [...asArray(state.data.sessions)].sort((left, right) => {
    const leftTime = Date.parse(left.updatedAt || left.startedAt || left.createdAt || '') || 0;
    const rightTime = Date.parse(right.updatedAt || right.startedAt || right.createdAt || '') || 0;
    return rightTime - leftTime;
  });
  setText('#session-count', items.length);

  const feedback = $('#session-feedback');
  feedback.classList.toggle('is-error', Boolean(state.sessionError));
  if (state.sessionLoading) {
    feedback.hidden = false;
    feedback.textContent = state.loadingSessionId ? '正在恢复这段对话' : '正在读取对话记录';
  } else if (state.sessionError) {
    feedback.hidden = false;
    feedback.textContent = displayText(state.sessionError);
  } else {
    feedback.hidden = true;
    feedback.textContent = '';
  }

  const list = $('#session-list');
  list.setAttribute('aria-busy', String(state.sessionLoading));
  if (!items.length) {
    replaceContent(list, element('p', 'session-empty', state.sessionLoading ? '正在载入最近对话。' : '还没有对话记录。提出第一个问题后，会话会自动保存在这里。'));
    return;
  }

  replaceContent(list, ...items.map((session) => {
    const item = button('', 'session-item');
    const active = String(session.id) === String(state.sessionId);
    item.classList.toggle('is-active', active);
    item.dataset.sessionId = displayText(session.id);
    item.setAttribute('aria-pressed', String(active));
    item.disabled = state.sessionLoading;
    item.append(element('strong', '', sessionTitle(session)));
    item.append(element('small', '', active ? `${sessionDateLabel(session)}，当前对话` : sessionDateLabel(session)));
    return item;
  }));
}

function appendHistoricalNote(message) {
  const article = element('article', 'message message-assistant');
  article.append(element('div', 'message-author', '会话记录'));
  const body = element('div', 'message-body');
  body.append(element('p', '', message.content || '这条记录没有可显示的内容。'));
  article.append(body);
  $('#chat-log').append(article);
}

function renderSessionMessages(messages) {
  const items = asArray(messages);
  const log = $('#chat-log');
  log.setAttribute('aria-busy', 'true');
  replaceContent(log);

  if (!items.length) {
    const article = element('article', 'message message-assistant');
    const author = element('div', 'message-author');
    author.append(element('span', 'tutor-seal', '辅'));
    author.append(document.createTextNode(' 数学辅导员'));
    article.append(author);
    const body = element('div', 'message-body');
    body.append(element('p', '', '这个会话还没有可显示的消息，可以从这里继续提问。'));
    article.append(body);
    log.append(article);
  } else {
    items.forEach((message) => {
      if (message.role === 'user') {
        appendUserMessage(message.content || '');
      } else if (message.role === 'assistant') {
        appendAssistantMessage({
          answer: message.content || '',
          citations: asArray(message.citations),
        }, { historical: true });
      } else {
        appendHistoricalNote(message);
      }
    });
  }

  const lastAssistant = [...items].reverse().find((message) => message.role === 'assistant');
  renderSources(asArray(lastAssistant?.citations));
  $('#starter-row').hidden = items.length > 0;
  log.setAttribute('aria-busy', 'false');
  scrollChat();
}

async function loadSession(sessionId) {
  if (state.loading) {
    showToast('当前回答生成完成后再切换会话。', 'error');
    return;
  }
  const id = displayText(sessionId);
  if (!id || (id === String(state.sessionId) && !state.sessionError)) return;

  const requestId = ++state.sessionRequestId;
  state.sessionLoading = true;
  state.loadingSessionId = id;
  state.sessionError = '';
  renderSessions();

  try {
    const payload = await api(`/api/sessions/${encodeURIComponent(id)}/messages`);
    if (requestId !== state.sessionRequestId) return;
    const session = payload?.session || { id };
    state.sessionId = session.id || id;
    state.data.sessions = [
      session,
      ...asArray(state.data.sessions).filter((item) => String(item.id) !== String(state.sessionId)),
    ];
    renderSessionMessages(payload?.messages);
    announce(`已恢复对话：${sessionTitle(session)}`);
    $('#chat-input').focus();
  } catch (error) {
    if (requestId !== state.sessionRequestId) return;
    state.sessionError = `对话载入失败：${displayText(error.message)}`;
    showToast(state.sessionError, 'error');
  } finally {
    if (requestId === state.sessionRequestId) {
      state.sessionLoading = false;
      state.loadingSessionId = null;
      renderSessions();
    }
  }
}

function renderSearchResults(results, query) {
  const items = asArray(results);
  const target = $('#catalog-list');
  setText('#knowledge-result-title', `“${displayText(query)}”的检索结果`);
  setText('#knowledge-result-count', `${items.length} 条`);
  if (!items.length) {
    replaceContent(target, emptyState('没有找到匹配内容。可以换用教材中的概念名称，或补充更多条件。'));
    return;
  }
  replaceContent(target, ...items.map((source, index) => {
    const card = element('article', 'search-result-card');
    card.append(element('span', 'source-label', `S${index + 1}`));
    const copy = element('div');
    copy.append(element('h4', '', source.title || '未命名来源'));
    copy.append(element('p', '', source.excerpt || '当前分块没有可显示的文字摘录，请查看原页。'));
    const meta = element('div', 'search-result-meta');
    const isOcr = source.evidenceTier === 'ocr_source' || source.docType === 'ocr_page';
    meta.append(element('span', '', isOcr ? '教材依据' : '关联线索'));
    meta.append(element('span', '', sourceLocation(source)));
    if (source.status) meta.append(element('span', '', source.status));
    copy.append(meta);
    card.append(copy);
    const ask = button('据此提问', 'button button-secondary');
    ask.dataset.ask = `请结合教材来源讲解：${displayText(query)}。先说明适用条件，再给一个例子。`;
    card.append(ask);
    return card;
  }));
}

function appendUserMessage(message) {
  const article = element('article', 'message message-user');
  article.append(element('div', 'message-author', '你'));
  const body = element('div', 'message-body');
  body.append(element('p', '', message));
  article.append(body);
  $('#chat-log').append(article);
  scrollChat();
}

function appendLoadingMessage() {
  const article = element('article', 'message message-assistant');
  article.id = 'chat-loading-message';
  const author = element('div', 'message-author');
  author.append(element('span', 'tutor-seal', '辅'));
  author.append(document.createTextNode(' 正在定位教材'));
  article.append(author);
  const body = element('div', 'message-body');
  const typing = element('div', 'typing-row');
  typing.setAttribute('aria-label', '正在生成回答');
  typing.append(element('span'), element('span'), element('span'));
  body.append(typing);
  article.append(body);
  $('#chat-log').append(article);
  scrollChat();
}

function knowledgeTopicFromSources(sources) {
  return asArray(sources).find((source) => /^kp\./.test(displayText(source.sourceId || source.id)));
}

function appendAssistantMessage(result, { historical = false } = {}) {
  const article = element('article', 'message message-assistant');
  const author = element('div', 'message-author');
  author.append(element('span', 'tutor-seal', '辅'));
  author.append(document.createTextNode(' 数学辅导员'));
  article.append(author);
  const body = element('div', 'message-body');
  body.append(element('p', '', result.answer || '本轮没有生成可显示的回答。'));
  article.append(body);

  const meta = element('div', 'message-meta');
  if (historical) {
    meta.append(element('span', '', '历史记录'));
  } else {
    const info = modeInfo(result.mode, result.model);
    meta.append(element('span', '', info.label));
    meta.append(element('span', '', `提示等级 ${result.hintLevel || state.hintLevel}`));
  }
  const citations = asArray(result.citations);
  const sourceCount = citations.length;
  if (sourceCount) meta.append(element('span', '', `引用 ${sourceCount} 处`));
  if (sourceCount) {
    const sourceButton = button('查看引用', 'message-source-button');
    sourceButton.addEventListener('click', () => {
      $$('.message-source-button').forEach((item) => item.classList.toggle('is-active', item === sourceButton));
      renderSources(citations);
      announce(`已显示这轮回答的 ${sourceCount} 处引用`);
    });
    meta.append(sourceButton);
  }
  article.append(meta);

  const topic = knowledgeTopicFromSources(result.citations);
  if (topic && !historical) {
    const review = element('div', 'message-meta review-feedback');
    review.append(element('span', '', '这次练习结果：'));
    const correct = button('独立答对', 'text-button');
    correct.dataset.reviewResult = 'correct';
    correct.dataset.knowledgeId = topic.sourceId || topic.id;
    correct.dataset.knowledgeTitle = topic.title || '';
    correct.dataset.hintLevel = String(result.hintLevel || state.hintLevel);
    const wrong = button('还需复习', 'text-button');
    wrong.dataset.reviewResult = 'wrong';
    wrong.dataset.knowledgeId = topic.sourceId || topic.id;
    wrong.dataset.knowledgeTitle = topic.title || '';
    wrong.dataset.hintLevel = String(result.hintLevel || state.hintLevel);
    review.append(correct, wrong);
    article.append(review);
  }
  $('#chat-log').append(article);
  scrollChat();
}

function appendChatError(message) {
  const article = element('article', 'message message-assistant message-error');
  article.append(element('div', 'message-author', '请求未完成'));
  const body = element('div', 'message-body');
  body.append(element('p', '', message));
  article.append(body);
  $('#chat-log').append(article);
  scrollChat();
}

function scrollChat() {
  const log = $('#chat-log');
  window.requestAnimationFrame(() => log.scrollTo({ top: log.scrollHeight, behavior: 'smooth' }));
}

function renderMistakes() {
  const target = $('#mistake-list');
  let items = asArray(state.data.mistakes);
  if (state.mistakeFilter !== 'all') items = items.filter((item) => item.status === state.mistakeFilter);
  if (!items.length) {
    const labels = { all: '还没有记录错题。每次失分都可以变成下一次的得分点。', active: '没有待复盘错题。', reviewing: '没有正在复盘的错题。', resolved: '还没有已掌握的错题。' };
    replaceContent(target, emptyState(labels[state.mistakeFilter]));
    return;
  }
  replaceContent(target, ...items.map((item) => {
    const card = element('article', 'mistake-card');
    card.dataset.status = item.status || 'active';
    const copy = element('div');
    const kicker = element('div', 'mistake-kicker');
    const statusLabels = { active: '待复盘', reviewing: '复盘中', resolved: '已掌握' };
    kicker.append(element('span', 'status-tag', statusLabels[item.status] || '待复盘'));
    if (item.errorType) kicker.append(element('span', 'error-tag', item.errorType));
    copy.append(kicker);
    copy.append(element('p', 'mistake-question', item.question));
    if (item.analysis) copy.append(element('p', 'mistake-analysis', `原因分析：${item.analysis}`));
    const metaParts = [item.knowledgeId, item.createdAt ? `记录于 ${formatDate(item.createdAt)}` : ''].filter(Boolean);
    if (metaParts.length) copy.append(element('div', 'mistake-meta', metaParts.join(' · ')));
    card.append(copy);
    const actions = element('div', 'mistake-actions');
    const review = button('进入复盘', 'button button-secondary');
    review.dataset.mistakeReview = String(item.id);
    actions.append(review);
    if (item.status !== 'resolved') {
      const resolve = button('标记掌握', 'button button-secondary');
      resolve.dataset.mistakeStatus = 'resolved';
      resolve.dataset.mistakeId = String(item.id);
      actions.append(resolve);
    }
    card.append(actions);
    return card;
  }));
}

function renderProfile() {
  const profile = state.data.profile || {};
  const form = $('#profile-form');
  form.elements.name.value = displayText(profile.name);
  form.elements.examType.value = displayText(profile.examType, '数学一');
  form.elements.targetScore.value = profile.targetScore ?? '';
  form.elements.examDate.value = profile.examDate ? String(profile.examDate).slice(0, 10) : '';
  form.elements.dailyMinutes.value = profile.dailyMinutes ?? '';

  const stats = state.data.indexStats || {};
  setText('#system-files', stats.markdownFileCount ?? 0);
  setText('#system-chunks', stats.chunkCount ?? 0);
  setText('#system-pages', stats.ocrPageCount ?? stats.ocrPageChunkCount ?? 0);
  renderConnection();

  const items = [...asArray(state.data.mastery)].sort((a, b) => Number(a.score ?? 0) - Number(b.score ?? 0));
  setText('#mastery-count', `${items.length} 项`);
  const list = $('#mastery-list');
  if (!items.length) {
    replaceContent(list, emptyState('还没有掌握度记录。完成辅导后进行自评，这里会形成学习轨迹。'));
    return;
  }
  replaceContent(list, ...items.map((item) => {
    const score = clampNumber(item.score, 0, 1) * 100;
    const card = element('article', 'mastery-card');
    const head = element('div', 'mastery-card-head');
    head.append(element('strong', '', item.title || item.knowledgeId));
    head.append(element('small', '', `${Math.round(score)}%`));
    card.append(head);
    card.append(progressBar(score));
    const foot = element('div', 'mastery-card-foot');
    foot.append(element('span', '', `${item.correctCount || 0}/${item.attempts || 0} 次答对`));
    const actions = element('div', 'mastery-actions');
    const practice = button('去练习');
    practice.dataset.ask = `请针对${displayText(item.title || item.knowledgeId)}出一道适合我当前水平的题，先不要给答案。`;
    actions.append(practice);
    foot.append(actions);
    card.append(foot);
    return card;
  }));
}

function populateMistakeKnowledge() {
  const select = $('#mistake-knowledge-select');
  const current = select.value;
  const first = element('option', '', '暂不归类');
  first.value = '';
  const options = asArray(state.data.catalog)
    .filter((item) => (item.type || item.docType) !== 'method_candidate')
    .map((item) => {
      const option = element('option', '', item.title || item.id);
      option.value = item.id || '';
      return option;
    });
  replaceContent(select, first, ...options);
  if ($$(`option`, select).some((option) => option.value === current)) select.value = current;
}

function renderAll({ fillProfile = true } = {}) {
  renderConnection();
  renderToday();
  renderSessions();
  if (state.searchResults) renderSearchResults(state.searchResults.results, state.searchResults.query);
  else renderCatalog();
  renderMistakes();
  if (fillProfile) renderProfile();
  populateMistakeKnowledge();
}

async function loadBootstrap({ quiet = false, fillProfile = true } = {}) {
  if (!quiet) {
    state.sessionLoading = true;
    state.sessionError = '';
    renderSessions();
  }
  try {
    const payload = await api('/api/bootstrap');
    state.data = {
      ...state.data,
      ...(payload || {}),
      indexStats: payload?.indexStats || {},
      catalog: asArray(payload?.catalog),
      mastery: asArray(payload?.mastery),
      mistakes: asArray(payload?.mistakes),
      sessions: asArray(payload?.sessions),
    };
    state.connected = true;
    state.sessionLoading = false;
    state.sessionError = '';
    renderAll({ fillProfile });
    if (!quiet && state.data.mode !== 'model') {
      showToast('当前为检索辅导模式，未配置模型也可继续使用。');
    }
  } catch (error) {
    state.connected = false;
    state.sessionLoading = false;
    state.sessionError = `对话记录读取失败：${displayText(error.message)}`;
    renderConnection(error);
    if (!quiet) showToast(`无法连接本地服务：${displayText(error.message)}`, 'error');
    renderToday();
    renderCatalog();
    renderMistakes();
    renderProfile();
    renderSessions();
  }
}

async function submitChat(message) {
  if (state.loading) return;
  if (state.sessionLoading) {
    showToast('正在恢复旧对话，请稍候再发送。');
    return;
  }
  const clean = displayText(message);
  if (!clean) return;
  const previousSessionId = state.sessionId;
  state.loading = true;
  const send = $('#send-button');
  setBusy(send, true, '发送中');
  $('#chat-input').value = '';
  $('#starter-row').hidden = true;
  appendUserMessage(clean);
  appendLoadingMessage();
  try {
    const result = await api('/api/chat', {
      method: 'POST',
      body: {
        message: clean,
        hintLevel: state.hintLevel,
        ...(state.sessionId ? { sessionId: state.sessionId } : {}),
      },
    });
    $('#chat-loading-message')?.remove();
    state.sessionId = result.sessionId || state.sessionId;
    if (state.sessionId) {
      const existing = asArray(state.data.sessions).find((item) => String(item.id) === String(state.sessionId));
      const now = new Date().toISOString();
      const session = existing
        ? { ...existing, updatedAt: now }
        : {
            id: state.sessionId,
            title: clean.slice(0, 60),
            startedAt: now,
            createdAt: now,
            updatedAt: now,
          };
      state.data.sessions = [
        session,
        ...asArray(state.data.sessions).filter((item) => String(item.id) !== String(state.sessionId)),
      ];
      state.sessionError = '';
      renderSessions();
    }
    if (result.mode) state.data.mode = result.mode;
    if (result.provider) state.data.provider = result.provider;
    if (result.model) state.data.model = result.model;
    appendAssistantMessage({ ...result, hintLevel: result.hintLevel || state.hintLevel });
    renderSources(result.citations);
    renderConnection();
    if (result.providerWarning) showToast('模型连接异常，本轮已切换为检索辅导。', 'error');
    announce(previousSessionId ? '辅导回答已生成' : '新对话已保存，辅导回答已生成');
  } catch (error) {
    $('#chat-loading-message')?.remove();
    appendChatError(`暂时无法完成本轮辅导。${displayText(error.message)}`);
    renderSources([]);
  } finally {
    state.loading = false;
    setBusy(send, false);
    $('#chat-input').focus();
  }
}

async function searchKnowledge(query, submitButton) {
  const clean = displayText(query);
  if (!clean) {
    state.searchResults = null;
    renderCatalog();
    return;
  }
  setBusy(submitButton, true, '检索中');
  try {
    const payload = await api(`/api/search?q=${encodeURIComponent(clean)}&limit=12`);
    state.searchResults = { query: payload.query || clean, results: asArray(payload.results) };
    renderSearchResults(state.searchResults.results, state.searchResults.query);
    announce(`找到 ${state.searchResults.results.length} 条结果`);
  } catch (error) {
    showToast(`检索失败：${displayText(error.message)}`, 'error');
  } finally {
    setBusy(submitButton, false);
  }
}

async function saveProfile(form, submitButton) {
  const data = new FormData(form);
  const payload = {
    name: displayText(data.get('name')) || null,
    subject: '考研数学',
    examType: displayText(data.get('examType'), '数学一'),
    targetScore: data.get('targetScore') ? Number(data.get('targetScore')) : null,
    examDate: data.get('examDate') || null,
    dailyMinutes: data.get('dailyMinutes') ? Number(data.get('dailyMinutes')) : 60,
  };
  setBusy(submitButton, true, '保存中');
  setText('#profile-status', '');
  try {
    const result = await api('/api/profile', { method: 'PUT', body: payload });
    state.data.profile = result.profile || result;
    if (result.plan) state.data.plan = result.plan;
    renderToday();
    setText('#profile-status', '已保存到本机');
    showToast('学习档案已保存。');
  } catch (error) {
    setText('#profile-status', '保存失败');
    showToast(`档案保存失败：${displayText(error.message)}`, 'error');
  } finally {
    setBusy(submitButton, false);
  }
}

async function saveMistake(form, submitButton) {
  const data = new FormData(form);
  const payload = {
    question: displayText(data.get('question')),
    knowledgeId: displayText(data.get('knowledgeId')) || null,
    errorType: displayText(data.get('errorType')) || null,
    userAnswer: displayText(data.get('userAnswer')) || null,
    analysis: displayText(data.get('analysis')) || null,
    status: 'active',
  };
  if (!payload.question) return;
  setBusy(submitButton, true, '保存中');
  try {
    const result = await api('/api/mistakes', { method: 'POST', body: payload });
    const item = result.mistake || result;
    if (result.plan) state.data.plan = result.plan;
    state.data.mistakes = [item, ...asArray(state.data.mistakes).filter((existing) => existing.id !== item.id)];
    renderMistakes();
    renderToday();
    form.reset();
    $('#mistake-dialog').close();
    showToast('错题已记录，记得安排复盘。');
  } catch (error) {
    showToast(`错题保存失败：${displayText(error.message)}`, 'error');
  } finally {
    setBusy(submitButton, false);
  }
}

async function updateMistakeStatus(id, status, sourceButton) {
  setBusy(sourceButton, true, '更新中');
  try {
    const result = await api(`/api/mistakes/${encodeURIComponent(id)}`, { method: 'PATCH', body: { status, reviewedAt: new Date().toISOString() } });
    const item = result.mistake || result;
    if (result.plan) state.data.plan = result.plan;
    state.data.mistakes = asArray(state.data.mistakes).map((existing) => String(existing.id) === String(id) ? item : existing);
    renderMistakes();
    renderToday();
    showToast('错题状态已更新。');
  } catch (error) {
    showToast(`更新失败：${displayText(error.message)}`, 'error');
    setBusy(sourceButton, false);
  }
}

async function recordReview(buttonNode) {
  const group = buttonNode.closest('.review-feedback');
  const correct = buttonNode.dataset.reviewResult === 'correct';
  $$('button', group).forEach((item) => { item.disabled = true; });
  try {
    const result = await api('/api/mastery/review', {
      method: 'POST',
      body: {
        knowledgeId: buttonNode.dataset.knowledgeId,
        title: buttonNode.dataset.knowledgeTitle || null,
        correct,
        hintLevel: Number(buttonNode.dataset.hintLevel || state.hintLevel),
      },
    });
    const record = result.mastery || result;
    if (result.plan) state.data.plan = result.plan;
    state.data.mastery = [
      ...asArray(state.data.mastery).filter((item) => item.knowledgeId !== record.knowledgeId),
      record,
    ];
    replaceContent(group, element('span', '', correct ? '已记录：独立答对' : '已记录：加入复习计划'));
    renderToday();
    renderProfile();
    showToast('练习结果已计入掌握度。');
  } catch (error) {
    $$('button', group).forEach((item) => { item.disabled = false; });
    showToast(`记录失败：${displayText(error.message)}`, 'error');
  }
}

function askFromAction(prompt) {
  const text = displayText(prompt);
  if (!text) return;
  switchView('tutor');
  $('#chat-input').value = text;
  $('#chat-input').focus();
}

function newSession() {
  if (state.loading) {
    showToast('当前回答生成完成后再开始新对话。', 'error');
    return;
  }
  state.sessionRequestId += 1;
  state.sessionLoading = false;
  state.loadingSessionId = null;
  state.sessionError = '';
  state.sessionId = null;
  const log = $('#chat-log');
  const article = element('article', 'message message-assistant');
  const author = element('div', 'message-author');
  author.append(element('span', 'tutor-seal', '辅'));
  author.append(document.createTextNode(' 数学辅导员'));
  article.append(author);
  const body = element('div', 'message-body');
  body.append(element('p', '', '新对话已开始。发来题目、你的思路和卡住的位置，我会重新检索教材。'));
  article.append(body);
  replaceContent(log, article);
  $('#starter-row').hidden = false;
  renderSources([]);
  renderSessions();
  $('#chat-input').value = '';
  $('#chat-input').focus();
  announce('已开始新对话');
}

function bindEvents() {
  document.addEventListener('click', (event) => {
    const viewButton = event.target.closest('[data-view-target]');
    if (viewButton) {
      switchView(viewButton.dataset.viewTarget, { focus: true });
      return;
    }
    const goButton = event.target.closest('[data-go-view]');
    if (goButton) {
      switchView(goButton.dataset.goView, { focus: true });
      return;
    }
    const sessionButton = event.target.closest('[data-session-id]');
    if (sessionButton) {
      loadSession(sessionButton.dataset.sessionId);
      return;
    }
    const askButton = event.target.closest('[data-ask]');
    if (askButton) {
      askFromAction(askButton.dataset.ask);
      return;
    }
    const starter = event.target.closest('[data-starter]');
    if (starter) {
      $('#chat-input').value = starter.dataset.starter;
      $('#chat-input').focus();
      return;
    }
    const reviewButton = event.target.closest('[data-review-result]');
    if (reviewButton) {
      recordReview(reviewButton);
      return;
    }
    const mistakeStatus = event.target.closest('[data-mistake-status]');
    if (mistakeStatus) {
      updateMistakeStatus(mistakeStatus.dataset.mistakeId, mistakeStatus.dataset.mistakeStatus, mistakeStatus);
      return;
    }
    const mistakeReview = event.target.closest('[data-mistake-review]');
    if (mistakeReview) {
      const item = asArray(state.data.mistakes).find((candidate) => String(candidate.id) === mistakeReview.dataset.mistakeReview);
      if (item) askFromAction(`请带我复盘这道错题。先追问我当时的思路，再用提示等级 1 引导我重做。\n\n题目：${displayText(item.question)}\n\n我的作答：${displayText(item.userAnswer, '未记录')}\n\n错误原因：${displayText(item.analysis || item.errorType, '待分析')}`);
    }
  });

  document.addEventListener('keydown', (event) => {
    const askTarget = event.target.closest?.('[data-ask][role="button"]');
    if (askTarget && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      askFromAction(askTarget.dataset.ask);
    }
  });

  $('#theme-toggle').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('kaoyan-tutor-theme', next);
    applyTheme(next);
  });

  $('#chat-form').addEventListener('submit', (event) => {
    event.preventDefault();
    submitChat($('#chat-input').value);
  });

  $('#chat-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      $('#chat-form').requestSubmit();
    }
  });

  $$('input[name="hint-level"]').forEach((input) => input.addEventListener('change', () => {
    state.hintLevel = Number(input.value);
    setText('#hint-description', hintDescriptions[state.hintLevel]);
  }));

  $('#new-session-button').addEventListener('click', newSession);

  $('#knowledge-search-form').addEventListener('submit', (event) => {
    event.preventDefault();
    searchKnowledge($('#knowledge-search').value, event.submitter);
  });

  $$('[data-catalog-filter]').forEach((filter) => filter.addEventListener('click', () => {
    state.catalogFilter = filter.dataset.catalogFilter;
    state.searchResults = null;
    $('#knowledge-search').value = '';
    $$('[data-catalog-filter]').forEach((item) => {
      const active = item === filter;
      item.classList.toggle('is-active', active);
      item.setAttribute('aria-pressed', String(active));
    });
    renderCatalog();
  }));

  $$('[data-mistake-filter]').forEach((filter) => filter.addEventListener('click', () => {
    state.mistakeFilter = filter.dataset.mistakeFilter;
    $$('[data-mistake-filter]').forEach((item) => {
      const active = item === filter;
      item.classList.toggle('is-active', active);
      item.setAttribute('aria-pressed', String(active));
    });
    renderMistakes();
  }));

  $('#profile-form').addEventListener('submit', (event) => {
    event.preventDefault();
    saveProfile(event.currentTarget, event.submitter);
  });

  $('#open-mistake-dialog').addEventListener('click', () => $('#mistake-dialog').showModal());
  $('#mistake-form').addEventListener('submit', (event) => {
    const action = event.submitter?.value;
    if (action === 'cancel') return;
    event.preventDefault();
    saveMistake(event.currentTarget, event.submitter);
  });

  window.addEventListener('hashchange', () => {
    const view = location.hash.slice(1);
    if (viewMeta[view] && view !== state.activeView) switchView(view, { updateHash: false });
  });
}

async function init() {
  applyTheme(initialTheme());
  bindEvents();
  const requestedView = location.hash.slice(1);
  switchView(viewMeta[requestedView] ? requestedView : 'today', { updateHash: false });
  await loadBootstrap();
}

init();
