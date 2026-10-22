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
    this.attributes = {};
    this.listeners = {};
    this.classes = new Set();
    this.classList = {
      contains: (name) => this.classes.has(name),
      toggle: (name, enabled = !this.classes.has(name)) =>
        enabled ? this.classes.add(name) : this.classes.delete(name),
      replace: (oldName, newName) => { this.classes.delete(oldName); this.classes.add(newName); },
    };
    this.paused = true;
    this.offsetHeight = 20;
  }
  set className(value) { this.classes = new Set(value.split(' ')); }
  get className() { return [...this.classes].join(' '); }
  get options() { return this.tagName === 'select' ? this.children : undefined; }
  set value(value) { this._value = value; }
  get value() { return this._value ?? this.children[0]?.value ?? ''; }
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
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  async click() { await this.listeners.click?.({ stopPropagation() {}, currentTarget: this }); }
  async play() {
    this.paused = false;
    this.onplay?.({ currentTarget: this });
    this.onplaying?.({ currentTarget: this });
  }
  pause() { this.paused = true; this.onpause?.({ currentTarget: this }); }
  closest(selector) {
    if (selector !== 'li[data-source-title]') return null;
    let element = this;
    while (element) {
      if (element.tagName === 'li' && element.dataset.sourceTitle) return element;
      element = element.parent;
    }
    return null;
  }
  getBoundingClientRect() { return { top: 0 }; }
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
    'onAdvancedOptionChanged', 'onSettingsSaved', 'onSettingsClosed', 'loadSettings',
    'updateDesiredShows', 'prepareExample', 'Furigana',
    'updateKeyMapForTitles', 'addMissingEntriesToContent', 'sortSentences',
    'movePreferredSourceInOrder', 'renderPreferredSourcesSettings',
    'getMediaCacheTrimPlan',
    'scheduleMenuInstall',
  ];
  vm.runInContext(source.replace(
    /Promise\.resolve\(\)\s*\.then\(init\)/,
    `window.testAPI = { ${exports.join(',')} }; Promise.resolve()`,
  ), context);
  const api = window.testAPI;
  const media = new Map();
  const mediaPutLimits = [];
  api.ikMediaCacheDB.get = async (url) => media.get(url);
  api.ikMediaCacheDB.put = async (url, blob, maxBytes) => {
    mediaPutLimits.push(maxBytes);
    media.set(url, { url, blob });
  };
  api.ikMediaCacheDB.trimToLimit = async () => {};
  api.ikMediaCacheDB.clear = async () => media.clear();
  api.updateKeyMapForTitles();
  api.addMissingEntriesToContent();
  api.state.wkItemInfo.item = { characters: '猫', type: 'vocabulary' };
  api.state.elements.base = body;
  api.state.elements.sentences = new Element();
  body.append(api.state.elements.sentences);
  return { ...api, timers, saves, deleted, warnings, framework, files, media, mediaPutLimits, observers, mutations, windowEvents, documentEvents, document, revoked };
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

test('v1 kanji retries use explicit item type and reuse the cached fallback', async () => {
  const urls = [];
  const h = harness({
    fetch: async (url) => {
      urls.push(url);
      return response({
        data: [urls.length === 1 ? data([]) : data([example('kanji-fallback')])],
      });
    },
  });
  h.state.settings.general.advanced.immersionKitAPIVersion = '1';
  h.state.wkItemInfo.item.type = 'vocabulary';

  const result = await h.fetchImmersionKitData('猫', { itemType: 'Kanji' });
  assert.equal(result.examples[0].id, 'kanji-fallback');
  assert.equal(urls.length, 2);
  const primaryUrl = urls[0];
  const fallbackUrl = urls[1];
  assert.equal(
    h.state.immersionKit.cache.urls[primaryUrl].data.examples.length,
    0,
  );
  assert.equal(
    h.state.immersionKit.cache.urls[fallbackUrl].data.examples[0].id,
    'kanji-fallback',
  );

  assert.equal(
    (await h.fetchImmersionKitData('猫', { itemType: 'kanji' })).examples[0].id,
    'kanji-fallback',
  );
  assert.equal(
    (await h.fetchImmersionKitData('猫', { itemType: 'vocabulary' })).examples.length,
    0,
  );
  assert.equal(urls.length, 2);
});

test('failed v1 kanji fallback returns primary results for fresh and cached lookups', async () => {
  const createHarness = (primeCache) => {
    let calls = 0;
    const h = harness({
      fetch: async () => {
        if (++calls > 1) {
          throw new Error('fallback unavailable');
        }
        return response({ data: [data([])] });
      },
    });
    h.state.settings.general.advanced.immersionKitAPIVersion = '1';
    h.state.settings.general.dataFetching.retryCount = 0;
    return { h, primeCache: async () => {
      if (primeCache) {
        await h.fetchImmersionKitData('猫', { itemType: 'vocabulary' });
      }
    } };
  };

  for (const shouldPrimeCache of [false, true]) {
    const { h, primeCache } = createHarness(shouldPrimeCache);
    await primeCache();

    const result = await h.fetchImmersionKitData('猫', { itemType: 'kanji' });
    assert.equal(result.examples.length, 0);
    assert.equal(
      h.warnings.filter(([message]) =>
        message.includes('Could not fetch v1 kanji fallback'),
      ).length,
      1,
    );
  }
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

test('legacy cache restore does not dirty shards and newer shards override legacy entries', async () => {
  const legacyKey = 'media-context-sentences.immersion-kit-data';
  const shardKey =
    'wkof.settings.media-context-sentences.immersion-kit-data.shard.1';
  const legacyUrl =
    'https://apiv2.immersionkit.com/search?q=猫&wk=3&exactMatch=true';
  const shardUrl = 'https://apiv2.immersionkit.com/search?q=猫';
  const legacyData = data([example('legacy')]);
  const shardedData = data([example('sharded')]);
  const h = harness({
    files: {
      [legacyKey]: { [legacyUrl]: { data: legacyData } },
      [shardKey]: { [shardUrl]: { data: shardedData } },
    },
  });

  await h.restoreCachedImmersionKitData();

  assert.equal(h.timers.size, 0);
  assert.equal(h.saves.length, 0);
  assert.equal(
    h.state.immersionKit.cache.urls[legacyUrl].data.examples[0].id,
    'legacy',
  );
  assert.equal(
    h.state.immersionKit.cache.urls[shardUrl].data.examples[0].id,
    'sharded',
  );
  assert.equal(
    (await h.fetchImmersionKitData('猫')).examples[0].id,
    'sharded',
  );
});

test('sentence cache entries retain render fields and cap examples on insertion, restore, and save', async () => {
  const oversizedData = data(
    Array.from({ length: 205 }, (_, index) => ({
      ...example(`sentence-${index}`),
      unused_payload: 'discard me',
    })),
  );
  const h = harness();
  h.setCachedData('v2:猫', { data: oversizedData });

  const cachedExamples = h.state.immersionKit.cache.urls['v2:猫'].data.examples;
  assert.equal(cachedExamples.length, 200);
  assert.deepEqual(Object.keys(cachedExamples[0]).sort(), [
    'id', 'image', 'sentence', 'sentence_with_furigana', 'sound', 'title',
    'translation', 'word_list', 'matched_indexes',
  ].sort());
  assert.equal(oversizedData.examples.length, 205);
  assert.equal(oversizedData.examples[0].unused_payload, 'discard me');

  const fetched = harness({
    fetch: async () => response(oversizedData),
  });
  const fetchedData = await fetched.fetchImmersionKitData('猫');
  assert.equal(fetchedData.examples.length, 200);
  assert.equal(fetchedData.examples[0].unused_payload, undefined);

  await h.saveCachedImmersionKitData();
  const savedEntry = h.saves[0][1]['v2:猫'];
  assert.equal(savedEntry.data.examples.length, 200);
  assert.equal(savedEntry.data.examples[0].unused_payload, undefined);

  const legacyKey = 'media-context-sentences.immersion-kit-data';
  const legacyUrl = 'https://apiv2.immersionkit.com/search?q=猫&wk=3&exactMatch=true';
  const shardUrl = 'https://apiv2.immersionkit.com/search?q=犬';
  const shardKey =
    'wkof.settings.media-context-sentences.immersion-kit-data.shard.2';
  const restored = harness({
    files: {
      [legacyKey]: { [legacyUrl]: { data: oversizedData } },
      [shardKey]: { [shardUrl]: { data: oversizedData } },
    },
  });
  await restored.restoreCachedImmersionKitData();
  assert.equal(
    restored.state.immersionKit.cache.urls[legacyUrl].data.examples.length,
    200,
  );
  assert.equal(
    restored.state.immersionKit.cache.urls[legacyUrl].data.examples[0].unused_payload,
    undefined,
  );
  assert.equal(
    restored.state.immersionKit.cache.urls[shardUrl].data.examples.length,
    200,
  );
  assert.equal(
    restored.state.immersionKit.cache.urls[shardUrl].data.examples[0].unused_payload,
    undefined,
  );
  assert.equal(restored.saves.length, 0);
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
  assert.equal(h.state.settings.general.dataFetching.mediaCacheLimitMB, 500);
  const urls = await Promise.all([h.getMediaBlobUrl('https://media/a.mp3'), h.getMediaBlobUrl('https://media/a.mp3')]);
  assert.equal(urls[0], urls[1]);
  assert.match(urls[0], /^blob:/);
  assert.equal(calls, 1);
  assert.ok(h.media.get('https://media/a.mp3').blob instanceof Blob);
  await h.getMediaBlobUrl('https://media/a.mp3');
  h.mediaObjectUrls.clear();
  assert.match(await h.getMediaBlobUrl('https://media/a.mp3'), /^blob:/);
  assert.equal(calls, 1);
  assert.deepEqual(h.mediaPutLimits, [500 * 1024 * 1024]);
});

test('media cache size setting trims existing disk data and zero disables disk writes', async () => {
  const h = harness({ fetch: async () => response({}) });
  const trimLimits = [];
  h.ikMediaCacheDB.trimToLimit = async (maxBytes) => trimLimits.push(maxBytes);

  await h.onFetchOptionChanged('mediaCacheLimitMB', 250);
  assert.equal(h.state.settings.general.dataFetching.mediaCacheLimitMB, 250);
  assert.deepEqual(trimLimits, [250 * 1024 * 1024]);

  await h.onFetchOptionChanged('mediaCacheLimitMB', 0);
  await h.getMediaBlobUrl('https://media/no-disk-cache.mp3');
  assert.equal(h.mediaPutLimits.length, 0);
  assert.deepEqual(trimLimits, [250 * 1024 * 1024, 0]);
});

test('media cache trim plan evicts least-recently-used items to remain within the byte limit', () => {
  const h = harness();
  const records = [
    { url: 'old', blob: { size: 6 }, timestamp: 1 },
    { url: 'newer', blob: { size: 4 }, timestamp: 2 },
  ];
  const plan = h.getMediaCacheTrimPlan(records, 10, {
    url: 'incoming',
    blob: { size: 5 },
    timestamp: 3,
  });

  assert.deepEqual(Array.from(plan.evictedUrls), ['old']);
  assert.equal(plan.shouldStore, true);
  assert.deepEqual(
    Array.from(h.getMediaCacheTrimPlan(records, 3).evictedUrls),
    ['old', 'newer'],
  );
  assert.equal(
    h.getMediaCacheTrimPlan(records, 3, {
      url: 'too-large',
      blob: { size: 4 },
      timestamp: 3,
    }).shouldStore,
    false,
  );
  assert.equal(
    h.getMediaCacheTrimPlan([], 0, {
      url: 'zero-limit',
      blob: { size: 0 },
      timestamp: 3,
    }).shouldStore,
    false,
  );
  assert.deepEqual(records.map(({ url }) => url), ['old', 'newer']);
});

test('media object URLs use a 100-entry LRU and revoke evicted URLs', async () => {
  const h = harness({ fetch: async () => response({}) });
  const urls = [];
  for (let i = 0; i < 100; i++) {
    urls.push(await h.getMediaBlobUrl(`https://media/${i}.mp3`));
  }

  assert.equal(await h.getMediaBlobUrl('https://media/0.mp3'), urls[0]);
  const newestUrl = await h.getMediaBlobUrl('https://media/100.mp3');

  assert.equal(h.mediaObjectUrls.size, 100);
  assert.equal(h.mediaObjectUrls.has('https://media/0.mp3'), true);
  assert.equal(h.mediaObjectUrls.has('https://media/1.mp3'), false);
  assert.equal(h.mediaObjectUrls.has('https://media/100.mp3'), true);
  assert.ok(h.revoked.includes(urls[1]));
  assert.ok(!h.revoked.includes(urls[0]));
  assert.equal(h.mediaObjectUrls.get('https://media/100.mp3'), newestUrl);
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

test('manual Flush continues clearing after an in-progress sentence-cache save fails', async () => {
  const h = harness();
  const pendingSave = deferred();
  h.setCachedData('v2:old', { data: data() });
  await h.saveCachedImmersionKitData();
  h.setCachedData('v2:new', { data: data() });
  h.media.set('https://media/old', {
    url: 'https://media/old',
    blob: new Blob(['old']),
  });
  h.mediaObjectUrls.set('https://media/old', 'blob:old');

  h.framework.file_cache.save = async () => pendingSave.promise;
  const failedSave = h.saveCachedImmersionKitData();
  let notified = false;
  const flushing = h.onFlushCachedDataClicked(null, null, async () => {
    notified = true;
  });
  pendingSave.reject(new Error('quota exceeded'));
  await assert.rejects(failedSave, /quota exceeded/);
  await flushing;

  assert.equal(notified, true);
  assert.equal(Object.keys(h.state.immersionKit.cache.urls).length, 0);
  assert.equal(h.media.size, 0);
  assert.equal(h.mediaObjectUrls.size, 0);
  assert.equal(Object.keys(h.files).length, 0);
  assert.ok(h.warnings.some((args) => args[0].includes('before cache clear')));
  await h.saveCachedImmersionKitData();
});

test('rendering sorts before limiting, creates only visible candidates, and preserves raw JSON', async () => {
  let networkCalls = 0;
  const h = harness({ fetch: async () => { networkCalls++; return response({}); } });
  const corpus = data(Array.from({ length: 105 }, (_, i) => example(`${i}`, '猫'.repeat(106 - i))));
  const before = structuredClone(corpus);
  h.setCachedData('v2:猫', { data: corpus });
  h.state.settings.general.appearance.exampleLimit = 3;
  h.state.settings.general.dataFetching.prefetchCount = 0;
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

test('filter diagnostics render API-derived titles and deck counts as plain text', async () => {
  const h = harness();
  const unsafeTitle = '<img src=x onerror=alert(1)>';
  const unsafeCountKey = '<svg onload=alert(1)>';
  h.state.content.allContent.set(unsafeTitle, {
    title: unsafeTitle,
    category: 'anime',
    tags: [],
    enabled: false,
  });
  h.state.content.keyTitleMap.set('unsafe-title-key', unsafeTitle);
  h.state.content.titleKeyMap.set(unsafeTitle, 'unsafe-title-key');
  h.state.settings.general.advanced.debugging = true;
  h.state.settings.general.advanced.failWhenHidden = true;
  h.setCachedData('v2:猫', {
    data: {
      examples: [{ ...example('hidden'), title: 'unsafe-title-key' }],
      deck_count: { [unsafeCountKey]: 1 },
    },
  });

  await h.renderSentences();

  const diagnostic = h.state.elements.sentences.children[0];
  assert.ok(
    diagnostic,
    JSON.stringify({
      textContent: h.state.elements.sentences.textContent,
      warnings: h.warnings.map((warning) =>
        warning.map((value) => String(value)),
      ),
    }),
  );
  assert.equal(diagnostic.tagName, 'pre');
  assert.equal(diagnostic.innerHTML, undefined);
  assert.match(diagnostic.textContent, /Currently hidden titles:/);
  assert.ok(diagnostic.textContent.includes(unsafeTitle));
  assert.ok(diagnostic.textContent.includes(unsafeCountKey));
  assert.ok(diagnostic.textContent.includes('\nComplete deck count data:'));
});

test('preferred source sorting follows title fragments and uses the secondary sort for ties', () => {
  const h = harness();
  const sentences = [
    { title: 'Other Show', category: 'anime', sentence: '猫です' },
    { title: 'Shirokuma Cafe Season 2', category: 'anime', sentence: '猫です' },
    { title: 'News Source', category: 'news', sentence: '猫です' },
    { title: 'Shirokuma Cafe', category: 'anime', sentence: '猫です' },
    { title: 'Another Show', category: 'anime', sentence: '猫です' },
  ];

  h.sortSentences(sentences, 'preferredSources', 'source', 'Shirokuma Cafe, News');

  assert.deepEqual(sentences.map(({ title }) => title), [
    'Shirokuma Cafe',
    'Shirokuma Cafe Season 2',
    'News Source',
    'Another Show',
    'Other Show',
  ]);
});

test('preferred source sorting accepts an ordered array of source titles', () => {
  const h = harness();
  const sentences = [
    { title: 'Other Show', category: 'anime', sentence: '猫です' },
    { title: 'Shirokuma Cafe Season 2', category: 'anime', sentence: '猫です' },
    { title: 'News Source', category: 'news', sentence: '猫です' },
    { title: 'Shirokuma Cafe', category: 'anime', sentence: '猫です' },
  ];

  h.sortSentences(sentences, 'preferredSources', 'default', [
    'Shirokuma Cafe',
    'News Source',
  ]);

  assert.deepEqual(sentences.map(({ title }) => title), [
    'Shirokuma Cafe',
    'News Source',
    'Other Show',
    'Shirokuma Cafe Season 2',
  ]);
});

test('preferred source sorting uses display titles instead of Immersion Kit deck keys', () => {
  const h = harness();
  h.state.content.allContent.set('Shirokuma Cafe', {
    title: 'Shirokuma Cafe',
    category: 'anime',
    tags: [],
    enabled: true,
  });
  h.state.content.allContent.set('Other Show', {
    title: 'Other Show',
    category: 'anime',
    tags: [],
    enabled: true,
  });
  h.state.content.keyTitleMap.set('shirokuma_cafe', 'Shirokuma Cafe');

  const sentences = [
    h.prepareExample({ ...example('other'), title: 'Other Show' }, '猫'),
    h.prepareExample(
      { ...example('preferred'), title: 'shirokuma_cafe' },
      '猫',
    ),
  ];
  h.sortSentences(sentences, 'preferredSources', 'default', ['Shirokuma Cafe']);

  assert.deepEqual(
    sentences.map(({ title }) => title),
    ['Shirokuma Cafe', 'Other Show'],
  );
});

test('preferred source sorting leaves Immersion Kit order unchanged with no preferences', () => {
  const h = harness();
  const sentences = [
    { title: 'Zebra', category: 'anime', sentence: '猫です' },
    { title: 'Alpha', category: 'anime', sentence: '猫です' },
  ];

  h.sortSentences(sentences, 'preferredSources', 'default', '');

  assert.deepEqual(sentences.map(({ title }) => title), ['Zebra', 'Alpha']);
});

test('dragging a preferred source moves it before or after the target', () => {
  const h = harness();
  const sources = ['First', 'Second', 'Third'];

  assert.deepEqual(
    Array.from(h.movePreferredSourceInOrder(sources, 'Third', 'First', false)),
    ['Third', 'First', 'Second'],
  );
  assert.deepEqual(
    Array.from(h.movePreferredSourceInOrder(sources, 'First', 'Second', true)),
    ['Second', 'First', 'Third'],
  );
  assert.deepEqual(sources, ['First', 'Second', 'Third']);
});

test('preferred source settings add and drag sources into the saved order', async () => {
  const h = harness();
  const settingsKey = 'media-context-sentences';
  const container = new Element();
  h.state.settings.sorting.preferredSources = ['New Game!'];
  h.framework.settings = { [settingsKey]: structuredClone(h.state.settings) };
  h.document.getElementById = (id) =>
    id === `${settingsKey}-preferred-sources` ? container : null;

  h.renderPreferredSourcesSettings();

  const [sourceSelect, addButton, list] = container.children;
  await addButton.click();
  await addButton.click();
  assert.equal(list.children.length, 3);
  const draggedItem = list.children[2];
  const targetItem = list.children[0];
  list.listeners.dragstart({
    target: draggedItem,
    dataTransfer: { setData() {} },
  });
  list.listeners.drop({
    target: targetItem,
    clientY: 0,
    preventDefault() {},
  });

  const expectedOrder = [
    draggedItem.dataset.sourceTitle,
    'New Game!',
    list.children[2].dataset.sourceTitle,
  ];
  assert.deepEqual(
    list.children.map(({ dataset }) => dataset.sourceTitle),
    expectedOrder,
  );
  assert.deepEqual(
    Array.from(h.framework.settings[settingsKey].sorting.preferredSources),
    expectedOrder,
  );
  assert.equal(sourceSelect.options.length, h.state.content.allContent.size - 3);
});

test('saving preferred source priorities persists them and schedules a rerender', async () => {
  const h = harness();
  h.state.wkItemInfo.item = null;
  const settings = structuredClone(h.state.settings);
  settings.sorting.primary = 'preferredSources';
  settings.sorting.preferredSources = ['Shirokuma Cafe'];

  await h.onSettingsSaved(settings);

  assert.deepEqual(h.state.settings.sorting.preferredSources, ['Shirokuma Cafe']);
  assert.equal(h.state.pending.renderSentences, true);
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

test('active event prefetches images and audio for the first five sorted sentences', async () => {
  const urls = [];
  const corpus = data(Array.from({ length: 8 }, (_, i) => example(`${i}`, '猫'.repeat(i + 1))));
  const before = structuredClone(corpus);
  const h = harness({ fetch: async (url) => {
    urls.push(url);
    return url.includes('/search')
      ? response(corpus)
      : response({});
  } });
  assert.equal(h.state.settings.general.dataFetching.prefetchCount, 5);
  h.state.settings.sorting.primary = 'longness';
  h.installActiveItemPrefetcher();
  h.windowEvents.willShowNextQuestion({ detail: { subject: { type: 'Vocabulary', characters: '猫' } } });
  await tick();
  await tick();
  assert.equal(urls.length, 11);
  assert.deepEqual(urls.slice(1).map((url) => url.split('/').at(-1)), [
    '7.jpg', '7.mp3', '6.jpg', '6.mp3', '5.jpg', '5.mp3',
    '4.jpg', '4.mp3', '3.jpg', '3.mp3',
  ]);
  assert.deepEqual(corpus, before);
  assert.equal(h.state.elements.sentences.textContent, '');
  h.windowEvents.willShowNextQuestion({ detail: { subject: { type: 'Vocabulary', characters: '猫' } } });
  await tick();
  assert.equal(urls.length, 11);
});

test('prefetch and rendering share source priorities, secondary position sorting, and filters', async () => {
  const urls = [];
  const h = harness({ fetch: async (url) => { urls.push(url); return response({}); } });
  h.state.settings.general.dataFetching.prefetchCount = 2;
  h.state.settings.sorting.primary = 'preferredSources';
  h.state.settings.sorting.secondary = 'position';
  h.state.settings.sorting.preferredSources = ['Shirokuma Cafe'];
  h.state.settings.filters.exactMatch = true;
  h.state.content.allContent.get('Angel Beats!').enabled = false;
  h.setCachedData('v2:猫', { data: data([
    example('other', '猫'),
    { ...example('later', 'あ猫'), title: 'Shirokuma Cafe' },
    { ...example('first', '猫です'), title: 'Shirokuma Cafe' },
    { ...example('disabled', '猫'), title: 'Angel Beats!' },
    { ...example('filtered', '犬'), title: 'Shirokuma Cafe' },
  ]) });

  await h.prefetchItem('猫', 'vocabulary');
  assert.deepEqual(urls.map((url) => url.split('/').at(-1)), [
    'first.jpg', 'first.mp3', 'later.jpg', 'later.mp3',
  ]);
  await h.renderSentences();
  await tick();
  assert.equal(urls.length, 4);
  assert.deepEqual(
    h.state.elements.sentences.children.slice(0, 2).map(
      (el) => el.children[1].children[0].children[0].id,
    ),
    ['audio-button-first', 'audio-button-later'],
  );
});

test('prefetch applies difficulty filters before selecting media', async () => {
  const urls = [];
  const h = harness({ fetch: async (url) => {
    urls.push(url);
    return url.includes('/search') ? response(data([example('allowed')])) : response({});
  } });
  h.state.settings.filters.jlptLevel = 5;
  h.setCachedData('v2:猫', { data: data([example('excluded'), example('allowed')]) });
  await h.prefetchItem('猫', 'vocabulary');
  assert.equal(urls.length, 3);
  assert.ok(urls[0].includes('&jlpt=5'));
  assert.ok(urls[1].endsWith('/allowed.jpg'));
  assert.ok(urls[2].endsWith('/allowed.mp3'));
});

test('rendering starts prefetch without review events and does not wait for media', async () => {
  const urls = [], pending = deferred();
  const h = harness({ fetch: (url) => { urls.push(url); return pending.promise; } });
  h.setCachedData('v2:猫', {
    data: data(Array.from({ length: 7 }, (_, i) => example(`${i}`))),
  });
  await h.renderSentences();
  assert.equal(h.state.elements.sentences.children.length, 7);
  assert.deepEqual(urls.map((url) => url.split('/').at(-1)), [
    '0.jpg', '0.mp3', '1.jpg', '1.mp3', '2.jpg', '2.mp3',
    '3.jpg', '3.mp3', '4.jpg', '4.mp3',
  ]);
  pending.resolve(response({}));
  await tick();
  await h.state.elements.sentences.children[0].children[1].children[0].children[0].click();
  assert.equal(urls.length, 10);
});

test('prefetch count setting updates the active item, supports zero, and rejects invalid counts', async () => {
  const urls = [];
  const h = harness({ fetch: async (url) => { urls.push(url); return response({}); } });
  h.setCachedData('v2:猫', { data: data([
    example('first'), example('second'), example('third'),
  ]) });
  const option = h.state.settingsDialog.content.general.content
    .immersionKitDataFetchingOptions.content.prefetchCount;
  assert.equal(option.default, 5);
  assert.equal(option.path, '@general.dataFetching.prefetchCount');
  assert.equal(option.min, 0);
  assert.equal(option.step, 1);

  await h.onFetchOptionChanged('prefetchCount', '1');
  assert.equal(h.state.settings.general.dataFetching.prefetchCount, 1);
  assert.equal(urls.length, 2);
  const savedSettings = structuredClone(h.state.settings);
  await h.onFetchOptionChanged('prefetchCount', 2);
  assert.equal(urls.length, 4);
  await h.onSettingsClosed(savedSettings);
  assert.equal(h.state.settings.general.dataFetching.prefetchCount, 1);

  await h.onFetchOptionChanged('prefetchCount', 0);
  await h.prefetchItem('uncached', 'vocabulary');
  await h.renderSentences();
  await tick();
  assert.equal(urls.length, 4);
  for (const invalid of [-1, 1.5, 'bad', Infinity, NaN]) {
    await assert.rejects(
      h.onFetchOptionChanged('prefetchCount', invalid),
      /Prefetch count must be a non-negative integer/,
    );
    assert.equal(h.state.settings.general.dataFetching.prefetchCount, 0);
  }
});

test('loading saved settings retains a configured prefetch count and defaults older settings to five', async () => {
  for (const count of [undefined, 0, 3, 9]) {
    const h = harness();
    const settings = structuredClone(h.state.settings);
    if (count === undefined) delete settings.general.dataFetching.prefetchCount;
    else settings.general.dataFetching.prefetchCount = count;
    h.framework.Settings = { load: async () => settings };
    await h.loadSettings();
    assert.equal(h.state.settings.general.dataFetching.prefetchCount, count ?? 5);
  }
});

test('active event prefetch respects showOnKanji while preserving vocabulary prefetch', async () => {
  const urls = [];
  const h = harness({
    fetch: async (url) => {
      urls.push(url);
      return response(data([]));
    },
  });
  h.installActiveItemPrefetcher();
  h.windowEvents.willShowNextQuestion({
    detail: { subject: { type: 'Kanji', characters: '猫' } },
  });
  await tick();
  assert.equal(urls.length, 0);

  h.windowEvents.willShowNextQuestion({
    detail: { subject: { type: 'Vocabulary', characters: '猫' } },
  });
  await tick();
  await tick();
  assert.equal(urls.length, 1);

  h.state.settings.general.appearance.showOnKanji = true;
  h.windowEvents.willShowNextQuestion({
    detail: { subject: { type: 'Kanji', characters: '犬' } },
  });
  await tick();
  await tick();
  assert.equal(urls.length, 2);
});

test('kanji event and header prefetch pass their item type to v1 fallback', async () => {
  const makeHarness = () => {
    const urls = [];
    const h = harness({
      fetch: async (url) => {
        urls.push(url);
        return response({ data: [data([])] });
      },
    });
    h.state.settings.general.advanced.immersionKitAPIVersion = '1';
    h.state.settings.general.appearance.showOnKanji = true;
    return { h, urls };
  };

  const eventHarness = makeHarness();
  eventHarness.h.installActiveItemPrefetcher();
  eventHarness.h.windowEvents.willShowNextQuestion({
    detail: { subject: { type: 'Kanji', characters: '猫' } },
  });
  await tick();
  await tick();
  assert.equal(eventHarness.urls.length, 2);

  const headerHarness = makeHarness();
  const header = {
    textContent: '犬',
    closest(selector) {
      return selector === '[data-subject-type]'
        ? { dataset: { subjectType: 'Kanji' } }
        : null;
    },
  };
  headerHarness.h.document.querySelector = () => header;
  headerHarness.h.installActiveItemPrefetcher();
  headerHarness.h.mutations[0].callback();
  await tick();
  await tick();
  assert.equal(headerHarness.urls.length, 2);
});

test('character header prefetch respects showOnKanji', async () => {
  const urls = [];
  const h = harness({
    fetch: async (url) => {
      urls.push(url);
      return response(data([]));
    },
  });
  const header = {
    textContent: '猫',
    closest(selector) {
      if (selector === '[data-subject-type]') {
        return { dataset: { subjectType: 'Kanji' } };
      }
      return null;
    },
  };
  h.document.querySelector = () => header;
  h.installActiveItemPrefetcher();
  h.mutations[0].callback();
  await tick();
  assert.equal(urls.length, 0);

  h.state.settings.general.appearance.showOnKanji = true;
  h.documentEvents['turbo:load']();
  h.mutations.at(-1).callback();
  await tick();
  await tick();
  assert.equal(urls.length, 1);
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

test('settings menu installation is deferred and coalesced across page-load events', async () => {
  const h = harness();
  const inserted = [];
  h.framework.Menu = {
    insert_script_link: (config) => inserted.push(config),
  };

  h.scheduleMenuInstall();
  h.scheduleMenuInstall();
  assert.equal(h.timers.size, 1);

  const [timerId, timer] = h.timers.entries().next().value;
  h.timers.delete(timerId);
  timer.fn();
  await tick();

  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].name, 'media-context-sentences');
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
  h.state.settings.general.dataFetching.prefetchCount = 0;
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
  h.state.settings.general.dataFetching.prefetchCount = 0;
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
