const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'script.js'), 'utf8');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const response = (data) => ({
  ok: true, status: 200, json: async () => data, blob: async () => new Blob(['media']),
});

class Element {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.children = [];
    this.dataset = {};
    this.listeners = {};
    this.classes = new Set();
    this.classList = {
      contains: (name) => this.classes.has(name),
      toggle: (name, enabled = !this.classes.has(name)) =>
        enabled ? this.classes.add(name) : this.classes.delete(name),
      replace: (oldName, newName) => { this.classes.delete(oldName); this.classes.add(newName); },
    };
    this.paused = true;
  }
  set className(value) { this.classes = new Set(value.split(' ')); }
  set textContent(value) { this.text = value; this.children = []; }
  get textContent() { return this.text || ''; }
  get isConnected() { return this.connected || this.parent?.isConnected || false; }
  get childElementCount() { return this.children.length; }
  append(...children) {
    for (const child of children) {
      if (child.tagName === 'fragment') this.append(...child.children);
      else { child.parent = this; this.children.push(child); }
    }
  }
  appendChild(child) { this.append(child); return child; }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  before(fragment) {
    const index = this.parent.children.indexOf(this);
    for (const child of fragment.children) child.parent = this.parent;
    this.parent.children.splice(index, 0, ...fragment.children);
  }
  remove() {
    if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  removeEventListener(name) { delete this.listeners[name]; }
  async click() { await this.listeners.click?.({ stopPropagation() {}, currentTarget: this }); }
  async play() {
    this.paused = false;
    this.onplay?.({ currentTarget: this });
    this.onplaying?.({ currentTarget: this });
  }
  pause() { this.paused = true; this.onpause?.({ currentTarget: this }); }
  closest() { return null; }
}

function harness({ fetch = async () => { throw new Error('Unexpected network request'); }, files = {}, wkof = true } = {}) {
  const timers = new Map(), saves = [], deleted = [], warnings = [], observers = [], mutations = [];
  const windowEvents = {}, documentEvents = {};
  const body = new Element('body');
  body.connected = true;
  const document = {
    body, visibilityState: 'visible',
    createElement: (tag) => new Element(tag),
    createDocumentFragment: () => new Element('fragment'),
    getElementById: () => null,
    getElementsByTagName: () => [body],
    querySelector: () => null,
    addEventListener: (name, fn) => { documentEvents[name] = fn; },
  };
  const framework = {
    user: { level: 10 },
    include: async () => {}, ready: async () => {},
    file_cache: {
      dir: Object.fromEntries(Object.keys(files).map((key) => [key, {}])),
      load: async (key) => structuredClone(files[key]),
      save: async (key, value) => {
        saves.push([key, structuredClone(value)]);
        files[key] = structuredClone(value);
        framework.file_cache.dir[key] = {};
      },
      delete: async (key) => { deleted.push(key); delete files[key]; delete framework.file_cache.dir[key]; },
    },
  };
  const window = {
    wkof: wkof ? framework : undefined, structuredClone,
    addEventListener: (name, fn) => { windowEvents[name] = fn; },
  };
  let timerId = 0, objectId = 0;
  const revoked = [];
  class BrowserURL extends URL {
    static createObjectURL() { return `blob:test-${++objectId}`; }
    static revokeObjectURL(url) { revoked.push(url); }
  }
  const context = vm.createContext({
    window, document, URL: BrowserURL, Blob,
    wkItemInfo: { forType: () => ({ under: () => ({ notify: () => ({ renew() {}, remove() {} }) }) }) },
    console: { warn: (...args) => warnings.push(args), error: (...args) => warnings.push(args), log() {}, debug() {} },
    fetch,
    setTimeout: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; },
    clearTimeout: (id) => timers.delete(id),
    IntersectionObserver: class {
      constructor(callback, options) { this.callback = callback; this.options = options; this.targets = new Set(); observers.push(this); }
      observe(target) { this.targets.add(target); }
      unobserve(target) { this.targets.delete(target); }
      disconnect() { this.targets.clear(); }
    },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; mutations.push(this); }
      observe(target) { this.target = target; }
      disconnect() {}
    },
  });
  const exports = [
    'state', 'init', 'inFlightRequests', 'mediaObjectUrls', 'ikMediaCacheDB',
    'setCachedData', 'saveCachedImmersionKitData', 'restoreCachedImmersionKitData',
    'fetchImmersionKitDecksIndex', 'fetchImmersionKitData', 'getDifficultySentenceIds',
    'getMediaBlobUrl', 'renderSentences', 'prefetchItem', 'installActiveItemPrefetcher',
    'startBackgroundPrewarmer', 'onFlushCachedDataClicked', 'migrateSettingsVersion',
    'onAppearanceOptionChanged', 'onPlaybackOptionChanged', 'onFetchOptionChanged',
    'onAdvancedOptionChanged', 'onSettingsSaved', 'updateDesiredShows', 'prepareExample', 'Furigana',
    'updateKeyMapForTitles', 'addMissingEntriesToContent',
  ];
  vm.runInContext(source.replace(
    /Promise\.resolve\(\)\s*\.then\(init\)/,
    `window.testAPI = { ${exports.join(',')} }; Promise.resolve()`,
  ), context);
  const api = window.testAPI;
  const media = new Map();
  api.ikMediaCacheDB.get = async (url) => media.get(url);
  api.ikMediaCacheDB.put = async (url, blob) => media.set(url, { url, blob });
  api.ikMediaCacheDB.clear = async () => media.clear();
  api.updateKeyMapForTitles();
  api.addMissingEntriesToContent();
  api.state.wkItemInfo.item = { characters: '猫', type: 'vocabulary' };
  api.state.elements.base = body;
  api.state.elements.sentences = new Element();
  body.append(api.state.elements.sentences);
  return { ...api, timers, saves, deleted, warnings, framework, files, media, observers, mutations, windowEvents, documentEvents, document, revoked };
}

function example(id, sentence = '猫です') {
  return {
    id, title: 'new_game_', sentence, sentence_with_furigana: sentence,
    word_list: ['猫', 'です'], matched_indexes: [{ index: 0, length: 1 }],
    image: `${id}.jpg`, sound: `${id}.mp3`, translation: 'A cat.',
  };
}
const data = (examples = [example('one')]) => ({ examples, deck_count: {} });

for (const [primarySorting, expectedSort] of [
  ['shortness', '&sort=shortness'],
  ['longness', '&sort=longness'],
  ['default', ''],
]) {
  test(`v1 query uses the selected ${primarySorting} sorting`, () => {
    const h = harness();
    const search = h.state.immersionKit.api[1].endpoints.query.getSearch('cat', {
      exactSearch: false,
      exampleLimit: 0,
      jlptLevel: 0,
      primarySorting,
      tags: '',
      waniKaniLevel: false,
    });
    assert.equal(search, `?keyword=cat${expectedSort}`);
  });
}

test('v2 deduplicates active/background requests, normalizes counters, and never revalidates', async () => {
  const pending = deferred(), urls = [];
  const h = harness({ fetch: (url) => { urls.push(url); return pending.promise; } });
  h.state.settings.filters.exactSearch = true;
  h.state.settings.filters.jlptLevel = 5;
  h.state.settings.filters.waniKaniLevel = true;
  h.state.settings.general.dataFetching.checkLastModified = true;
  const a = h.fetchImmersionKitData('〜猫', { background: true });
  const b = h.fetchImmersionKitData('猫');
  pending.resolve(response(data()));
  assert.strictEqual(await a, await b);
  assert.deepEqual(urls, ['https://apiv2.immersionkit.com/search?q=%E7%8C%AB']);
  h.framework.user.level++;
  h.state.settings.sorting.primary = 'longness';
  await h.fetchImmersionKitData('猫');
  assert.equal(urls.length, 1);
  assert.ok(h.state.immersionKit.cache.urls['v2:猫'].cachedAt);
  assert.equal(h.inFlightRequests.size, 0);
});

test('empty results are permanent and never retried', async () => {
  let calls = 0;
  const h = harness({ fetch: async () => { calls++; return response(data([])); } });
  h.state.settings.general.dataFetching.retryCount = 5;
  await h.fetchImmersionKitData('none');
  await h.fetchImmersionKitData('none');
  assert.equal(calls, 1);
  assert.equal(h.state.immersionKit.cache.urls['v2:none'].data.examples.length, 0);
  assert.deepEqual(Object.keys(h.state.immersionKit.cache.urls['v2:none'].data.deck_count), []);
});

test('failed requests are not cached and release deduplication state', async () => {
  const h = harness({ fetch: async () => { throw new Error('offline'); } });
  await assert.rejects(h.fetchImmersionKitData('猫'), /offline/);
  assert.equal(h.inFlightRequests.size, 0);
  assert.equal(h.state.immersionKit.cache.urls['v2:猫'], undefined);
});

test('legacy URL entries survive filter changes, are promoted, and are sharded without deletion', async () => {
  const key = 'media-context-sentences.immersion-kit-data';
  const legacyUrl = 'https://apiv2.immersionkit.com/search?q=猫&wk=3&exactMatch=true';
  const h = harness({ files: { [key]: { [legacyUrl]: { data: data() } } } });
  await h.restoreCachedImmersionKitData();
  assert.equal((await h.fetchImmersionKitData('猫')).examples.length, 1);
  await h.saveCachedImmersionKitData();
  assert.ok(h.state.immersionKit.cache.urls['v2:猫']);
  assert.ok(h.saves.every(([name]) => name.startsWith('wkof.settings.')));
  assert.ok(h.files[key]);
  assert.equal(h.deleted.length, 0);
  const restored = harness({ files: h.files });
  await restored.restoreCachedImmersionKitData();
  assert.equal((await restored.fetchImmersionKitData('猫')).examples.length, 1);
});

test('cache saves are debounced, bounded by a maximum delay, and write only dirty shards', async () => {
  const h = harness();
  for (let i = 0; i < 200; i++) h.setCachedData(`v2:word${i}`, { data: data([]) });
  assert.equal(h.saves.length, 0);
  assert.equal(h.timers.size, 2);
  assert.deepEqual([...h.timers.values()].map(({ ms }) => ms).sort((a, b) => a - b), [2000, 10000]);
  await h.saveCachedImmersionKitData();
  assert.ok(h.saves.length <= 64);
  h.saves.length = 0;
  h.setCachedData('v2:word0', { data: data() });
  await h.saveCachedImmersionKitData();
  assert.equal(h.saves.length, 1);
  const restored = harness({ files: h.files });
  await restored.restoreCachedImmersionKitData();
  assert.equal(Object.keys(restored.state.immersionKit.cache.urls).length, 200);
});

test('deck index is cache-first, nonblocking on a miss, and cannot wipe vocabulary', async () => {
  const pending = deferred();
  const h = harness({ fetch: () => pending.promise });
  h.setCachedData('v2:猫', { data: data() });
  const indexUrl = 'https://apiv2.immersionkit.com/index_meta';
  assert.deepEqual(Object.keys(await h.fetchImmersionKitDecksIndex()), []);
  pending.resolve(response({ data: { new_game_: { title: 'New Game!', category: 'anime', tags: [] } } }));
  await tick();
  assert.ok(h.state.immersionKit.cache.urls['v2:猫']);
  assert.ok(h.state.immersionKit.cache.urls[indexUrl]);
  assert.strictEqual(await h.fetchImmersionKitDecksIndex(), h.state.immersionKit.cache.urls[indexUrl].data);
  assert.equal(h.deleted.length, 0);
});

test('failed deck metadata leaves built-in titles usable', async () => {
  const h = harness();
  await h.fetchImmersionKitDecksIndex();
  await tick();
  assert.ok(h.state.content.allContent.has('New Game!'));
  assert.ok(h.warnings.length);
});

test('difficulty ID masks are deduplicated and retained across level changes without replacing corpus', async () => {
  const urls = [];
  const h = harness({ fetch: async (url) => { urls.push(url); return response(data([example('two')])); } });
  const corpus = data([example('one'), example('two')]);
  h.setCachedData('v2:猫', { data: corpus });
  h.state.settings.filters.jlptLevel = 5;
  h.state.settings.filters.waniKaniLevel = true;
  const [a, b] = await Promise.all([
    h.getDifficultySentenceIds('猫', corpus), h.getDifficultySentenceIds('猫', corpus),
  ]);
  assert.deepEqual([...a], ['two']);
  assert.deepEqual([...b], ['two']);
  assert.equal(urls.length, 1);
  h.framework.user.level++;
  await h.getDifficultySentenceIds('猫', corpus);
  h.framework.user.level--;
  await h.getDifficultySentenceIds('猫', corpus);
  assert.equal(urls.length, 2);
  assert.strictEqual(h.state.immersionKit.cache.urls['v2:猫'].data, corpus);
});

test('media is deduplicated, persisted as Blobs, and reused from memory and disk', async () => {
  let calls = 0;
  const h = harness({ fetch: async () => { calls++; return response({}); } });
  const urls = await Promise.all([h.getMediaBlobUrl('https://media/a.mp3'), h.getMediaBlobUrl('https://media/a.mp3')]);
  assert.equal(urls[0], urls[1]);
  assert.match(urls[0], /^blob:/);
  assert.equal(calls, 1);
  assert.ok(h.media.get('https://media/a.mp3').blob instanceof Blob);
  await h.getMediaBlobUrl('https://media/a.mp3');
  h.mediaObjectUrls.clear();
  assert.match(await h.getMediaBlobUrl('https://media/a.mp3'), /^blob:/);
  assert.equal(calls, 1);
});

test('CORS and storage errors fall back to playable remote media or memory Blobs', async () => {
  const h = harness();
  h.ikMediaCacheDB.get = async () => { throw new Error('IDB disabled'); };
  assert.equal(await h.getMediaBlobUrl('https://media/no-cors'), 'https://media/no-cors');
  assert.ok(h.warnings.length >= 2);
  const writable = harness({ fetch: async () => response({}) });
  writable.ikMediaCacheDB.put = async () => { throw new Error('Quota exceeded'); };
  assert.match(await writable.getMediaBlobUrl('https://media/a'), /^blob:/);
});

test('manual Flush clears all stores and old requests cannot resurrect entries', async () => {
  const pendingJSON = deferred(), pendingMedia = deferred();
  const h = harness({ fetch: (url) => url.includes('/search') ? pendingJSON.promise : pendingMedia.promise });
  h.setCachedData('v2:old', { data: data() });
  await h.saveCachedImmersionKitData();
  h.media.set('old', { blob: new Blob(['old']) });
  const jsonRequest = h.fetchImmersionKitData('new');
  const mediaRequest = h.getMediaBlobUrl('https://media/new');
  await tick();
  let notified = false;
  await h.onFlushCachedDataClicked(null, null, async () => { notified = true; });
  pendingJSON.resolve(response(data()));
  pendingMedia.resolve(response({}));
  await Promise.all([jsonRequest, mediaRequest]);
  assert.ok(notified);
  assert.equal(Object.keys(h.state.immersionKit.cache.urls).length, 0);
  assert.equal(h.media.size, 0);
  assert.equal(h.mediaObjectUrls.size, 0);
  assert.equal(Object.keys(h.files).length, 0);
});

test('rendering sorts before limiting, creates only visible candidates, and preserves raw JSON', async () => {
  let networkCalls = 0;
  const h = harness({ fetch: async () => { networkCalls++; return response({}); } });
  const corpus = data(Array.from({ length: 105 }, (_, i) => example(`${i}`, '猫'.repeat(106 - i))));
  const before = structuredClone(corpus);
  h.setCachedData('v2:猫', { data: corpus });
  h.state.settings.general.appearance.exampleLimit = 3;
  h.state.settings.sorting.primary = 'shortness';
  await h.renderSentences();
  assert.equal(h.state.elements.sentences.children.length, 3);
  assert.equal(h.state.elements.sentences.children[0].children[1].children[0].children[0].id, 'audio-button-104');
  assert.deepEqual(corpus, before);
  assert.equal(networkCalls, 0);
  const observer = h.observers[0];
  assert.equal(observer.targets.size, 3);
  const img = [...observer.targets][0];
  assert.equal(img.loading, 'lazy');
  assert.equal(img.decoding, 'async');
  assert.equal(img.src, undefined);
  observer.callback([{ target: img, isIntersecting: true }]);
  await tick();
  assert.equal(networkCalls, 1);
  assert.match(img.src, /^blob:/);
});

test('unlimited results render in batches of 20 and remain accessible', async () => {
  const h = harness();
  h.setCachedData('v2:猫', { data: data(Array.from({ length: 45 }, (_, i) => example(`${i}`))) });
  await h.renderSentences();
  const container = h.state.elements.sentences;
  assert.equal(container.children.filter((child) => child.classList.contains('example')).length, 20);
  const button = container.children.at(-1);
  await button.click();
  assert.equal(container.children.filter((child) => child.classList.contains('example')).length, 40);
  await button.click();
  assert.equal(container.children.length, 45);
});

test('exact search, exact match, source selection, and Furigana remain client-side', () => {
  const h = harness();
  h.state.settings.filters.exactSearch = true;
  assert.ok(h.prepareExample(example('one'), '猫'));
  assert.equal(h.prepareExample({ ...example('compound'), word_list: ['猫耳'] }, '猫'), null);
  h.state.settings.filters.exactSearch = false;
  h.state.settings.filters.exactMatch = true;
  assert.equal(h.prepareExample(example('missing', 'いぬ'), '猫'), null);
  const furigana = new h.Furigana('猫です', '猫[ねこ]です');
  furigana.setKeyword('猫');
  assert.match(furigana.getFuriganaHtml(), /<ruby>.*<rt>ねこ<\/rt>/);
});

test('Furigana escapes third-party text while preserving keyword markup', () => {
  const h = harness();
  const source = '<img src=x onerror=alert(1)>猫';
  const furigana = new h.Furigana(
    source,
    '<img src=x onerror=alert(1)>猫[<svg onload=alert(1)>]',
  );
  furigana.setKeyword('猫');

  const html = furigana.getFuriganaHtml();
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('<mark>猫</mark>'));
  assert.ok(html.includes('&lt;svg onload=alert(1)&gt;'));
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('<svg'));

  const expressionHtml = furigana.getExpressionHtml();
  assert.ok(expressionHtml.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(expressionHtml.includes('<mark>猫</mark>'));
  assert.ok(!expressionHtml.includes('<img'));
});

test('active event prefetches JSON and only the two shortest matching audio clips', async () => {
  const urls = [];
  const h = harness({ fetch: async (url) => {
    urls.push(url);
    return url.includes('/search')
      ? response(data([example('long', '猫ですよ'), example('short', '猫'), example('mid', '猫だ')]))
      : response({});
  } });
  h.installActiveItemPrefetcher();
  h.windowEvents.willShowNextQuestion({ detail: { subject: { type: 'Vocabulary', characters: '猫' } } });
  await tick();
  await tick();
  assert.equal(urls.length, 3);
  assert.ok(urls.some((url) => url.endsWith('/short.mp3')));
  assert.ok(urls.some((url) => url.endsWith('/mid.mp3')));
  assert.ok(!urls.some((url) => url.endsWith('/long.mp3')));
  assert.equal(h.state.elements.sentences.textContent, '');
});

test('background crawler selects current level, lessons and Apprentice/Guru vocabulary, and pauses for active requests', async () => {
  const urls = [], active = deferred();
  const h = harness({ fetch: (url) => {
    urls.push(url);
    return url.includes('active') ? active.promise : Promise.resolve(response(data([])));
  } });
  const item = (characters, level, stage, object = 'vocabulary') => ({
    object, data: { characters, level },
    assignments: { unlocked_at: '2026-01-01', srs_stage: stage },
  });
  h.framework.ItemData = { get_items: async (endpoint) => {
    assert.equal(endpoint, 'assignments');
    return [item('level', 10, 8), item('lesson', 8, 0), item('guru', 8, 6), item('skip', 8, 7), item('kanji', 10, 1, 'kanji')];
  } };
  const lookup = h.fetchImmersionKitData('active');
  const crawl = h.startBackgroundPrewarmer();
  await tick();
  const runTimer = async (ms) => {
    const timer = [...h.timers].find(([, value]) => value.ms === ms);
    assert.ok(timer, `Expected ${ms}ms timer`);
    h.timers.delete(timer[0]);
    timer[1].fn();
    await tick();
  };
  await runTimer(1500);
  assert.equal(urls.length, 1);
  active.resolve(response(data([])));
  await lookup;
  await runTimer(250);
  await runTimer(1500);
  await runTimer(1500);
  await crawl;
  assert.deepEqual(urls.map((url) => new URL(url).searchParams.get('q')), ['active', 'level', 'lesson', 'guru']);
});

test('script remains usable without WKOF', async () => {
  const h = harness({ wkof: false, fetch: async () => response(data([])) });
  await h.restoreCachedImmersionKitData();
  await h.fetchImmersionKitData('猫');
  await h.saveCachedImmersionKitData();
  assert.equal(h.state.immersionKit.cache.urls['v2:猫'].data.examples.length, 0);
});

test('initialization does not wait for deck metadata, even on an indefinitely stalled connection', async () => {
  const pending = deferred();
  const h = harness({ wkof: false, fetch: () => pending.promise });
  await h.init();
  assert.ok(h.windowEvents.willShowNextQuestion);
  assert.ok(h.windowEvents.beforeunload);
  assert.ok(h.documentEvents.visibilitychange);
  assert.ok(h.state.content.allContent.has('New Game!'));
  h.setCachedData('v2:persist', { data: data() });
  await h.windowEvents.beforeunload();
  h.document.visibilityState = 'hidden';
  h.documentEvents.visibilitychange();
});

for (const version of ['2026-10-19', '2026-10-20', '4.0.0', '4.1.0', '10.0.0']) {
  test(`settings migration leaves ${version} settings untouched`, async () => {
    const settingsKey = 'wkof.settings.media-context-sentences';
    const h = harness({ files: { [settingsKey]: { version } } });
    h.state.settings.version = version;
    const settingsBefore = structuredClone(h.state.settings);
    h.framework.settings = { 'media-context-sentences': h.state.settings };
    h.framework.Settings = {
      load: async () => assert.fail('Modern settings must not be reloaded'),
      save: async () => assert.fail('Modern settings must not be saved'),
    };
    await h.migrateSettingsVersion();
    assert.deepEqual(h.deleted, []);
    assert.deepEqual(h.files[settingsKey], { version });
    assert.deepEqual(structuredClone(h.state.settings), settingsBefore);
  });
}

test('settings migration deletes only old settings, never cached lookups', async () => {
  const settingsKey = 'wkof.settings.media-context-sentences';
  const h = harness({ files: { [settingsKey]: {} } });
  const currentVersion = h.state.settings.version;
  h.state.settings.version = '3.0.0';
  h.setCachedData('v2:猫', { data: data() });
  h.framework.settings = { 'media-context-sentences': {} };
  const calls = [];
  h.framework.Settings = {
    load: async () => { calls.push('load'); return structuredClone(h.state.settings); },
    save: async () => { calls.push('save'); },
  };
  await h.migrateSettingsVersion();
  assert.deepEqual(h.deleted, [settingsKey]);
  assert.deepEqual(calls, ['load', 'save']);
  assert.equal(h.framework.settings['media-context-sentences'].version, currentVersion);
  assert.ok(h.state.immersionKit.cache.urls['v2:猫']);
});

test('settings handlers tolerate missing page elements and update every audio element', async () => {
  const appearance = harness();
  appearance.state.elements.sentences = null;
  for (const [name, value] of [
    ['showEnglish', 'never'],
    ['showJapanese', 'never'],
    ['showFurigana', 'never'],
  ]) {
    await appearance.onAppearanceOptionChanged(name, value);
    assert.equal(appearance.state.settings.general.appearance[name], value);
  }

  const retry = harness();
  retry.state.elements.sentences = null;
  await retry.onFetchOptionChanged('retryCount', 1);
  assert.equal(retry.state.settings.general.dataFetching.retryCount, 1);

  for (const missing of ['item', 'sentences']) {
    const advanced = harness();
    if (missing === 'item') {
      advanced.state.wkItemInfo.item = null;
    } else {
      advanced.state.elements.sentences = null;
    }
    await advanced.onAdvancedOptionChanged('failWhenHidden', true);
    assert.equal(advanced.state.settings.general.advanced.failWhenHidden, true);
  }

  const audioElements = [{}, {}];
  const playback = harness();
  playback.state.elements.base = {
    querySelectorAll: (selector) => {
      assert.equal(selector, 'audio');
      return audioElements;
    },
  };
  await playback.onPlaybackOptionChanged('playbackRate', 150);
  await playback.onPlaybackOptionChanged('playbackVolume', 40);
  assert.deepEqual(audioElements, [
    { playbackRate: 3, volume: 0.4 },
    { playbackRate: 3, volume: 0.4 },
  ]);

  playback.state.elements.base = null;
  await playback.onPlaybackOptionChanged('playbackRate', 175);
});

test('mutations during an in-progress shard save are persisted in a second write', async () => {
  const h = harness(), pending = deferred();
  const save = h.framework.file_cache.save;
  let calls = 0;
  h.framework.file_cache.save = async (key, value) => {
    if (++calls === 1) await pending.promise;
    await save(key, value);
  };
  h.setCachedData('v2:猫', { data: data([]) });
  const saving = h.saveCachedImmersionKitData();
  h.setCachedData('v2:猫', { data: data() });
  pending.resolve();
  await saving;
  assert.equal(calls, 2);
  const restored = harness({ files: h.files });
  await restored.restoreCachedImmersionKitData();
  assert.equal(restored.state.immersionKit.cache.urls['v2:猫'].data.examples.length, 1);
});

test('failed persistence retains dirty data for a later explicit retry', async () => {
  const h = harness(), save = h.framework.file_cache.save;
  h.setCachedData('v2:猫', { data: data() });
  h.framework.file_cache.save = async () => { throw new Error('quota'); };
  await assert.rejects(h.saveCachedImmersionKitData(), /quota/);
  h.framework.file_cache.save = save;
  await h.saveCachedImmersionKitData();
  assert.equal(h.saves.length, 1);
});

test('mutation fallback warms a newly mounted character header without waiting for Item Info', async () => {
  const urls = [], h = harness({ fetch: async (url) => { urls.push(url); return response(data([])); } });
  h.installActiveItemPrefetcher();
  const header = new Element();
  header.textContent = '犬';
  h.document.querySelector = () => header;
  h.mutations[0].callback();
  await tick();
  assert.equal(new URL(urls[0]).searchParams.get('q'), '犬');
  header.textContent = '猫';
  h.mutations[1].callback();
  await tick();
  assert.equal(new URL(urls[1]).searchParams.get('q'), '猫');
});

test('audio buttons load cached Blobs and preserve playback settings, pause and resume', async () => {
  let calls = 0;
  const h = harness({ fetch: async () => { calls++; return response({}); } });
  h.setCachedData('v2:猫', { data: data() });
  h.state.settings.general.playback.playbackRate = 60;
  h.state.settings.general.playback.playbackVolume = 40;
  await h.renderSentences();
  const button = h.state.elements.sentences.children[0].children[1].children[0].children[0];
  await button.click();
  const audio = h.state.elements.audio[button.id].audio;
  assert.match(audio.src, /^blob:/);
  assert.equal(audio.playbackRate, 1.2);
  assert.equal(audio.volume, 0.4);
  assert.equal(audio.paused, false);
  await button.click();
  assert.equal(audio.paused, true);
  await button.click();
  assert.equal(audio.paused, false);
  assert.equal(calls, 1);
});

test('manual Flush and saving settings are safe on dashboards without an Item Info item', async () => {
  const h = harness();
  h.state.wkItemInfo.item = null;
  h.state.elements.sentences = null;
  await h.onFlushCachedDataClicked(null, null, async () => {});
  await h.onSettingsSaved(structuredClone(h.state.settings));
});

test('audio indicates loading immediately, ignores duplicate clicks and tracks buffering and stopping', async () => {
  const pending = deferred();
  let calls = 0;
  const h = harness({ fetch: () => { calls++; return pending.promise; } });
  h.setCachedData('v2:猫', { data: data() });
  await h.renderSentences();
  const button = h.state.elements.sentences.children[0].children[1].children[0].children[0];
  const playback = button.click();
  assert.equal(button.textContent, '⏳');
  assert.equal(button.title, 'Loading audio…');
  assert.equal(button.ariaBusy, 'true');
  assert.equal(button.ariaLabel, button.title);
  await button.click();
  await tick();
  assert.equal(calls, 1);
  pending.resolve(response({}));
  await playback;
  assert.equal(button.textContent, '🔊');
  assert.equal(button.ariaBusy, 'false');
  const audio = h.state.elements.audio[button.id].audio;
  audio.onwaiting();
  assert.equal(button.textContent, '⏳');
  audio.onplaying();
  assert.equal(button.textContent, '🔊');
  await button.click();
  assert.equal(button.textContent, '🔈');
  assert.equal(button.title, 'Play Audio');
  assert.equal(button.ariaBusy, 'false');
});

test('audio loading indicator resets on playback rejection and native media errors', async () => {
  const h = harness({ fetch: async () => response({}) });
  h.setCachedData('v2:猫', { data: data() });
  await h.renderSentences();
  const button = h.state.elements.sentences.children[0].children[1].children[0].children[0];
  const create = h.document.createElement;
  h.document.createElement = (tag) => {
    const element = create(tag);
    if (tag === 'audio') element.play = async () => { throw new Error('Playback blocked'); };
    return element;
  };
  await button.click();
  assert.equal(button.textContent, '🔈');
  assert.equal(button.ariaBusy, 'false');
  const audio = h.state.elements.audio[button.id].audio;
  audio.onerror();
  assert.equal(button.textContent, '⏳');
  await tick();
  assert.equal(button.textContent, '🔈');
  audio.onwaiting();
  audio.onerror();
  assert.equal(button.textContent, '🔈');
  assert.equal(button.ariaBusy, 'false');
  assert.ok(h.warnings.length);
});
