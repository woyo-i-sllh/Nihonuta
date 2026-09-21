'use strict';

const PAGE_SIZE = 60;
const collator = new Intl.Collator(['ja', 'zh-Hans', 'en'], { numeric: true, sensitivity: 'base' });
const $ = (id) => document.getElementById(id);

const els = {
  songCount: $('songCount'),
  artistCount: $('artistCount'),
  buildDate: $('buildDate'),
  searchInput: $('searchInput'),
  clearSearch: $('clearSearch'),
  artistFilter: $('artistFilter'),
  sortMode: $('sortMode'),
  randomButton: $('randomButton'),
  updateButton: $('updateButton'),
  searchStatus: $('searchStatus'),
  indexStatus: $('indexStatus'),
  resultsTitle: $('resultsTitle'),
  resultsCount: $('resultsCount'),
  results: $('results'),
  emptyState: $('emptyState'),
  loadingState: $('loadingState'),
  loadMore: $('loadMore'),
  fatalState: $('fatalState'),
  fatalMessage: $('fatalMessage'),
  resetSearch: $('resetSearch'),
  template: $('songCardTemplate'),
  repoLink: $('repoLink'),
  footerRepoLink: $('footerRepoLink'),
};

const state = {
  site: null,
  catalog: [],
  fullText: new Map(),
  fullFold: new Map(),
  filtered: [],
  renderedLimit: PAGE_SIZE,
  query: '',
  artist: '',
  sort: 'title',
  shardPromise: null,
  shardLoaded: 0,
  shardTotal: 0,
  hasUpdate: false,
  debounceTimer: 0,
  updateTimer: 0,
};

function normalize(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('ja')
    .replace(/[\u3000\s]+/g, ' ')
    .trim();
}

function compact(value) {
  return normalize(value).replace(/\s+/g, '');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function fetchJSON(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

function formatDate(value) {
  if (!value) return '日期未知';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }).format(date);
}

function updateURL() {
  const params = new URLSearchParams();
  if (state.query) params.set('q', state.query);
  if (state.artist) params.set('artist', state.artist);
  if (state.sort !== 'title') params.set('sort', state.sort);
  const next = `${location.pathname}${params.toString() ? `?${params}` : ''}${location.hash}`;
  history.replaceState(null, '', next);
}

function prepareCatalog(items) {
  for (const item of items) {
    item._title = normalize(item.t);
    item._artist = normalize(item.a);
    item._cn = normalize(item.c);
    item._reading = normalize(item.r);
    item._meta = normalize([item.t, item.a, item.c, item.r, item.p, item.u].join('\n'));
  }
}

function populateArtists(items) {
  const counts = new Map();
  for (const item of items) {
    if (!item.a) continue;
    counts.set(item.a, (counts.get(item.a) || 0) + 1);
  }
  const artists = [...counts.keys()].sort((a, b) => collator.compare(a, b));
  const fragment = document.createDocumentFragment();
  for (const artist of artists) {
    const option = document.createElement('option');
    option.value = artist;
    option.textContent = `${artist}（${counts.get(artist)}）`;
    fragment.appendChild(option);
  }
  els.artistFilter.appendChild(fragment);
}

function artistMatches(item) {
  return !state.artist || item.a === state.artist;
}

function metadataScore(item, terms) {
  let score = 0;
  for (const term of terms) {
    let best = 0;
    if (item._title === term) best = 260;
    else if (item._title.startsWith(term)) best = 190;
    else if (item._title.includes(term)) best = 145;
    if (item._artist.includes(term)) best = Math.max(best, 105);
    if (item._cn.includes(term)) best = Math.max(best, 90);
    if (item._reading.includes(term)) best = Math.max(best, 78);
    if (normalize(item.p).includes(term)) best = Math.max(best, 42);
    if (normalize(item.u).includes(term)) best = Math.max(best, 24);
    if (!best) return null;
    score += best;
  }
  return score;
}

function fullTextScore(item, terms) {
  const text = state.fullFold.get(item.i);
  if (!text) return null;
  let score = 0;
  for (const term of terms) {
    const at = text.indexOf(term);
    if (at < 0) return null;
    score += at === 0 ? 52 : 34;
  }
  return score;
}

function makeSnippet(item, terms) {
  const raw = state.fullText.get(item.i);
  if (!raw) return item.p || '';
  const flattened = raw.replace(/\s+/g, ' ').trim();
  const lower = flattened.toLocaleLowerCase('ja');
  let index = -1;
  for (const term of terms) {
    const found = lower.indexOf(term);
    if (found >= 0 && (index < 0 || found < index)) index = found;
  }
  if (index < 0) return item.p || flattened.slice(0, 150);
  const start = Math.max(0, index - 44);
  const end = Math.min(flattened.length, index + 112);
  return `${start > 0 ? '…' : ''}${flattened.slice(start, end)}${end < flattened.length ? '…' : ''}`;
}

function appendMarkedText(element, text, terms) {
  element.replaceChildren();
  const usable = terms.filter((term) => term && text.toLocaleLowerCase('ja').includes(term));
  if (!usable.length) {
    element.textContent = text;
    return;
  }
  const pattern = usable
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|');
  const regex = new RegExp(`(${pattern})`, 'giu');
  let last = 0;
  for (const match of text.matchAll(regex)) {
    if (match.index > last) element.appendChild(document.createTextNode(text.slice(last, match.index)));
    const mark = document.createElement('mark');
    mark.textContent = match[0];
    element.appendChild(mark);
    last = match.index + match[0].length;
  }
  if (last < text.length) element.appendChild(document.createTextNode(text.slice(last)));
}

function runSearch(resetLimit = true) {
  const query = normalize(state.query);
  const terms = query ? query.split(' ').filter(Boolean) : [];
  const next = [];

  for (const item of state.catalog) {
    if (!artistMatches(item)) continue;
    let score = 0;
    let reason = '';
    let snippet = item.p || '';

    if (terms.length) {
      const metaScore = metadataScore(item, terms);
      const textScore = fullTextScore(item, terms);
      if (metaScore === null && textScore === null) continue;
      score = Math.max(metaScore || 0, textScore ? textScore + 18 : 0);
      reason = textScore !== null && (metaScore === null || textScore + 18 > metaScore) ? '歌词命中' : '资料命中';
      if (textScore !== null) snippet = makeSnippet(item, terms);
    }

    next.push({ item, score, reason, snippet });
  }

  next.sort((a, b) => {
    if (terms.length && b.score !== a.score) return b.score - a.score;
    if (state.sort === 'artist') {
      const artist = collator.compare(a.item.a || '', b.item.a || '');
      return artist || collator.compare(a.item.t || '', b.item.t || '');
    }
    if (state.sort === 'links') {
      return (b.item.l || 0) - (a.item.l || 0) || collator.compare(a.item.t || '', b.item.t || '');
    }
    return collator.compare(a.item.t || '', b.item.t || '');
  });

  state.filtered = next;
  state.renderedLimit = resetLimit ? PAGE_SIZE : Math.max(PAGE_SIZE, state.renderedLimit);
  renderResults(terms);
  updateSearchSummary();
}

function renderResults(terms = []) {
  const visible = state.filtered.slice(0, state.renderedLimit);
  const fragment = document.createDocumentFragment();

  for (const result of visible) {
    const { item } = result;
    const card = els.template.content.firstElementChild.cloneNode(true);
    card.href = item.u;
    card.dataset.songId = item.i;
    card.setAttribute('aria-label', `${item.t}${item.a ? `，${item.a}` : ''}`);

    card.querySelector('.song-number').textContent = `NO. ${String(item.i).padStart(4, '0')}`;
    const badge = card.querySelector('.match-badge');
    if (result.reason) {
      badge.textContent = result.reason;
      badge.classList.add('show');
    }

    const title = card.querySelector('.song-title');
    title.innerHTML = item.th || document.createTextNode(item.t).textContent;

    const cn = card.querySelector('.song-cn');
    if (item.c) cn.textContent = item.c;
    else cn.hidden = true;

    const artist = card.querySelector('.song-artist');
    if (item.a) artist.textContent = item.a;
    else artist.hidden = true;

    appendMarkedText(card.querySelector('.song-preview'), result.snippet || item.p || '打开歌词卡查阅正文', terms);
    card.querySelector('.link-count').textContent = item.l ? `${item.l} 个相关链接` : '在线歌词卡';
    fragment.appendChild(card);
  }

  els.results.replaceChildren(fragment);
  els.emptyState.hidden = state.filtered.length !== 0;
  els.loadMore.hidden = state.filtered.length <= state.renderedLimit;
  els.loadMore.textContent = `继续显示（还有 ${Math.max(0, state.filtered.length - state.renderedLimit)} 首）`;
}

function updateSearchSummary() {
  const query = state.query.trim();
  const shown = Math.min(state.renderedLimit, state.filtered.length);
  els.resultsTitle.textContent = query ? `“${query}”的搜索结果` : state.artist ? `${state.artist}的歌词` : '全部歌词';
  els.resultsCount.textContent = `${state.filtered.length} 首${state.filtered.length > shown ? ` · 显示 ${shown}` : ''}`;
  els.searchStatus.textContent = query
    ? `找到 ${state.filtered.length} 首符合条件的歌词`
    : `共 ${state.catalog.length} 首，当前显示 ${shown} 首`;
  els.clearSearch.hidden = !query;
  document.title = query ? `${query} · 日本歌` : '日本歌 · 日语歌词资料库';
}

function updateIndexStatus(message) {
  if (message) {
    els.indexStatus.textContent = message;
    return;
  }
  if (!state.shardTotal) {
    els.indexStatus.textContent = '全文索引准备中';
    return;
  }
  const loaded = state.shardLoaded === state.shardTotal ? '可检索全文歌词' : `载入中 ${state.shardLoaded}/${state.shardTotal}`;
  els.indexStatus.textContent = `${loaded} · ${state.catalog.length} 首`;
}

async function loadFullIndex() {
  if (state.shardPromise) return state.shardPromise;
  state.shardPromise = (async () => {
    try {
      const manifest = await fetchJSON(state.site.search_manifest_url);
      state.shardTotal = manifest.shards.length;
      updateIndexStatus();
      for (const shard of manifest.shards) {
        const rows = await fetchJSON(`data/search/${shard}`);
        for (const [id, text] of rows) {
          state.fullText.set(id, text);
          state.fullFold.set(id, normalize(text));
        }
        state.shardLoaded += 1;
        updateIndexStatus();
        if (state.query.trim() && (state.shardLoaded % 4 === 0 || state.shardLoaded === state.shardTotal)) {
          runSearch(false);
        }
      }
    } catch (error) {
      console.warn('Full-text index unavailable:', error);
      els.indexStatus.textContent = '全文索引暂不可用；歌名、歌手和翻译仍可搜索';
    }
  })();
  return state.shardPromise;
}

function resetFilters() {
  state.query = '';
  state.artist = '';
  els.searchInput.value = '';
  els.artistFilter.value = '';
  updateURL();
  runSearch();
}

function scheduleSearch() {
  clearTimeout(state.debounceTimer);
  state.debounceTimer = window.setTimeout(() => {
    state.query = els.searchInput.value.trim();
    updateURL();
    runSearch();
  }, 110);
}

function chooseRandom() {
  let pool = state.filtered.length ? state.filtered : state.catalog.map((item) => ({ item }));
  if (!pool.length) {
    resetFilters();
    pool = state.catalog.map((item) => ({ item }));
  }
  const result = pool[Math.floor(Math.random() * pool.length)];
  window.open(result.item.u, '_blank', 'noopener');
}

async function checkForUpdates(manual = false) {
  if (!state.site) return;
  els.updateButton.disabled = true;
  try {
    const latest = await fetchJSON(`data/site.json?check=${Date.now()}`, { cache: 'no-store' });
    state.hasUpdate = latest.version !== state.site.version;
    if (state.hasUpdate) {
      els.updateButton.classList.add('has-update');
      els.updateButton.lastChild.textContent = '发现更新 · 点击刷新';
      els.searchStatus.textContent = `资料库已有新版本（${latest.song_count} 首）`;
      if (manual && confirm('资料库已更新，是否立即刷新页面？')) location.reload();
    } else if (manual) {
      els.searchStatus.textContent = '已经是最新版本';
    }
  } catch (error) {
    if (manual) els.searchStatus.textContent = '暂时无法检查更新，请稍后再试';
    console.warn('Update check failed:', error);
  } finally {
    els.updateButton.disabled = false;
  }
}

function bindEvents() {
  els.searchInput.addEventListener('input', scheduleSearch);
  els.searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      state.query = '';
      els.searchInput.value = '';
      updateURL();
      runSearch();
      els.searchInput.blur();
    }
  });
  els.artistFilter.addEventListener('change', () => {
    state.artist = els.artistFilter.value;
    updateURL();
    runSearch();
  });
  els.sortMode.addEventListener('change', () => {
    state.sort = els.sortMode.value;
    updateURL();
    runSearch();
  });
  els.clearSearch.addEventListener('click', resetFilters);
  els.resetSearch.addEventListener('click', resetFilters);
  els.randomButton.addEventListener('click', chooseRandom);
  els.loadMore.addEventListener('click', () => {
    state.renderedLimit += PAGE_SIZE;
    renderResults(normalize(state.query).split(' ').filter(Boolean));
    updateSearchSummary();
  });
  els.updateButton.addEventListener('click', () => {
    if (state.hasUpdate) location.reload();
    else checkForUpdates(true);
  });
  window.addEventListener('popstate', applyLocationState);
  document.addEventListener('keydown', (event) => {
    if (event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey && document.activeElement !== els.searchInput) {
      event.preventDefault();
      els.searchInput.focus();
      els.searchInput.select();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkForUpdates(false);
  });
}

function applyLocationState() {
  const params = new URLSearchParams(location.search);
  state.query = params.get('q') || '';
  state.artist = params.get('artist') || '';
  state.sort = params.get('sort') || 'title';
  els.searchInput.value = state.query;
  els.artistFilter.value = state.artist;
  els.sortMode.value = state.sort;
  runSearch();
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  navigator.serviceWorker.register('sw.js').catch((error) => console.warn('Service worker registration failed:', error));
}

function showFatal(error) {
  els.loadingState.hidden = true;
  els.fatalState.hidden = false;
  if (location.protocol === 'file:') {
    els.fatalMessage.textContent = '浏览器不允许本地网页读取 JSON 索引。请在 public\\Nihonuta 目录运行 python -m http.server 8080 --directory site，再访问 http://localhost:8080/。';
  } else {
    els.fatalMessage.textContent = `载入 data/site.json 或 data/catalog.json 失败：${error.message}`;
  }
  els.searchStatus.textContent = '载入失败';
}

async function init() {
  bindEvents();
  registerServiceWorker();
  try {
    state.site = await fetchJSON('data/site.json', { cache: 'no-cache' });
    state.catalog = await fetchJSON(state.site.catalog_url, { cache: 'no-cache' });
    prepareCatalog(state.catalog);
    populateArtists(state.catalog);

    els.songCount.textContent = state.site.song_count.toLocaleString('zh-CN');
    els.artistCount.textContent = state.site.artist_count.toLocaleString('zh-CN');
    els.buildDate.textContent = `更新于 ${formatDate(state.site.latest_source_date || state.site.generated_at)}`;
    els.repoLink.href = state.site.repository;
    els.footerRepoLink.href = state.site.repository;
    els.loadingState.hidden = true;

    applyLocationState();
    updateIndexStatus();
    window.setTimeout(loadFullIndex, 450);
    state.updateTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible') checkForUpdates(false);
    }, 5 * 60 * 1000);
  } catch (error) {
    console.error(error);
    showFatal(error);
  }
}

init();