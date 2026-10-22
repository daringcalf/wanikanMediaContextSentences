// ==UserScript==
// @name         WaniKani Media Context Sentences
// @description  Formerly named "Wanikani Anime Sentences 2". Adds example sentences from anime, dramas, games, literature, and news for vocabulary from https://www.immersionkit.com.
// @version      2026-10-19
// @author       Daring Cλlf
// @namespace    https://greasyfork.org/en/users/982721-daringcalf
// @match        https://www.wanikani.com/*
// @match        https://preview.wanikani.com/*
// @require      https://greasyfork.org/scripts/430565-wanikani-item-info-injector/code/WaniKani%20Item%20Info%20Injector.user.js?version=1951553
// @copyright    2021+, Paul Connolly
// @copyright    2024-2025, Brian Shenk, Inserio
// @license      MIT; http://opensource.org/licenses/MIT
// @run-at       document-body
// @grant        none
// ==/UserScript==

// noinspection CssUnusedSymbol,CssInvalidPropertyValue,CssUnresolvedCustomProperty,JSUnusedGlobalSymbols,JSNonASCIINames
/* global wkItemInfo */
(() => {
  'use strict';
  const { wkof } = window,
    script = {
      id: 'media-context-sentences',
      name: 'Media Context Sentences',
      secondarySortingKeyName: 'secondary',
      version: '2026-10-19',
    };
  script.styleSheetName = `${script.id}-style`;
  script.regex = {
    anyUrl: new RegExp(), // default "empty" regex. Equivalent to `/(?:)/`
    maxHeightSearch: new RegExp(`(#${script.id}\\s*{[^}]*?max-height:).*?;`), // /(#media-context-sentences\s*{[^}]*?max-height:) *[\d.] *+\w*;/
    validCssUnit:
      /^((\d*\.)?\d+)((px)|(em)|(%)|(ex)|(ch)|(rem)|(vw)|(vh)|(vmin)|(vmax)|(cm)|(mm)|(in)|(pt)|(pc))$/i,
  };
  Object.freeze(script);
  const state = {
    classNames: {
      audioButton: 'audio-btn',
      audioIdle: 'audio-idle',
      audioPlaying: 'audio-play',
    },
    // Used for working with the settings dialog and determining which sentences to show
    content: {
      deckIndex: {},
      selections: {},
      allContent: new Map(),
      keyTitleMap: new Map(),
      titleKeyMap: new Map(),
      anime: {},
      drama: {},
      games: {},
      literature: {},
      news: {},
    },
    // Default options for configuring the content in the settings dialog (memoized)
    get contentOptions() {
      return lazyProperty(
        this,
        'contentOptions',
        () => ({
          whenShowText: {
            always: 'Always',
            onhover: 'On Hover',
            onclick: 'On Click',
          },
          whenShowFurigana: {
            always: 'Always',
            onhover: 'On Hover',
            never: 'Never',
          },
          jlpt: { 0: 'No Filter', 1: 'N1', 2: 'N2', 3: 'N3', 4: 'N4', 5: 'N5' },
          immersionKitAPIVersions: { 1: 'v1', 2: 'v2' },
          sortingMethods: {
            default: 'Default',
            category: 'Category (anime, drama, etc.)',
            source: 'Source Title',
            preferredSources: 'Preferred Sources',
            shortness: 'Shortest sentences first',
            longness: 'Longest sentences first',
            position: 'Position of keyword in sentence',
          },
          secondarySortingMethodsToHide(primarySortingMethod) {
            const keysToHide = [];
            switch (primarySortingMethod) {
              case 'category':
                keysToHide.push('category');
                break;
              case 'longness':
              case 'shortness':
                keysToHide.push('shortness');
                keysToHide.push('longness');
                break;
              case 'source':
                keysToHide.push('category');
                keysToHide.push('source');
                break;
              case 'preferredSources':
                keysToHide.push('preferredSources');
                break;
              case 'position':
                keysToHide.push('position');
                break;
              case 'default':
              default:
                keysToHide.push('category');
                keysToHide.push('source');
                keysToHide.push('shortness');
                keysToHide.push('longness');
                keysToHide.push('position');
                break;
            }
            return keysToHide;
          },
          secondarySortingMethods(primarySortingMethod) {
            const sortingMethodsCopy = Object.assign({}, this.sortingMethods);
            for (const oldKey of this.secondarySortingMethodsToHide(
              primarySortingMethod,
            )) {
              // we do a little cheeky attribute injection for wkof's list generation...
              const newKey = `${oldKey}" class="hidden`;
              sortingMethodsCopy[newKey] = sortingMethodsCopy[oldKey];
              delete sortingMethodsCopy[oldKey];
            }
            return sortingMethodsCopy;
          },
        }),
        { enumerable: true },
      );
    },
    // Referenced for quick access to elements used in this script
    elements: {
      // The base node
      base: null,
      // The audio nodes
      audio: {},
      // The element holding all the sentences (referenced so that sentences can be re-rendered after settings change)
      sentences: null,
      // The style sheet element
      styleSheet: null,
    },
    handlers: {
      onPlay(button) {
        return ({ currentTarget: el }) => {
          if (el == null) {
            return;
          }
          const {
            settings: {
              general: {
                playback: { restartAudioOnPause },
              },
            },
          } = state;
          for (const [key, { audio }] of Object.entries(state.elements.audio)) {
            if (key !== button.id && !audio.paused) {
              audio.pause();
            }
            if (restartAudioOnPause) {
              audio.currentTime = 0;
            }
          }
        };
      },
      onStop(button) {
        return ({ currentTarget: el }) => {
          if (el == null) {
            return;
          }
          updateAudioButton(button, 'idle');
          el.remove();
        };
      },
    },
    // Container for other Immersion Kit stuff (memoized)
    get immersionKit() {
      return lazyProperty(this, 'immersionKit', () => ({
        api: {
          1: {
            version: 1,
            origin: 'https://api.immersionkit.com',
            endpoints: {
              query: {
                pathname: '/look_up_dictionary',
                getSearch(
                  keyword,
                  {
                    exactSearch,
                    exampleLimit,
                    jlptLevel,
                    primarySorting,
                    tags,
                    waniKaniLevel,
                  },
                ) {
                  keyword = keyword.replace('〜', ''); // for "counter" kanji
                  if (exactSearch) {
                    keyword = `「${keyword}」`;
                  }
                  let sentenceSorting = '';
                  switch (primarySorting) {
                    case 'shortness':
                    case 'longness':
                      sentenceSorting = `&sort=${primarySorting}`;
                  }
                  const jlpt =
                    Number(jlptLevel) > 0 ? `&jlpt=${jlptLevel}` : '';
                  const wk = waniKaniLevel ? `&wk=${state.userLevel}` : '';
                  const tag = tags.length > 0 ? `&tags=${tags}` : '';
                  const limit =
                    Number(exampleLimit) > 0 ? `&limit=${exampleLimit}` : '';
                  return `?keyword=${keyword}${jlpt}${wk}${tag}${sentenceSorting}${limit}`;
                },
              },
            },
          },
          2: {
            endpoints: {
              index: { pathname: '/index_meta' },
              query: {
                pathname: '/search',
                getSearch(
                  keyword,
                  {
                    exactSearch,
                    jlptLevel,
                    primarySorting,
                    tags,
                    waniKaniLevel,
                  },
                ) {
                  keyword = keyword.replace('〜', ''); // for "counter" kanji
                  let sentenceSorting = '';
                  switch (primarySorting) {
                    case 'longness':
                      sentenceSorting = '&sort=sentence_length:desc';
                      break;
                    case 'shortness':
                      sentenceSorting = '&sort=sentence_length:asc';
                      break;
                  }
                  const exact = exactSearch ? '&exactMatch=true' : '';
                  const jlpt =
                    Number(jlptLevel) > 0 ? `&jlpt=${jlptLevel}` : '';
                  const wk = waniKaniLevel ? `&wk=${state.userLevel}` : '';
                  const tag = tags.length > 0 ? `&tags=${tags}` : '';
                  return `?q=${keyword}${exact}${jlpt}${wk}${tag}${sentenceSorting}`;
                },
              },
            },
            origin: 'https://apiv2.immersionkit.com',
            version: 2,
          },
        },
        baseContentUrl:
          'https://us-southeast-1.linodeobjects.com/immersionkit/media/',
        // Cached to aid in determining whether retries should be done
        currentSearchUrl: null,
        cache: {
          key: `${script.id}.immersion-kit-data`,
          // WKOF exempts this namespace from its automatic 14-day cleanup.
          shardPrefix: `wkof.settings.${script.id}.immersion-kit-data.shard.`,
          // Cached so sentences can be re-rendered after settings change and to persist lookups between sessions
          urls: {},
        },
        // Cache for the number of fetches done for any given url
        fetchCount: {},
        getSearchOptions({
          general: {
            appearance: { exampleLimit = 0 },
          },
          sorting: { primary: primarySorting = 'shortness' },
          filters: {
            exactSearch = false,
            jlptLevel = 0,
            tags = '',
            waniKaniLevel = false,
          },
        } = {}) {
          if (Array.isArray(tags)) {
            tags = tags.join(',');
          }
          return {
            exactSearch,
            exampleLimit,
            jlptLevel,
            primarySorting,
            tags,
            waniKaniLevel,
          };
        },
      }));
    },
    // The settings object
    settings: {
      // Sentence Filtering Options
      filters: {
        // Filters the results to only those with sentences exactly matching the keyword (i.e., this filters after the results are found)
        // TODO: Make the kanji (i.e., not the okurigana) required by default for non-kana-only vocab
        exactMatch: false,
        // Wraps the search term in Japanese quotes (i.e., 「term」) before sending it to Immersion Kit
        exactSearch: false,
        // If greater than 0, tells Immersion Kit to filter out results that are not at the selected JLPT level or easier.
        jlptLevel: 0,
        // Mapping of the content title to the enabled state.
        // All content is enabled by default.
        // Titles are taken from https://www.immersionkit.com/information and modified after testing a few example search results.
        // Including the full lists for v1 compatability
        lists: {
          anime: {
            [`Alya Sometimes Hides Her Feelings in Russian`]: true,
            [`Angel Beats!`]: true,
            [`Anohana the flower we saw that day`]: true,
            [`Assassination Classroom Season 1`]: true,
            [`Bakemonogatari`]: true,
            [`Boku no Hero Academia Season 1`]: true,
            [`Bunny Drop`]: true,
            [`Cardcaptor Sakura`]: true,
            [`Castle in the sky`]: true,
            [`Chobits`]: true,
            [`Clannad After Story`]: true,
            [`Clannad`]: true,
            [`Code Geass Season 1`]: true,
            [`Daily Lives of High School Boys`]: true,
            [`Death Note`]: true,
            [`Demon Slayer - Kimetsu no Yaiba`]: true,
            [`Durarara!!`]: true,
            [`Erased`]: true,
            [`Fairy Tail`]: true,
            [`Fate Stay Night Unlimited Blade Works`]: true,
            [`Fate Zero`]: true,
            [`From Up on Poppy Hill`]: true,
            [`From the New World`]: true,
            [`Fruits Basket Season 1`]: true,
            [`Fullmetal Alchemist Brotherhood`]: true,
            [`Girls Band Cry`]: true,
            [`God's Blessing on this Wonderful World!`]: true,
            [`Grave of the Fireflies`]: true,
            [`Haruhi Suzumiya`]: true,
            [`Howl's Moving Castle`]: true,
            [`Hunter × Hunter`]: true,
            [`Hyouka`]: true,
            [`Is The Order a Rabbit`]: true,
            [`K-On!`]: true,
            [`Kakegurui`]: true,
            [`Kanon (2006)`]: true,
            [`Kiki's Delivery Service`]: true,
            [`Kill la Kill`]: true,
            [`Kino's Journey`]: true,
            [`Kokoro Connect`]: true,
            [`Little Witch Academia`]: true,
            [`Lucky Star`]: true,
            [`Mahou Shoujo Madoka Magica`]: true,
            [`Mononoke`]: true,
            [`My Little Sister Can't Be This Cute`]: true,
            [`My Neighbor Totoro`]: true,
            [`New Game!`]: true,
            [`Nisekoi`]: true,
            [`No Game No Life`]: true,
            [`Noragami`]: true,
            [`One Week Friends`]: true,
            [`Only Yesterday`]: true,
            [`Princess Mononoke`]: true,
            [`Psycho Pass`]: true,
            [`Re Zero − Starting Life in Another World`]: true,
            [`ReLIFE`]: true,
            [`Shirokuma Cafe`]: true,
            [`Sound! Euphonium`]: true,
            [`Spirited Away`]: true,
            [`Steins Gate`]: true,
            [`Sword Art Online`]: true,
            [`The Cat Returns`]: true,
            [`The Garden of Words`]: true,
            [`The Girl Who Leapt Through Time`]: true,
            [`The Pet Girl of Sakurasou`]: true,
            [`The Secret World of Arrietty`]: true,
            [`The Wind Rises`]: true,
            [`The World God Only Knows`]: true,
            [`Toradora!`]: true,
            [`Wandering Witch The Journey of Elaina`]: true,
            [`Weathering with You`]: true,
            [`When Marnie Was There`]: true,
            [`Whisper of the Heart`]: true,
            [`Wolf Children`]: true,
            [`Your Lie in April`]: true,
            [`Your Name`]: true,
          },
          drama: {
            [`1 Litre of Tears`]: true,
            [`Border`]: true,
            [`Good Morning Call`]: true, // Exists in the APIv2 list, but APIv1 splits it into two
            [`Good Morning Call Season 1`]: true, // Exists in the APIv1 list, but not in the APIv2 list
            [`Good Morning Call Season 2`]: true,
            [`I am Mita, Your Housekeeper`]: true,
            [`I'm Taking the Day Off`]: true,
            [`Legal High Season 1`]: true,
            [`Million Yen Woman`]: true,
            [`Mob Psycho 100`]: true,
            [`Overprotected Kahoko`]: true,
            [`Quartet`]: true,
            [`Sailor Suit and Machine Gun (2006)`]: true,
            [`Smoking`]: true,
            [`The Journalist`]: true,
            [`Weakest Beast`]: true,
          },
          games: {
            [`Cyberpunk 2077`]: true,
            [`Skyrim`]: true,
            [`Witcher 3`]: true,
            // The following are currently not queryable via the API (but maybe they will be someday?)
            // [`NieR: Automata`]: true, [`NieR Re[in]carnation`]: true, [`Zelda: Breath of the Wild`]: true,
          },
          literature: {
            [`黒猫`]: true,
            [`おおかみと七ひきのこどもやぎ`]: true,
            [`マッチ売りの少女`]: true,
            [`サンタクロースがやってきた`]: true,
            [`君死にたまふことなかれ`]: true,
            [`蝉`]: true,
            [`胡瓜`]: true,
            [`若鮎について`]: true,
            [`黒足袋`]: true,
            [`柿`]: true,
            [`お母さんの思ひ出`]: true,
            [`砂をかむ`]: true,
            [`虻のおれい`]: true,
            [`がちゃがちゃ`]: true,
            [`犬のいたずら`]: true,
            [`犬と人形`]: true,
            [`懐中時計`]: true,
            [`きのこ会議`]: true,
            [`お金とピストル`]: true,
            [`梅のにおい`]: true,
            [`純真`]: true,
            [`声と人柄`]: true,
            [`心の調べ`]: true,
            [`愛`]: true,
            [`期待と切望`]: true,
            [`空の美`]: true,
            [`いちょうの実`]: true,
            [`虔十公園林`]: true,
            [`クねずみ`]: true,
            [`おきなぐさ`]: true,
            [`さるのこしかけ`]: true,
            [`セロ弾きのゴーシュ`]: true,
            [`ざしき童子のはなし`]: true,
            [`秋の歌`]: true,
            [`赤い船とつばめ`]: true,
            [`赤い蝋燭と人魚`]: true,
            [`赤い魚と子供`]: true,
            [`秋が　きました`]: true,
            [`青いボタン`]: true,
            [`ある夜の星たちの話`]: true,
            [`いろいろな花`]: true,
            [`からすとかがし`]: true,
            [`片田舎にあった話`]: true,
            [`金魚売り`]: true,
            [`小鳥と兄妹`]: true,
            [`おじいさんが捨てたら`]: true,
            [`おかめどんぐり`]: true,
            [`お母さん`]: true,
            [`お母さんのお乳`]: true,
            [`おっぱい`]: true,
            [`少年と秋の日`]: true,
            [`金のくびかざり`]: true,
            [`愛よ愛`]: true,
            [`気の毒な奥様`]: true,
            [`新茶`]: true,
            [`初夏に座す`]: true,
            [`三角と四角`]: true,
            [`赤い蝋燭`]: true,
            [`赤とんぼ`]: true,
            [`飴だま`]: true,
            [`あし`]: true,
            [`がちょうのたんじょうび`]: true,
            [`ごん狐`]: true,
            [`蟹のしょうばい`]: true,
            [`カタツムリノ ウタ`]: true,
            [`木の祭り`]: true,
            [`こぞうさんのおきょう`]: true,
            [`去年の木`]: true,
            [`おじいさんのランプ`]: true,
            [`王さまと靴屋`]: true,
            [`落とした一銭銅貨`]: true,
            [`サルト サムライ`]: true,
            [`里の春、山の春`]: true,
            [`ウサギ 新美 南吉`]: true,
            [`あひるさん と 時計`]: true,
            [`川へおちた玉ねぎさん`]: true,
            [`小ぐまさんのかんがへちがひ`]: true,
            [`お鍋とお皿とカーテン`]: true,
            [`お鍋とおやかんとフライパンのけんくわ`]: true,
            [`ひらめの学校`]: true,
            [`狐物語`]: true,
            [`桜の樹の下には`]: true,
            [`瓜子姫子`]: true,
            [`ああしんど`]: true,
            [`葬式の行列`]: true,
            [`風`]: true,
            [`子どものすきな神さま`]: true,
            [`喫茶店にて`]: true,
            [`子供に化けた狐`]: true,
            [`顔`]: true,
            [`四季とその折々`]: true,
          },
          news: {
            [`平成30年阿蘇神社で甘酒の仕込み始まる`]: true,
            [`フレッシュマン！5月号阿蘇広域行政事務組合`]: true,
            [`フレッシュマン！7月号春工房、そば処ゆう雀`]: true,
            [`フレッシュマン！11月号内牧保育園`]: true,
            [`山田小学校で最後の稲刈り`]: true,
          },
        },
        // Not implemented (If implemented, would filter the results to only those matching the provided category tags) - TODO: Priority low
        tags: '',
        // Tells Immersion Kit to filter out results containing words more than 1 level higher than the current WaniKani level
        // (possibly inaccurate, due to frequent changes in WK level contents)
        waniKaniLevel: false,
      },
      // General
      general: {
        // Appearance Options
        appearance: {
          // 0 = No limit
          exampleLimit: 0,
          // Options for highlighting the keyword in the sentence: exact|fuzzy
          // TODO: Implement
          highlighting: 'exact',
          // The maximum height of the container box. If no unit type is provided, px (pixels) is automatically appended.
          maxBoxHeight: '320px',
          // Options for when to show English translation: always|onhover|onclick
          showEnglish: 'onhover',
          // Options for when to show Furigana: always|onhover|never
          showFurigana: 'onhover',
          // Options for when to show Japanese text: always|onhover|onclick
          showJapanese: 'always',
          // Allows the box to appear in the Examples tab for kanji as well
          showOnKanji: false,
        },
        // Playback Options
        playback: {
          // If true, will restart the audio track from the beginning when the user pauses.
          // If false, will save the current position and resume from there the next time that sentence is played.
          restartAudioOnPause: true,
          // Playback speed in percent = (playbackRate * 2)
          playbackRate: 50,
          // Playback volume in percent
          playbackVolume: 100,
        },
        // Immersion Kit Data Fetching Options
        dataFetching: {
          // Retry network/server failures, never successful empty results.
          retryCount: 0,
          // Milliseconds to wait before retrying fetch
          retryDelay: 5000,
          // Retained for settings compatibility; permanent lookups are never revalidated.
          checkLastModified: false,
          // Maximum persistent media cache size in MiB; 0 disables persistent media caching.
          mediaCacheLimitMB: 500,
          // Prefetch images and audio for the first N filtered, sorted sentences; 0 disables prefetching.
          prefetchCount: 5,
        },
        // Advanced Options
        advanced: {
          // Enables debugging statements to find and help remedy bugs when they occur.
          debugging: false,
          // This works as a "fail-early" measure and will not show any normal results when an issue is found.
          failWhenHidden: false,
          // Immersion Kit API Version
          immersionKitAPIVersion: '2',
        },
      },
      // Sentence Sorting Options
      sorting: {
        // Options for primary and secondary sentence sorting
        primary: 'default',
        [script.secondarySortingKeyName]: 'default',
        preferredSources: [],
      },
      // The current version of the stored settings
      version: script.version,
    },
    get settingsDialog() {
      return {
        script_id: script.id,
        title: script.name,
        on_save: onSettingsSaved,
        on_close: onSettingsClosed,
        content: {
          general: {
            type: 'page',
            label: 'General',
            content: {
              generalDescription: {
                type: 'section',
                label:
                  'Changes to settings in this tab can be previewed in real-time.',
              },
              appearanceOptions: {
                type: 'group',
                label: 'Appearance Options',
                content: {
                  showOnKanji: {
                    type: 'checkbox',
                    label: 'Show on Kanji Items',
                    default: state.settings.general.appearance.showOnKanji,
                    hover_tip:
                      'Allows the box to appear in the Examples tab for kanji in addition to vocabulary.',
                    on_change: onAppearanceOptionChanged,
                    path: '@general.appearance.showOnKanji',
                  },
                  maxBoxHeight: {
                    type: 'text',
                    label: 'Box Height',
                    step: 1,
                    min: 0,
                    default: state.settings.general.appearance.maxBoxHeight,
                    hover_tip:
                      'Set the maximum height of the container box.\nIf no unit type is provided, px (pixels) is automatically appended.',
                    on_change: onAppearanceOptionChanged,
                    validate: validateMaxHeight,
                    path: '@general.appearance.maxBoxHeight',
                  },
                  exampleLimit: {
                    type: 'number',
                    label: 'Example Limit',
                    step: 1,
                    min: 0,
                    default: state.settings.general.appearance.exampleLimit,
                    hover_tip:
                      'Limit the number of entries that may appear.\nSet to 0 for unlimited results, loaded in batches of 20 using Load more sentences.',
                    on_change: onAppearanceOptionChanged,
                    path: '@general.appearance.exampleLimit',
                  },
                  showJapanese: {
                    type: 'dropdown',
                    label: 'Show Japanese',
                    default: state.settings.general.appearance.showJapanese,
                    content: state.contentOptions.whenShowText,
                    hover_tip:
                      'When to show Japanese text.\nHover enables transcribing a sentences first (play audio by clicking the image to avoid seeing the answer).',
                    on_change: onAppearanceOptionChanged,
                    path: '@general.appearance.showJapanese',
                  },
                  showFurigana: {
                    type: 'dropdown',
                    label: 'Show Furigana',
                    default: state.settings.general.appearance.showFurigana,
                    content: state.contentOptions.whenShowFurigana,
                    hover_tip:
                      'These have been autogenerated so there may be mistakes.',
                    on_change: onAppearanceOptionChanged,
                    path: '@general.appearance.showFurigana',
                  },
                  showEnglish: {
                    type: 'dropdown',
                    label: 'Show English',
                    default: state.settings.general.appearance.showEnglish,
                    content: state.contentOptions.whenShowText,
                    hover_tip:
                      'Hover or click allows testing your understanding before seeing the answer.',
                    on_change: onAppearanceOptionChanged,
                    path: '@general.appearance.showEnglish',
                  },
                },
              },
              playbackOptions: {
                type: 'group',
                label: 'Playback Options',
                content: {
                  playbackRate: {
                    type: 'input',
                    subtype: 'range',
                    label: 'Playback Speed',
                    default: state.settings.general.playback.playbackRate,
                    hover_tip: 'Speed to play back audio. (10% - 200%)',
                    on_change: onPlaybackOptionChanged,
                    validate: validatePlaybackRate,
                    path: '@general.playback.playbackRate',
                  },
                  playbackVolume: {
                    type: 'input',
                    subtype: 'range',
                    label: 'Playback Volume',
                    default: state.settings.general.playback.playbackVolume,
                    hover_tip: 'Volume to play back audio. (0% - 100%)',
                    on_change: onPlaybackOptionChanged,
                    validate: validatePlaybackVolume,
                    path: '@general.playback.playbackVolume',
                  },
                  restartAudioOnPause: {
                    type: 'checkbox',
                    label: 'Restart Audio on Pause',
                    default:
                      state.settings.general.playback.restartAudioOnPause,
                    hover_tip:
                      'If true, will restart the audio track from the beginning whenever a sentence is played.\nIf false, will save the current position and resume from there the next time that sentence is played.',
                    on_change: onPlaybackOptionChanged,
                    path: '@general.playback.restartAudioOnPause',
                  },
                },
              },
              immersionKitDataFetchingOptions: {
                type: 'group',
                label: 'Immersion Kit Data Fetching Options',
                content: {
                  fetchRetryCount: {
                    type: 'number',
                    label: 'Fetch Retry Count',
                    step: 1,
                    min: 0,
                    default: state.settings.general.dataFetching.retryCount,
                    hover_tip:
                      'Retry failed requests this many times. Successful empty results are cached permanently.',
                    on_change: onFetchOptionChanged,
                    path: '@general.dataFetching.retryCount',
                  },
                  fetchRetryDelay: {
                    type: 'number',
                    label: 'Fetch Retry Delay (ms)',
                    step: 1,
                    min: 0,
                    default: state.settings.general.dataFetching.retryDelay,
                    hover_tip:
                      'Set the delay in milliseconds between each retry attempt.',
                    on_change: onFetchOptionChanged,
                    path: '@general.dataFetching.retryDelay',
                  },
                  prefetchCount: {
                    type: 'number',
                    label: 'Prefetch Sentence Count',
                    step: 1,
                    min: 0,
                    default: state.settings.general.dataFetching.prefetchCount,
                    hover_tip:
                      'Prefetch images and audio for the first N sentences in your selected sort order, after filtering. Defaults to 5. Set to 0 to disable media prefetching; remaining media loads on demand.',
                    on_change: onFetchOptionChanged,
                    path: '@general.dataFetching.prefetchCount',
                  },
                  mediaCacheLimitMB: {
                    type: 'number',
                    label: 'Media Cache Limit (MB)',
                    step: 50,
                    min: 0,
                    default:
                      state.settings.general.dataFetching.mediaCacheLimitMB,
                    hover_tip:
                      'Maximum disk space used for cached images and audio. Oldest media is removed when the limit is exceeded. Set to 0 to disable persistent media caching.',
                    on_change: onFetchOptionChanged,
                    path: '@general.dataFetching.mediaCacheLimitMB',
                  },
                  checkLastModified: {
                    type: 'checkbox',
                    label: 'Compare Last-Modified Date',
                    default:
                      state.settings.general.dataFetching.checkLastModified,
                    hover_tip:
                      'Legacy option retained for compatibility. Cached sentences are now permanent and never revalidated. Use Flush to clear them manually.',
                    on_change: onFetchOptionChanged,
                    path: '@general.dataFetching.checkLastModified',
                  },
                },
              },
              advancedOptions: {
                type: 'group',
                label: 'Advanced Options',
                content: {
                  debugging: {
                    type: 'checkbox',
                    label: 'Debugging',
                    default: state.settings.general.advanced.debugging,
                    hover_tip:
                      'Show additional debugging information in the console.',
                    on_change: onAdvancedOptionChanged,
                    path: '@general.advanced.debugging',
                  },
                  failWhenHidden: {
                    type: 'checkbox',
                    label: 'Fail When Hidden',
                    default: state.settings.general.advanced.failWhenHidden,
                    hover_tip:
                      'Immediately fail to display the sentences if any are available but hidden, instead showing a message including the list of hidden sentences.\nNote: Toggling this option will immediately cause a rerender of the sentences.',
                    on_change: onAdvancedOptionChanged,
                    path: '@general.advanced.failWhenHidden',
                  },
                  immersionKitAPIVersion: {
                    type: 'dropdown',
                    label: 'Immersion Kit API Version',
                    default:
                      state.settings.general.advanced.immersionKitAPIVersion,
                    content: state.contentOptions.immersionKitAPIVersions,
                    hover_tip: 'Select the Immersion Kit API version to use.',
                    on_change: onAdvancedOptionChanged,
                    path: '@general.advanced.immersionKitAPIVersion',
                  },
                  flushCachedData: {
                    type: 'button',
                    label: 'Cached Data',
                    text: 'Flush',
                    hover_tip:
                      'Immediately delete all cached sentences, difficulty-filter lists, images, and audio. Browser storage is otherwise kept permanently.',
                    on_click: onFlushCachedDataClicked,
                  },
                },
              },
            },
          },
          sorting: {
            type: 'page',
            label: 'Sorting',
            content: {
              sentenceSortOptions: {
                type: 'group',
                label: 'Sentence Sorting Options',
                content: {
                  primary: {
                    type: 'dropdown',
                    label: 'Primary Sorting Method',
                    default: state.settings.sorting.primary,
                    content: state.contentOptions.sortingMethods,
                    hover_tip:
                      'Choose in what order the sentences will be presented.\nDefault = Exactly as retrieved from Immersion Kit',
                    on_change: onPrimarySortOptionChanged,
                    path: '@sorting.primary',
                  },
                  [script.secondarySortingKeyName]: {
                    type: 'dropdown',
                    label: 'Secondary Sorting Method',
                    default:
                      state.settings.sorting[script.secondarySortingKeyName],
                    content: state.contentOptions.secondarySortingMethods(
                      state.settings.sorting.primary,
                    ),
                    hover_tip:
                      'Choose how you would like to sort equivalencies in the primary sorting method.\nDefault = No secondary sorting',
                    path: `@sorting.${script.secondarySortingKeyName}`,
                  },
                  preferredSources: {
                    type: 'html',
                    label: 'Preferred Sources',
                    html: `<div id="${script.id}-preferred-sources"></div>`,
                    wrapper: 'row',
                    hover_tip:
                      'Add sources to prioritize them, then drag them into the order you want. Unlisted sources follow the secondary sorting method.',
                  },
                },
              },
            },
          },
          filters: {
            type: 'page',
            label: 'Filters',
            content: {
              sentenceFilteringOptions: {
                type: 'group',
                label: 'Sentence Filtering Options',
                content: {
                  filterExactMatch: {
                    type: 'checkbox',
                    label: 'Exact Match',
                    default: state.settings.filters.exactMatch,
                    hover_tip:
                      'Text must match term exactly, i.e., this filters out conjugations/inflections.\nChecking this for a word with kanji means it will not match if the sentence has it only in kana form and vice-versa for kana-only vocabulary.\n\nThis filtering is done after the results are retrieved from Immersion Kit and may yield different results than the "Exact Search" option (below) when the latter is not used.',
                    path: '@filters.exactMatch',
                  },
                  filterAnime: {
                    type: 'list',
                    label: 'Anime',
                    multi: true,
                    size: 10,
                    default: state.content.selections.anime,
                    content: state.content.anime,
                    hover_tip:
                      'Select the anime that can be included in the examples.',
                    path: '@filters.lists.anime',
                  },
                  filterDrama: {
                    type: 'list',
                    label: 'Drama',
                    multi: true,
                    size: 6,
                    default: state.content.selections.drama,
                    content: state.content.drama,
                    hover_tip:
                      'Select the dramas that can be included in the examples.',
                    path: '@filters.lists.drama',
                  },
                  filterGames: {
                    type: 'list',
                    label: 'Games',
                    multi: true,
                    size: 3,
                    default: state.content.selections.games,
                    content: state.content.games,
                    hover_tip:
                      'Select the video games that can be included in the examples.',
                    path: '@filters.lists.games',
                  },
                  filterLiterature: {
                    type: 'list',
                    label: 'Literature',
                    multi: true,
                    size: 6,
                    default: state.content.selections.literature,
                    content: state.content.literature,
                    hover_tip:
                      'Select the pieces of literature that can be included in the examples.',
                    path: '@filters.lists.literature',
                  },
                  filterNews: {
                    type: 'list',
                    label: 'News',
                    multi: true,
                    size: 6,
                    default: state.content.selections.news,
                    content: state.content.news,
                    hover_tip:
                      'Select the news sources that can be included in the examples.',
                    path: '@filters.lists.news',
                  },
                },
              },
              immersionKitSearchOptions: {
                type: 'group',
                label: 'Immersion Kit Search Options',
                content: {
                  immersionKitSearchDescription: {
                    type: 'section',
                    label:
                      'v2 caches the full word lookup permanently. Exact Search is local; difficulty filters cache matching sentence IDs separately for each filter/level.',
                  },
                  filterExactSearch: {
                    type: 'checkbox',
                    label: 'Exact Search',
                    default: state.settings.filters.exactSearch,
                    hover_tip:
                      'Text must match term exactly, i.e., this filters out conjugations/inflections.\nChecking this for a word with kanji means it will not match if the sentence has it only in kana form and vice-versa for kana-only vocabulary.',
                    path: '@filters.exactSearch',
                  },
                  filterWaniKaniLevel: {
                    type: 'checkbox',
                    label: 'WaniKani Level',
                    default: state.settings.filters.waniKaniLevel,
                    hover_tip:
                      'Only show sentences with maximum 1 word outside of your current WaniKani level.',
                    path: '@filters.waniKaniLevel',
                  },
                  filterJLPTLevel: {
                    type: 'dropdown',
                    label: 'JLPT Level',
                    default: state.settings.filters.jlptLevel,
                    content: state.contentOptions.jlpt,
                    hover_tip:
                      'Only show sentences matching a particular JLPT Level or easier.',
                    path: '@filters.jlptLevel',
                  },
                },
              },
            },
          },
          credits: {
            type: 'html',
            label: 'Powered by',
            html: '<a href="https://www.immersionkit.com" style="vertical-align:middle;vertical-align:-webkit-baseline-middle;vertical-align:-moz-middle-with-baseline;">https://www.immersionkit.com</a>',
          },
        },
      };
    },
    // Current user's WaniKani level
    get userLevel() {
      return wkof ? wkof.user.level : 0;
    },
    // Whether certain operations are pending to be done.
    pending: {
      // Whether an update of the desired shows is pending to be done.
      updateDesiredShows: false,
      updateIndexUrl: false,
      // Whether the current Immersion Kit search URL is pending to be updated.
      updateSearchUrl: false,
      // Whether a rerender of the sentences is pending to be done.
      renderSentences: false,
    },
    // Used for modifying the current WK Item Info Injector listeners
    wkItemInfo: {
      handlers: {
        kanji: null,
        vocabulary: null,
      },
      // Current item from wkItemInfoInjector
      item: null,
    },
  };
  Object.defineProperties(state, {
    classNames: { enumerable: true, writable: false, configurable: false },
    content: { enumerable: true, writable: false, configurable: false },
    elements: { enumerable: true, writable: false, configurable: false },
    handlers: { enumerable: false, writable: false, configurable: false },
    settings: { enumerable: true, writable: false, configurable: true },
    pending: { enumerable: true, writable: false, configurable: false },
    wkItemInfo: { enumerable: true, writable: false, configurable: false },
  });

  const inFlightRequests = new Map();
  const legacyKeywordCache = new Map();
  const sentenceExampleCacheLimit = 200;
  const sentenceExampleCacheFields = [
    'id',
    'title',
    'deck_name',
    'deck_name_japanese',
    'category',
    'sentence',
    'sentence_with_furigana',
    'word_list',
    'word_index',
    'matched_indexes',
    'image',
    'sound',
    'image_url',
    'sound_url',
    'translation',
  ];
  const mediaObjectUrlLimit = 100;
  const mediaObjectUrls = new Map();
  const mediaRequests = new Map();
  const dirtyCacheShards = new Set();
  const cacheShards = new Map();
  let saveTimer, maxSaveTimer, savingCache;
  let cacheGeneration = 0;
  let activeLookups = 0;
  let renderGeneration = 0;
  let menuInstallTimer;
  let imageObserver;
  const ikMediaCacheDB = {
    connection: null,
    open() {
      if (!this.connection) {
        this.connection = new Promise((resolve, reject) => {
          const request = indexedDB.open(`${script.id}.media`, 1);
          request.onupgradeneeded = () =>
            request.result.createObjectStore('media', { keyPath: 'url' });
          request.onsuccess = () => {
            const db = request.result;
            db.onversionchange = () => {
              db.close();
              this.connection = null;
            };
            resolve(db);
          };
          request.onerror = () => reject(request.error);
          request.onblocked = () => reject(new Error('Media cache is blocked'));
        }).catch((error) => {
          this.connection = null;
          throw error;
        });
      }
      return this.connection;
    },
    async transact(mode, operation) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction('media', mode);
        const request = operation(transaction.objectStore('media'));
        transaction.oncomplete = () => resolve(request.result);
        transaction.onerror = transaction.onabort = () =>
          reject(transaction.error || request.error);
      });
    },
    get(url) {
      return this.transact('readwrite', (store) => {
        const request = store.get(url);
        request.onsuccess = () => {
          if (request.result) {
            store.put({ ...request.result, timestamp: Date.now() });
          }
        };
        return request;
      });
    },
    trimToLimit(maxBytes, recordToAdd = null) {
      return this.transact('readwrite', (store) => {
        const request = store.openCursor();
        const records = [];
        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor) {
            records.push({
              url: cursor.value.url,
              size: Number(cursor.value.size ?? cursor.value.blob?.size) || 0,
              timestamp: cursor.value.timestamp,
            });
            cursor.continue();
            return;
          }
          const { evictedUrls, shouldStore } = getMediaCacheTrimPlan(
            records,
            maxBytes,
            recordToAdd,
          );
          for (const url of evictedUrls) {
            store.delete(url);
          }
          if (recordToAdd && shouldStore) {
            store.put(recordToAdd);
          }
        };
        return request;
      });
    },
    put(url, blob, maxBytes) {
      return this.trimToLimit(maxBytes, {
        url,
        blob,
        size: blob.size,
        timestamp: Date.now(),
      });
    },
    clear() {
      return this.transact('readwrite', (store) => store.clear());
    },
  };

  Promise.resolve()
    .then(init)
    .catch((error) =>
      console.error(`${script.name}: Initialization failed`, error),
    );
  // END SCRIPT

  async function init() {
    updateKeyMapForTitles();
    await restoreCachedImmersionKitData();
    addMissingEntriesToContent();
    const api = state.immersionKit.api['2'];
    const indexUrl = `${api.origin}${api.endpoints.index.pathname}`;
    const decksIndex = state.immersionKit.cache.urls[indexUrl]?.data;
    if (decksIndex) {
      mergeImmersionKitDeckDataIntoContent(decksIndex);
    } else {
      void fetchImmersionKitDecksIndex();
    }
    if (wkof) {
      await wkof.include('Apiv2,Settings,Menu');
      document.addEventListener('turbo:load', scheduleMenuInstall);
      wkof.on_pageload(script.regex.anyUrl, scheduleMenuInstall);
      await wkof.ready('Settings');
      // await createContentListsForSettings();
      await loadSettings();
      await migrateSettingsVersion();
      addMissingEntriesToContent();
      await Promise.all([
        wkof.ready('Apiv2'),
        addStyle(),
        onImmersionKitAPIVersionOptionChanged(
          state.settings.general.advanced.immersionKitAPIVersion,
        ),
      ]);
      await updateDesiredShows();
      await wkof.ready('Menu');
      scheduleMenuInstall();
    } else {
      console.warn(
        `${script.name}: You are not using Wanikani Open Framework which this script utilizes to provide the settings dialog for the script. You can still use ${script.name} normally though`,
      );
      await Promise.all([addStyle(), updateDesiredShows()]);
    }
    try {
      await ikMediaCacheDB.trimToLimit(
        state.settings.general.dataFetching.mediaCacheLimitMB * 1024 * 1024,
      );
    } catch (error) {
      console.warn(
        `${script.name}: Could not enforce media cache limit`,
        error,
      );
    }
    window.mediaContextSentences = state;
    setWaniKaniItemInfoListener();
    installActiveItemPrefetcher();
    if (wkof) {
      void startBackgroundPrewarmer().catch((error) =>
        console.warn(`${script.name}: Background prewarming failed`, error),
      );
    }
    const flush = () =>
      void saveCachedImmersionKitData().catch((error) =>
        console.warn(`${script.name}: Could not persist sentence cache`, error),
      );
    window.addEventListener('beforeunload', flush);
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        flush();
      }
    });
  }

  function setWaniKaniItemInfoListener() {
    if (state.wkItemInfo.handlers.vocabulary == null) {
      state.wkItemInfo.handlers.vocabulary = wkItemInfo
        .forType('vocabulary,kanaVocabulary')
        .under('examples')
        .notify(onExamplesVisible);
    }
    if (state.settings.general.appearance.showOnKanji) {
      if (state.wkItemInfo.handlers.kanji == null) {
        state.wkItemInfo.handlers.kanji = wkItemInfo
          .forType('kanji')
          .under('examples')
          .notify(onExamplesVisible);
      } else {
        state.wkItemInfo.handlers.kanji.renew();
      }
    } else {
      state.wkItemInfo.handlers.kanji?.remove();
      state.wkItemInfo.handlers.kanji = null;
    }
  }

  async function addContextSentences(itemType) {
    state.elements.base = Object.assign(document.createElement('div'), {
      id: `${script.id}-container`,
    });
    state.elements.sentences = Object.assign(document.createElement('div'), {
      id: `${script.id}`,
      textContent: 'Loading...',
    });

    const titleEl = Object.assign(document.createElement('span'), {
      textContent: script.name,
    });
    const header = [],
      additionalSettings = { sectionName: script.name, under: 'examples' };
    header.push(titleEl);

    if (wkof) {
      const settingsBtn = Object.assign(document.createElement('span'), {
        textContent: '⚙️',
        className: `${script.id}-settings-btn`,
        onclick: openSettings,
      });
      header.push(settingsBtn);
    }

    state.elements.base.append(state.elements.sentences);

    if (state.wkItemInfo.item.injector) {
      state.wkItemInfo.item.injector.appendSubsection(
        header,
        state.elements.base,
        additionalSettings,
      );
    }

    await renderSentences(itemType);
  }

  function getNewImmersionKitUrl(keyword, settings = state.settings) {
    const immersionKit = state.immersionKit;
    const api =
      immersionKit.api[state.settings.general.advanced.immersionKitAPIVersion];
    const options = immersionKit.getSearchOptions(settings);
    if (api.version === 2) {
      state.pending.updateSearchUrl = false;
      return getLookupRequest(keyword, '2').url;
    }
    const url = `${api.origin}${api.endpoints.query.pathname}${api.endpoints.query.getSearch(keyword, options)}`;
    state.pending.updateSearchUrl = false;
    return url;
  }

  function normalizeSentenceCacheEntry(entry) {
    if (!Array.isArray(entry?.data?.examples)) {
      return entry;
    }
    const examples = entry.data.examples;
    const shouldNormalize =
      examples.length > sentenceExampleCacheLimit ||
      !Object.hasOwn(entry.data, 'deck_count') ||
      examples.some((example) =>
        Object.keys(example).some(
          (field) => !sentenceExampleCacheFields.includes(field),
        ),
      );
    if (!shouldNormalize) {
      return entry;
    }
    return {
      ...entry,
      data: {
        deck_count: entry.data.deck_count ?? {},
        examples: examples
          .slice(0, sentenceExampleCacheLimit)
          .map((example) =>
            Object.fromEntries(
              sentenceExampleCacheFields
                .filter((field) => Object.hasOwn(example, field))
                .map((field) => [field, example[field]]),
            ),
          ),
      },
    };
  }

  async function restoreCachedImmersionKitData() {
    if (!wkof) {
      return;
    }
    const { cache } = state.immersionKit;
    try {
      if (cache.key in wkof.file_cache.dir) {
        const legacy = await wkof.file_cache.load(cache.key);
        for (const [key, entry] of Object.entries(legacy)) {
          const normalizedEntry = normalizeSentenceCacheEntry(entry);
          cache.urls[key] = normalizedEntry;
          indexLegacyCacheEntry(key, normalizedEntry);
        }
      }
      await Promise.all(
        Object.keys(wkof.file_cache.dir)
          .filter((key) => key.startsWith(cache.shardPrefix))
          .map(async (key) => {
            const entries = await wkof.file_cache.load(key);
            const shard = Number(key.slice(cache.shardPrefix.length));
            const normalizedEntries = Object.fromEntries(
              Object.entries(entries).map(([entryKey, entry]) => [
                entryKey,
                normalizeSentenceCacheEntry(entry),
              ]),
            );
            cacheShards.set(shard, {
              ...cacheShards.get(shard),
              ...normalizedEntries,
            });
            Object.assign(cache.urls, normalizedEntries);
            for (const [entryKey, entry] of Object.entries(normalizedEntries)) {
              indexLegacyCacheEntry(entryKey, entry);
            }
          }),
      );
    } catch (error) {
      console.warn(
        `${script.name}: Could not restore all cached sentences`,
        error,
      );
    }
  }

  async function deleteCachedImmersionKitData() {
    cacheGeneration++;
    clearTimeout(saveTimer);
    clearTimeout(maxSaveTimer);
    maxSaveTimer = undefined;
    dirtyCacheShards.clear();
    if (savingCache) {
      try {
        await savingCache;
      } catch (error) {
        console.warn(
          `${script.name}: Could not finish saving before cache clear`,
          error,
        );
      }
      dirtyCacheShards.clear();
    }
    if (wkof) {
      const { cache } = state.immersionKit;
      await Promise.all(
        Object.keys(wkof.file_cache.dir)
          .filter(
            (key) => key === cache.key || key.startsWith(cache.shardPrefix),
          )
          .map((key) => wkof.file_cache.delete(key)),
      );
    }
    state.immersionKit.cache.urls = {};
    cacheShards.clear();
    legacyKeywordCache.clear();
    inFlightRequests.clear();
    mediaRequests.clear();
    for (const url of mediaObjectUrls.values()) {
      URL.revokeObjectURL(url);
    }
    mediaObjectUrls.clear();
    try {
      await ikMediaCacheDB.clear();
    } catch (error) {
      console.warn(`${script.name}: Could not clear media cache`, error);
    }
  }

  function setCachedData(key, entry) {
    entry = normalizeSentenceCacheEntry(entry);
    state.immersionKit.cache.urls[key] = entry;
    indexLegacyCacheEntry(key, entry);
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      hash = (hash * 31 + key.charCodeAt(i)) | 0;
    }

    const shard = hash & 63;
    if (!cacheShards.has(shard)) {
      cacheShards.set(shard, {});
    }
    cacheShards.get(shard)[key] = entry;
    dirtyCacheShards.add(shard);
    scheduleSaveCachedData();
  }

  function getMediaCacheTrimPlan(records, maxBytes, recordToAdd = null) {
    const limit = Math.max(0, Number(maxBytes) || 0);
    const addRecord =
      recordToAdd &&
      limit > 0 &&
      Number(recordToAdd.size ?? recordToAdd.blob?.size) <= limit
        ? recordToAdd
        : null;
    const retainedRecords = records.filter(
      (record) => !addRecord || record.url !== addRecord.url,
    );
    let totalBytes = retainedRecords.reduce(
      (total, record) =>
        total + (Number(record.size ?? record.blob?.size) || 0),
      addRecord ? Number(addRecord.size ?? addRecord.blob?.size) || 0 : 0,
    );
    const oldestFirst = [...retainedRecords].sort(
      (a, b) => (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0),
    );
    const evictedUrls = [];
    while (totalBytes > limit && oldestFirst.length > 0) {
      const record = oldestFirst.shift();
      evictedUrls.push(record.url);
      totalBytes -= Number(record.size ?? record.blob?.size) || 0;
    }
    return {
      evictedUrls,
      shouldStore: Boolean(addRecord) && totalBytes <= limit,
    };
  }

  function indexLegacyCacheEntry(key, entry) {
    if (!key.startsWith(`${state.immersionKit.api['2'].origin}/search?`)) {
      return;
    }
    const keyword = new URL(key).searchParams.get('q');
    if (keyword && entry?.data) {
      legacyKeywordCache.set(keyword, entry);
    }
  }

  function scheduleSaveCachedData() {
    if (!wkof) {
      return;
    }
    clearTimeout(saveTimer);
    const flush = () =>
      void saveCachedImmersionKitData().catch((error) =>
        console.warn(`${script.name}: Could not persist sentence cache`, error),
      );
    saveTimer = setTimeout(flush, 2000);
    if (maxSaveTimer === undefined) {
      maxSaveTimer = setTimeout(flush, 10000);
    }
  }

  async function saveCachedImmersionKitData() {
    clearTimeout(saveTimer);
    clearTimeout(maxSaveTimer);
    maxSaveTimer = undefined;
    if (!wkof) {
      return;
    }
    if (savingCache) {
      return savingCache;
    }
    savingCache = (async () => {
      while (dirtyCacheShards.size > 0) {
        const shard = dirtyCacheShards.values().next().value;
        dirtyCacheShards.delete(shard);
        try {
          const entries = Object.fromEntries(
            Object.entries(cacheShards.get(shard)).map(([key, entry]) => [
              key,
              normalizeSentenceCacheEntry(entry),
            ]),
          );
          cacheShards.set(shard, entries);
          Object.assign(state.immersionKit.cache.urls, entries);
          for (const [key, entry] of Object.entries(entries)) {
            indexLegacyCacheEntry(key, entry);
          }
          await wkof.file_cache.save(
            `${state.immersionKit.cache.shardPrefix}${shard}`,
            entries,
          );
        } catch (error) {
          dirtyCacheShards.add(shard);
          throw error;
        }
      }
    })();
    try {
      await savingCache;
    } finally {
      savingCache = null;
    }
  }

  function mergeImmersionKitDeckDataIntoContent(data) {
    const errorList = [];
    for (let [key, entry] of Object.entries(data)) {
      state.content.deckIndex[key] = entry;
      const { title, category, tags } = entry;
      if (!state.content.keyTitleMap.has(key)) {
        errorList.push({ error: 'Key not found in key-title mappings', key });
        state.content.keyTitleMap.set(key, title);
        state.content.titleKeyMap.set(title, key);
      }
      state.content.allContent.set(title, {
        title,
        category,
        tags,
        enabled: true,
      }); // Default to enabled
      if (category in state.content) {
        state.content[category][title] = title;
      } else {
        errorList.push({
          error: 'Category not found in state.content',
          category,
        });
      }
    }
    if (errorList.length > 0) {
      console.warn(
        `Error(s) during mergeImmersionKitDeckDataIntoContent:`,
        errorList,
      );
    }
  }

  // Temporary workaround for entries not listed in the index_meta list (likely only matters for API v1)
  function addMissingEntriesToContent() {
    const errorList = [];
    let currentCount = 0;
    for (const category of ['anime', 'drama', 'games', 'literature', 'news']) {
      if (!(category in state.content)) {
        state.content[category] = {};
      }
      if (
        Object.keys(state.content[category]).length <
        Object.keys(state.settings.filters.lists[category]).length
      ) {
        for (let title of Object.keys(state.settings.filters.lists[category])) {
          if (title in state.content[category]) {
            continue;
          }
          state.content[category][title] = title;
          state.content.allContent.set(title, {
            title,
            category,
            tags: [],
            enabled: true,
          });
          errorList.push(title);
        }
        if (errorList.length > currentCount) {
          sortObjectPropertiesInPlace(state.content[category]);
        }
        currentCount = errorList.length;
      }
    }
    if (state.settings.general.advanced.debugging && errorList.length > 0) {
      console.warn(
        `Added the following ${errorList.length} "missing" entries to content`,
        errorList,
      );
    }
  }

  // Update the map to be able to look up the title from the key
  function updateKeyMapForTitles() {
    const englishTitles = Object.assign(
      {},
      state.settings.filters.lists.anime,
      state.settings.filters.lists.drama,
      state.settings.filters.lists.games,
    );
    const japaneseTitles = Object.assign(
      {},
      state.settings.filters.lists.literature,
      state.settings.filters.lists.news,
    );
    for (let title of Object.keys(englishTitles)) {
      const key = normalize(title).toLocaleLowerCase();
      state.content.keyTitleMap.set(key, title);
      state.content.titleKeyMap.set(title, key);
    }
    for (let title of Object.keys(japaneseTitles)) {
      state.content.keyTitleMap.set(title, title);
      state.content.titleKeyMap.set(title, title);
    }
  }

  async function fetchImmersionKitDecksIndex() {
    const api = state.immersionKit.api['2'];
    const indexUrl = `${api.origin}${api.endpoints.index.pathname}`;
    const cached = state.immersionKit.cache.urls[indexUrl]?.data;
    if (cached) {
      return cached;
    }
    if (inFlightRequests.has(indexUrl)) {
      return {};
    }
    const generation = cacheGeneration;
    const request = (async () => {
      try {
        const response = await fetch(indexUrl);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const json = await response.json();
        const data = json.data;
        if (!data || typeof data !== 'object') {
          throw new Error('Invalid Immersion Kit deck index');
        }
        if (generation === cacheGeneration) {
          setCachedData(indexUrl, { data, cachedAt: Date.now() });
          mergeImmersionKitDeckDataIntoContent(data);
          addMissingEntriesToContent();
          await updateDesiredShows();
          state.pending.updateIndexUrl = false;
        }
        return data;
      } catch (error) {
        console.warn(
          `${script.name}: Deck index unavailable; using built-in titles`,
          error,
        );
        addMissingEntriesToContent();
        return {};
      } finally {
        if (inFlightRequests.get(indexUrl) === request) {
          inFlightRequests.delete(indexUrl);
        }
      }
    })();
    inFlightRequests.set(indexUrl, request);
    // The index enriches built-in titles but must never block Item Info.
    return {};
  }

  function getLookupRequest(keyword, version) {
    keyword = keyword.replace('〜', '');
    const api = state.immersionKit.api[version];
    if (String(version) === '2') {
      return {
        key: `v2:${keyword}`,
        url: `${api.origin}/search?q=${encodeURIComponent(keyword)}`,
      };
    }
    const options = state.immersionKit.getSearchOptions(state.settings);
    const url = `${api.origin}${api.endpoints.query.pathname}${api.endpoints.query.getSearch(keyword, options)}`;
    return { key: url, url };
  }

  function getCachedLookup(keyword, version) {
    const { key, url } = getLookupRequest(keyword, version);
    const { urls } = state.immersionKit.cache;
    if (urls[key]?.data) {
      return urls[key];
    }
    if (urls[url]?.data) {
      return urls[url];
    }
    if (String(version) !== '2') {
      return;
    }
    const api = state.immersionKit.api['2'];
    const legacyUrl = `${api.origin}/search${api.endpoints.query.getSearch(
      keyword,
      state.immersionKit.getSearchOptions(state.settings),
    )}`;
    if (urls[legacyUrl]?.data) {
      return urls[legacyUrl];
    }
    return legacyKeywordCache.get(keyword.replace('〜', ''));
  }

  async function requestImmersionKitJSON(url, version) {
    const { retryCount, retryDelay } = state.settings.general.dataFetching;
    for (let attempt = 0; ; attempt++) {
      try {
        state.immersionKit.fetchCount[url] =
          (state.immersionKit.fetchCount[url] ?? 0) + 1;
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        let data = await response.json();
        if (String(version) === '1') {
          data = data.data?.[0];
        }
        if (!Array.isArray(data?.examples)) {
          throw new Error('Invalid Immersion Kit sentence response');
        }
        return normalizeSentenceCacheEntry({
          data:
            data.examples.length === 0
              ? { ...data, examples: [], deck_count: {} }
              : data,
        }).data;
      } catch (error) {
        if (attempt >= Number(retryCount)) {
          throw error;
        }
        console.warn(`${script.name}: Retrying failed lookup`, url, error);
        await sleep(retryDelay);
      }
    }
  }

  async function fetchImmersionKitData(
    keyword = state.wkItemInfo.item.characters,
    {
      background = false,
      version = state.settings.general.advanced.immersionKitAPIVersion,
      itemType,
    } = {},
  ) {
    if (!background) {
      activeLookups++;
    }
    try {
      const cached = getCachedLookup(keyword, version);
      if (cached) {
        const { key } = getLookupRequest(keyword, version);
        if (String(version) === '2' && !state.immersionKit.cache.urls[key]) {
          setCachedData(key, cached);
        }
        if (
          String(version) === '1' &&
          cached.data.examples.length === 0 &&
          !background &&
          String(itemType).toLowerCase() === 'kanji'
        ) {
          return fetchV1KanjiFallbackOrPrimary(
            keyword,
            cacheGeneration,
            cached.data,
          );
        }
        return cached.data;
      }
      const { key, url } = getLookupRequest(keyword, version);
      const requestKey =
        String(version) === '1' &&
        String(itemType).toLowerCase() === 'kanji' &&
        !background
          ? `${key}:kanji`
          : key;
      if (inFlightRequests.has(requestKey)) {
        return await inFlightRequests.get(requestKey);
      }
      const generation = cacheGeneration;
      const request = requestImmersionKitJSON(url, version).then(
        async (data) => {
          if (
            String(version) === '1' &&
            data.examples.length === 0 &&
            !background &&
            String(itemType).toLowerCase() === 'kanji'
          ) {
            if (generation === cacheGeneration) {
              setCachedData(key, { data, cachedAt: Date.now() });
            }
            return fetchV1KanjiFallbackOrPrimary(keyword, generation, data);
          }
          if (generation === cacheGeneration) {
            setCachedData(key, { data, cachedAt: Date.now() });
          }
          return data;
        },
      );
      inFlightRequests.set(requestKey, request);
      try {
        return await request;
      } finally {
        if (inFlightRequests.get(requestKey) === request) {
          inFlightRequests.delete(requestKey);
        }
      }
    } finally {
      if (!background) {
        activeLookups--;
      }
    }
  }

  async function fetchV1KanjiFallback(keyword, generation) {
    const api = state.immersionKit.api['1'];
    const options = state.immersionKit.getSearchOptions(state.settings);
    options.exactSearch = !options.exactSearch;
    const alternateUrl = `${api.origin}${api.endpoints.query.pathname}${api.endpoints.query.getSearch(keyword, options)}`;
    const cached = state.immersionKit.cache.urls[alternateUrl]?.data;
    if (cached) {
      return cached;
    }
    const requestKey = `kanji-fallback:${alternateUrl}`;
    let request = inFlightRequests.get(requestKey);
    if (!request) {
      request = requestImmersionKitJSON(alternateUrl, '1').then((data) => {
        if (generation === cacheGeneration) {
          setCachedData(alternateUrl, { data, cachedAt: Date.now() });
        }
        return data;
      });
      inFlightRequests.set(requestKey, request);
    }
    try {
      return await request;
    } finally {
      if (inFlightRequests.get(requestKey) === request) {
        inFlightRequests.delete(requestKey);
      }
    }
  }

  async function fetchV1KanjiFallbackOrPrimary(
    keyword,
    generation,
    primaryData,
  ) {
    try {
      return await fetchV1KanjiFallback(keyword, generation);
    } catch (error) {
      console.warn(
        `${script.name}: Could not fetch v1 kanji fallback for ${keyword}`,
        error,
      );
      return primaryData;
    }
  }

  async function getDifficultySentenceIds(keyword, data) {
    const { jlptLevel, waniKaniLevel } = state.settings.filters;
    if (
      String(state.settings.general.advanced.immersionKitAPIVersion) !== '2' ||
      (!Number(jlptLevel) && !waniKaniLevel) ||
      data.examples.length === 0
    ) {
      return null;
    }
    const { key, url } = getLookupRequest(keyword, '2');
    const suffix = `${Number(jlptLevel) || 0}:${waniKaniLevel ? state.userLevel : 0}`;
    const filterKey = `${key}:difficulty:${suffix}`;
    let ids = state.immersionKit.cache.urls[filterKey]?.data;
    if (!ids) {
      let request = inFlightRequests.get(filterKey);
      if (!request) {
        const generation = cacheGeneration;
        const filteredUrl = `${url}${Number(jlptLevel) ? `&jlpt=${jlptLevel}` : ''}${waniKaniLevel ? `&wk=${state.userLevel}` : ''}`;
        request = requestImmersionKitJSON(filteredUrl, '2').then((filtered) => {
          const result = filtered.examples.map((example) => example.id);
          if (generation === cacheGeneration) {
            setCachedData(filterKey, { data: result, cachedAt: Date.now() });
          }
          return result;
        });
        inFlightRequests.set(filterKey, request);
      }
      activeLookups++;
      try {
        ids = await request;
      } finally {
        activeLookups--;
        if (inFlightRequests.get(filterKey) === request) {
          inFlightRequests.delete(filterKey);
        }
      }
    }
    return new Set(ids);
  }

  async function getMediaBlobUrl(remoteUrl) {
    if (!remoteUrl) {
      return remoteUrl;
    }
    if (mediaObjectUrls.has(remoteUrl)) {
      const objectUrl = mediaObjectUrls.get(remoteUrl);
      mediaObjectUrls.delete(remoteUrl);
      mediaObjectUrls.set(remoteUrl, objectUrl);
      return objectUrl;
    }
    if (mediaRequests.has(remoteUrl)) {
      return mediaRequests.get(remoteUrl);
    }
    const generation = cacheGeneration;
    const request = (async () => {
      let blob;
      try {
        blob = (await ikMediaCacheDB.get(remoteUrl))?.blob;
      } catch (error) {
        console.warn(`${script.name}: Could not read media cache`, error);
      }
      if (!blob) {
        try {
          const response = await fetch(remoteUrl, {
            mode: 'cors',
            credentials: 'omit',
          });
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
          blob = await response.blob();
        } catch (error) {
          console.warn(
            `${script.name}: Using native media loading`,
            remoteUrl,
            error,
          );
          return remoteUrl;
        }
        if (generation === cacheGeneration) {
          try {
            const limitMB =
              Number(state.settings.general.dataFetching.mediaCacheLimitMB) ||
              0;
            if (limitMB > 0) {
              await ikMediaCacheDB.put(remoteUrl, blob, limitMB * 1024 * 1024);
            }
          } catch (error) {
            console.warn(`${script.name}: Could not persist media`, error);
          }
        }
      }
      if (generation !== cacheGeneration) {
        return remoteUrl;
      }
      const objectUrl = URL.createObjectURL(blob);
      mediaObjectUrls.set(remoteUrl, objectUrl);
      if (mediaObjectUrls.size > mediaObjectUrlLimit) {
        const oldestRemoteUrl = mediaObjectUrls.keys().next().value;
        const oldestObjectUrl = mediaObjectUrls.get(oldestRemoteUrl);
        mediaObjectUrls.delete(oldestRemoteUrl);
        URL.revokeObjectURL(oldestObjectUrl);
      }
      return objectUrl;
    })();
    mediaRequests.set(remoteUrl, request);
    try {
      return await request;
    } finally {
      if (mediaRequests.get(remoteUrl) === request) {
        mediaRequests.delete(remoteUrl);
      }
    }
  }

  function prepareExample(rawExample, keyword, difficultyIds = null) {
    if (difficultyIds && !difficultyIds.has(rawExample.id)) {
      return null;
    }
    const example = { ...rawExample };
    const { title } = getItemInfo(example);
    const entry = state.content.allContent.get(title);
    if (!entry?.enabled) {
      return null;
    }
    example.title = entry.title;
    keyword = keyword.replace('〜', '');
    const { filters } = state.settings;
    if (filters.exactMatch && !example.sentence.includes(keyword)) {
      return null;
    }
    if (
      String(state.settings.general.advanced.immersionKitAPIVersion) === '2' &&
      filters.exactSearch &&
      !example.word_list.includes(keyword)
    ) {
      return null;
    }
    example.category = entry.category;
    const baseUrl = `${state.immersionKit.baseContentUrl}${entry.category}/${entry.title}/media/`;
    if (!example.image_url && example.image) {
      example.image_url = `${baseUrl}${example.image}`;
    }
    if (!example.sound_url && example.sound) {
      example.sound_url = `${baseUrl}${example.sound}`;
    }
    const directionalFormattingCharsRegex =
      /[\u202A-\u202E\u2066-\u2069\uE4C6]/g;
    example.sentence = example.sentence.replace(
      directionalFormattingCharsRegex,
      '',
    );
    example.sentence_with_furigana = example.sentence_with_furigana.replace(
      directionalFormattingCharsRegex,
      '',
    );
    example.furiganaObject = new Furigana(
      example.sentence,
      example.sentence_with_furigana,
    );
    setKeywordRegexForItem(example, keyword);
    return example;
  }

  async function prefetchSentenceMedia(examples) {
    const count = state.settings.general.dataFetching.prefetchCount;
    await Promise.all(
      examples.slice(0, count).flatMap((example) => [
        getMediaBlobUrl(example.image_url),
        getMediaBlobUrl(example.sound_url),
      ]),
    );
  }

  async function prefetchItem(keyword, itemType) {
    if (!keyword || state.settings.general.dataFetching.prefetchCount === 0) {
      return;
    }
    const version = state.settings.general.advanced.immersionKitAPIVersion;
    const data = await fetchImmersionKitData(keyword, { itemType });
    const ids = await getDifficultySentenceIds(keyword, data);
    if (version !== state.settings.general.advanced.immersionKitAPIVersion) {
      return;
    }
    const examples = data.examples
      .map((example) => prepareExample(example, keyword, ids))
      .filter(Boolean);
    const { sorting } = state.settings;
    sortSentences(
      examples,
      sorting.primary,
      sorting[script.secondarySortingKeyName],
      sorting.preferredSources,
    );
    await prefetchSentenceMedia(examples);
  }

  function installActiveItemPrefetcher() {
    let lastKeyword = '';
    const prefetch = (keyword, itemType) => {
      const requestIdentity = `${itemType ?? ''}:${keyword}`;
      if (!keyword || requestIdentity === lastKeyword) {
        return;
      }
      lastKeyword = requestIdentity;
      void prefetchItem(keyword, itemType).catch((error) => {
        if (lastKeyword === requestIdentity) {
          lastKeyword = '';
        }
        console.warn(`${script.name}: Active item prefetch failed`, error);
      });
    };
    window.addEventListener(
      'willShowNextQuestion',
      (event) => {
        const subject = event.detail?.subject;
        const type =
          subject?.type || subject?.object || event.detail?.subjectType;
        const isKanji = ['Kanji', 'kanji'].includes(type);
        const isSupportedType = [
          'Vocabulary',
          'KanaVocabulary',
          'Kanji',
          'vocabulary',
          'kanaVocabulary',
          'kana_vocabulary',
          'kanji',
        ].includes(type);
        if (
          isSupportedType &&
          (!isKanji || state.settings.general.appearance.showOnKanji)
        ) {
          prefetch(
            subject.characters || subject.data?.characters,
            String(type ?? '').toLowerCase(),
          );
        }
      },
      true,
    );
    let headerObserver;
    const attach = () => {
      headerObserver?.disconnect();
      const header = document.querySelector('.character-header__characters');
      if (!header) {
        return;
      }
      const read = () => {
        const container = header.closest('[data-subject-type]');
        const type = container?.dataset.subjectType;
        const isKanji = type?.toLowerCase() === 'kanji';
        const radical =
          type?.toLowerCase() === 'radical' ||
          header.closest('.character-header--radical');
        if (
          !radical &&
          (!isKanji || state.settings.general.appearance.showOnKanji)
        ) {
          prefetch(header.textContent.trim(), String(type ?? '').toLowerCase());
        }
      };
      headerObserver = new MutationObserver(read);
      headerObserver.observe(header, {
        childList: true,
        characterData: true,
        subtree: true,
      });
      read();
    };
    attach();
    document.addEventListener('turbo:load', attach);
    // The review app can mount its header after turbo:load.
    const mountObserver = new MutationObserver(() => {
      if (currentHeader?.isConnected) {
        return;
      }
      const header = document.querySelector('.character-header__characters');
      if (header !== currentHeader) {
        currentHeader = header;
        attach();
      }
    });
    let currentHeader = document.querySelector('.character-header__characters');
    mountObserver.observe(document.body, { childList: true, subtree: true });
  }

  async function startBackgroundPrewarmer() {
    await wkof.include('ItemData');
    await wkof.ready('Apiv2,ItemData');
    const items = await wkof.ItemData.get_items('assignments');
    for (const item of items) {
      if (!['vocabulary', 'kana_vocabulary'].includes(item.object)) {
        continue;
      }
      const assignment = item.assignments;
      const relevant =
        item.data.level === state.userLevel ||
        (assignment?.unlocked_at && assignment.srs_stage <= 6);
      if (!relevant || !item.data.characters) {
        continue;
      }
      const version = state.settings.general.advanced.immersionKitAPIVersion;
      if (getCachedLookup(item.data.characters, version)) {
        continue;
      }
      await sleep(1500);
      while (activeLookups > 0) {
        await sleep(250);
      }
      try {
        await fetchImmersionKitData(item.data.characters, {
          background: true,
          version,
          itemType: item.object,
        });
      } catch (error) {
        console.warn(
          `${script.name}: Could not prewarm ${item.data.characters}`,
          error,
        );
      }
    }
  }

  async function onExamplesVisible(item) {
    state.wkItemInfo.item = item; // current vocab item
    state.immersionKit.currentSearchUrl = getNewImmersionKitUrl(
      item.characters,
    );
    try {
      await addContextSentences(item.type);
    } catch (e) {
      throw Error(`Error while adding ${script.name} section: ${e.message}`, {
        cause: e,
      });
    }
  }

  function sortSentences(
    sentences,
    primarySorting,
    secondarySorting,
    preferredSources = '',
  ) {
    const categoryCompare = (a, b) => a.category.localeCompare(b.category);
    const sourceCompare = (a, b) => a.title.localeCompare(b.title);
    const shortnessCompare = (a, b) => a.sentence.length - b.sentence.length;
    const longnessCompare = (a, b) => b.sentence.length - a.sentence.length;
    const positionCompare = (a, b) =>
      a.furiganaObject.getFirstKeywordIndex() -
      b.furiganaObject.getFirstKeywordIndex();
    const matchSourceFragments = !Array.isArray(preferredSources);
    const sourcePriorities = getPreferredSources(preferredSources).map(
      (title) => title.toLowerCase(),
    );
    const getSourcePriority = (title) => {
      const normalizedTitle = title.toLowerCase();
      return sourcePriorities.findIndex(
        (source) =>
          normalizedTitle === source ||
          (matchSourceFragments && normalizedTitle.includes(source)),
      );
    };
    const preferredSourceCompare = (a, b) => {
      const aPriority = getSourcePriority(a.title);
      const bPriority = getSourcePriority(b.title);
      if (aPriority === bPriority) {
        return 0;
      }
      if (aPriority === -1) {
        return 1;
      }
      if (bPriority === -1) {
        return -1;
      }
      return aPriority - bPriority;
    };
    const sort = (primaryOrder, a, b) => {
      if (primaryOrder !== 0) {
        return primaryOrder;
      }
      switch (secondarySorting) {
        case primarySorting:
          return primaryOrder;
        case 'category':
          return categoryCompare(a, b);
        case 'source':
          return sourceCompare(a, b);
        case 'shortness':
          return shortnessCompare(a, b);
        case 'longness':
          return longnessCompare(a, b);
        case 'position':
          return positionCompare(a, b);
        case 'default':
        default:
          return primaryOrder;
      }
    };
    switch (primarySorting) {
      case 'category':
        sentences.sort((a, b) => sort(categoryCompare(a, b), a, b));
        break;
      case 'longness':
        sentences.sort((a, b) => sort(longnessCompare(a, b), a, b));
        break;
      case 'shortness':
        sentences.sort((a, b) => sort(shortnessCompare(a, b), a, b));
        break;
      case 'source':
        sentences.sort((a, b) => sort(sourceCompare(a, b), a, b));
        break;
      case 'preferredSources':
        sentences.sort((a, b) => sort(preferredSourceCompare(a, b), a, b));
        break;
      case 'position':
        sentences.sort((a, b) => sort(positionCompare(a, b), a, b));
        break;
      case 'default':
      default:
        break;
    }
  }

  function getItemInfo(item) {
    const { allContent, keyTitleMap, titleKeyMap } = state.content;
    let key = null,
      title = null,
      category = null;
    switch (state.settings.general.advanced.immersionKitAPIVersion) {
      case '1':
        if (titleKeyMap.has(item.deck_name)) {
          key = titleKeyMap.get(item.deck_name);
          title = item.title = item.deck_name;
          category = item.category;
        } else if (titleKeyMap.has(item.deck_name_japanese)) {
          key = titleKeyMap.get(item.deck_name_japanese);
          title = item.title = item.deck_name_japanese;
          category = item.category;
        } else if (keyTitleMap.has(item.deck_name)) {
          key = item.deck_name;
          title = item.title = keyTitleMap.get(item.deck_name);
          category = item.category;
        } else if (keyTitleMap.has(item.deck_name_japanese)) {
          key = item.deck_name_japanese;
          title = item.title = keyTitleMap.get(item.deck_name_japanese);
          category = item.category;
        } else if (allContent.has(item.deck_name)) {
          key = item.deck_name;
          const matchingItem = allContent.get(item.deck_name);
          title = item.title = matchingItem.title;
          category = matchingItem.category;
        } else if (allContent.has(item.deck_name_japanese)) {
          key = item.deck_name_japanese;
          const matchingItem = allContent.get(item.deck_name_japanese);
          title = item.title = matchingItem.title;
          category = matchingItem.category;
        } else {
          console.warn(
            'No matching title found for item:',
            item,
            allContent,
            keyTitleMap.keys(),
          );
        }
        break;
      case '2':
        if (keyTitleMap.has(item.title)) {
          key = item.title;
          title = keyTitleMap.get(item.title);
          category = item.category;
        } else if (titleKeyMap.has(item.title)) {
          key = titleKeyMap.get(item.title);
          title = item.title;
          category = item.category;
        } else if (allContent.has(item.title)) {
          key = item.title;
          const matchingItem = allContent.get(item.title);
          title = matchingItem.title;
          category = matchingItem.category;
        } else {
          console.warn(
            'No matching title found for item:',
            item,
            allContent,
            keyTitleMap.keys(),
          );
        }
        break;
    }
    return { key, title, category };
  }

  function setKeywordRegexForItem(item, itemKeyword) {
    const keywordSet = new Set(); // use a set to prevent duplicates from being added.
    switch (state.settings.general.advanced.immersionKitAPIVersion) {
      case '1':
        for (let i = 0; i < item.word_index.length; i++) {
          keywordSet.add(item.word_list[item.word_index[i]]);
        }
        break;
      case '2':
        for (let i = 0; i < item.matched_indexes.length; i++) {
          keywordSet.add(item.word_list[item.matched_indexes[i].index]);
        }
        break;
    }
    const sentenceKeywords = Array.from(keywordSet);
    // Default to the keyword from the item if word_list is empty,
    // and intersperse whitespace quantifier to match awkwardly spaced out sentences.
    // Otherwise, use the keywords from the sentence data if they exist properly
    // and use alternation when using the example's word_list (which will end up creating tags around each "word").
    const regexExpression =
      sentenceKeywords.length === 0
        ? itemKeyword.split('').join('\\s*')
        : sentenceKeywords.join('|');
    item.furiganaObject.setKeyword(regexExpression);
  }

  // Called from Immersion Kit response and on settings save.
  // This function starts by calling fetchImmersionKitData() to get the data.
  async function renderSentences(itemType = state.wkItemInfo.item?.type) {
    const generation = ++renderGeneration;
    const keyword = state.wkItemInfo.item.characters;
    let data, difficultyIds;
    try {
      data = await fetchImmersionKitData(keyword, { itemType });
      difficultyIds = await getDifficultySentenceIds(keyword, data);
    } catch (error) {
      console.warn(`${script.name}: Could not load sentences`, error);
      if (generation === renderGeneration) {
        state.elements.sentences.textContent =
          'Error fetching examples from Immersion Kit.';
      }
      return;
    }
    if (generation !== renderGeneration) {
      return;
    }
    const { content, elements, settings } = state;
    const { debugging, failWhenHidden } = settings.general.advanced;
    imageObserver?.disconnect();
    imageObserver = null;
    Object.values(elements.audio).forEach((el) => {
      el.audio.remove();
      el = null;
    });
    elements.audio = {};
    if (data == null) {
      return (elements.sentences.textContent =
        'Error fetching examples from Immersion Kit.');
    }
    const exampleCount = data.examples?.length ?? 0;
    if (exampleCount === 0) {
      return (elements.sentences.textContent = 'No sentences found.');
    }
    elements.sentences.textContent = 'Loading...';
    const debugList = new Map();
    const errorList = [];
    let sentencesToDisplay = [];
    // Exclude non-selected titles
    for (let i = 0; i < exampleCount; i++) {
      const rawExample = data.examples[i];
      const { title } = getItemInfo({ ...rawExample });
      if (!title || !content.allContent.has(title)) {
        const error = !title
          ? 'No title'
          : `No matching title found for "${title}"`;
        errorList.push({
          error,
          index: `${i + 1} of ${exampleCount}:`,
          example: rawExample,
        });
        continue;
      }
      const matchingEntry = content.allContent.get(title);
      const enabled = matchingEntry?.enabled ?? false;
      if (!enabled) {
        if (debugging || failWhenHidden) {
          debugList.set(title, (debugList.get(title) ?? 0) + 1);
        }
        continue;
      }
      const example = prepareExample(rawExample, keyword, difficultyIds);
      if (!example) {
        if (debugging || failWhenHidden) {
          debugList.set(title, (debugList.get(title) ?? 0) + 1);
        }
        continue;
      }
      sentencesToDisplay.push(example);
    }
    if (errorList.length > 0) {
      console.warn(`Error(s) found while rendering sentences:`, errorList);
    }
    if (debugging && debugList.size > 0) {
      console.log('Currently hidden titles:', debugList);
    }
    if (
      sentencesToDisplay.length === 0 ||
      (failWhenHidden && debugList.size > 0)
    ) {
      const deckCountsAsJson = JSON.stringify(data.deck_count, undefined, '\t');
      const diagnosticLines = [
        `${sentencesToDisplay.length > 0 ? sentencesToDisplay.length : 'No'} sentences found for the selected filters (${exampleCount - sentencesToDisplay.length} are available but hidden; see below for details and entry counts).`,
      ];
      if (failWhenHidden) {
        diagnosticLines.push(
          '',
          '',
          `Currently hidden titles: {\n\t${Array.from(debugList)
            .map(([title, count]) => `"${title}": ${count}`)
            .join('\n\t')}\n}\n`,
        );
      }
      diagnosticLines.push(`Complete deck count data: ${deckCountsAsJson}`);
      const preElement = Object.assign(document.createElement('pre'), {
        textContent: diagnosticLines.join('\n'),
      });
      elements.sentences.replaceChildren(preElement);
      return;
    }

    const fragment = document.createDocumentFragment();
    sortSentences(
      sentencesToDisplay,
      settings.sorting.primary,
      settings.sorting[script.secondarySortingKeyName],
      settings.sorting.preferredSources,
    );
    void prefetchSentenceMedia(sentencesToDisplay).catch((error) =>
      console.warn(`${script.name}: Sentence media prefetch failed`, error),
    );
    const exampleLimit = Number(settings.general.appearance.exampleLimit);
    const remainingSentences =
      exampleLimit === 0 ? sentencesToDisplay.slice(20) : [];
    sentencesToDisplay = sentencesToDisplay.slice(
      0,
      exampleLimit > 0 ? exampleLimit : 20,
    );
    if (typeof IntersectionObserver !== 'undefined') {
      const observer = new IntersectionObserver(
        (entries) => {
          for (const { target, isIntersecting } of entries) {
            if (!isIntersecting) {
              continue;
            }
            observer.unobserve(target);
            void loadExampleImage(target);
          }
        },
        { root: elements.sentences },
      );
      imageObserver = observer;
    }
    for (let i = 0; i < sentencesToDisplay.length; i++) {
      const example = sentencesToDisplay[i];
      const exampleElement = await createExampleElement(example);
      fragment.appendChild(exampleElement);
    }
    if (generation !== renderGeneration) {
      return;
    }
    elements.sentences.replaceChildren(fragment);
    if (remainingSentences.length > 0) {
      const moreButton = Object.assign(document.createElement('button'), {
        type: 'button',
        textContent: 'Load more sentences',
      });
      moreButton.addEventListener('click', async () => {
        moreButton.disabled = true;
        const batch = document.createDocumentFragment();
        for (const example of remainingSentences.splice(0, 20)) {
          batch.appendChild(await createExampleElement(example));
        }
        if (generation !== renderGeneration) {
          return;
        }
        moreButton.before(batch);
        moreButton.disabled = false;
        if (remainingSentences.length === 0) {
          moreButton.remove();
        }
      });
      elements.sentences.append(moreButton);
    }
    state.pending.renderSentences = false;
  }

  async function loadExampleImage(imgEl) {
    const remoteUrl = imgEl.dataset.mediaUrl;
    if (!remoteUrl) {
      return;
    }
    const url = await getMediaBlobUrl(remoteUrl);
    if (!imgEl.isConnected) {
      return;
    }
    imgEl.onerror = () => {
      imgEl.onerror = null;
      if (url !== remoteUrl) {
        imgEl.src = remoteUrl;
      } else {
        console.warn(`${script.name}: Image could not be loaded`, remoteUrl);
      }
    };
    imgEl.src = url;
  }

  async function createExampleElement(example) {
    const { title } = getItemInfo(example);
    const parentEl = Object.assign(document.createElement('div'), {
        className: 'example',
      }),
      imgEl = Object.assign(document.createElement('img'), {
        loading: 'lazy',
        decoding: 'async',
        alt: '',
      }),
      textParentEl = Object.assign(document.createElement('div'), {
        className: 'example-text',
      }),
      textTitleEl = Object.assign(document.createElement('div'), {
        className: 'title',
        title: example.id, // TODO: Consider removing/moving elsewhere
        textContent: state.content.allContent.get(title).title,
      }),
      audioButtonEl = Object.assign(document.createElement('button'), {
        id: `audio-button-${example.id}`,
        type: 'button',
        className: `${state.classNames.audioButton} ${state.classNames.audioIdle}`,
        title: 'Play Audio',
        textContent: '🔈',
      }),
      jaEl = Object.assign(document.createElement('div'), { className: 'ja' }),
      jaFuriganaSpanEl = Object.assign(document.createElement('span'), {
        className: 'furigana',
        innerHTML: example.furiganaObject.getFuriganaHtml(),
      }),
      enEl = Object.assign(document.createElement('div'), { className: 'en' }),
      enSpanEl = Object.assign(document.createElement('span'), {
        textContent: example.translation,
      }),
      // TODO: Perhaps this should be moved to a separate function or the for loop removed
      elements = [
        {
          element: jaFuriganaSpanEl,
          classListUpdates: [
            {
              name: 'showJapanese',
              value: state.settings.general.appearance.showJapanese,
            },
            {
              name: 'showFurigana',
              value: state.settings.general.appearance.showFurigana,
            },
          ],
          clickListener: {
            name: 'showFurigana',
            value: state.settings.general.appearance.showFurigana,
          },
        },
        {
          element: enSpanEl,
          classListUpdates: [
            {
              name: 'showEnglish',
              value: state.settings.general.appearance.showEnglish,
            },
          ],
          clickListener: {
            name: 'showEnglish',
            value: state.settings.general.appearance.showEnglish,
          },
        },
      ],
      promises = [];
    for (const { element, classListUpdates, clickListener } of elements) {
      for (const { name, value } of classListUpdates) {
        promises.push(updateClassListForSpanElement(element, name, value));
      }
      const { name, value } = clickListener;
      promises.push(updateOnClickListenerForSpanElement(element, name, value));
    }
    await Promise.all(promises);

    attachAudioOnClickListener(parentEl);
    configureAudioElement(audioButtonEl, example);
    parentEl.append(imgEl);
    textTitleEl.append(audioButtonEl);
    textParentEl.append(textTitleEl);

    jaEl.append(jaFuriganaSpanEl);
    enEl.append(enSpanEl);
    textParentEl.append(jaEl);
    textParentEl.append(enEl);

    parentEl.append(textParentEl);
    if (example.image_url) {
      imgEl.dataset.mediaUrl = example.image_url;
      if (imageObserver) {
        imageObserver.observe(imgEl);
      } else {
        setTimeout(() => void loadExampleImage(imgEl), 0);
      }
    }
    return parentEl;
  }

  // ---------------------------------------------------------------------------------------------------------------- //
  // ----------------------------------------------------HELPERS----------------------------------------------------- //
  // ---------------------------------------------------------------------------------------------------------------- //

  function lazyProperty(
    obj,
    prop,
    value,
    { enumerable = true, writable = false, configurable = false } = {},
  ) {
    value = typeof value === 'function' ? value.call(obj) : value;
    return Object.defineProperty(obj, prop, {
      enumerable,
      writable,
      configurable,
      value,
    })[prop];
  }

  function sortObjectPropertiesInPlace(obj) {
    if (typeof obj !== 'object') {
      return;
    }
    Object.keys(obj)
      .sort()
      .forEach(function (key) {
        const value = obj[key];
        delete obj[key];
        obj[key] = value;
      });
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function normalize(str) {
    return str
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replaceAll('×', 'x')
      .replace(/[^a-z0-9]/gi, '_');
  } // .replace(/[\s,“”"`'.?!;:()[\]{}\-−/+*=&]/g, '_')

  // Adapted from WKOF Core.js
  // If `currentVersion` is newer than otherVersion, return 1; if `currentVersion` is older than otherVersion, return -1; otherwise, return 0
  function compareVersions(currentVersion, otherVersion) {
    const currentVer = currentVersion?.split('.').map((d) => Number(d)) || [];
    const otherVer = otherVersion?.split('.').map((d) => Number(d)) || [];
    const len = Math.max(currentVer.length, otherVer.length);
    for (let idx = 0; idx < len; idx++) {
      const v1 = currentVer[idx] || 0;
      const v2 = otherVer[idx] || 0;
      if (v1 !== v2) {
        return v1 - v2;
      }
    }
    return 0;
  }
  function arrayValuesEqual(a, b) {
    if (a === b) {
      return true;
    }
    if (a == null || b == null) {
      return false;
    }
    let aValues = Object.values(a),
      bValues = Object.values(b);
    if (aValues.length !== bValues.length) {
      return false;
    }
    for (let i = 0; i < aValues.length; ++i) {
      if (aValues[i] !== bValues[i]) {
        return false;
      }
    }
    return true;
  }

  // ----------------------------------------------ELEMENT MANIPULATION---------------------------------------------- //

  function updateAudioButton(button, status) {
    const { audioIdle, audioPlaying } = state.classNames;
    const loading = status === 'loading';
    button.classList.toggle(audioIdle, status === 'idle');
    button.classList.toggle(audioPlaying, status === 'playing');
    button.textContent = loading ? '⏳' : status === 'playing' ? '🔊' : '🔈';
    button.title = loading
      ? 'Loading audio…'
      : status === 'playing'
        ? 'Pause Audio'
        : 'Play Audio';
    button.ariaLabel = button.title;
    button.ariaBusy = String(loading);
  }

  function configureAudioElement(element, example) {
    let loading = false;
    element.addEventListener(
      'click',
      async function (e) {
        e.stopPropagation(); // prevent this click from triggering twice in some scenarios
        const {
          elements: { audio: audioEls, base },
          handlers,
          settings,
        } = state;
        if (loading) {
          return;
        }
        loading = true;
        updateAudioButton(element, 'loading');
        try {
          let source;
          if (!audioEls[element.id]) {
            source = await getMediaBlobUrl(example.sound_url);
          }
          if (!element.isConnected || base !== state.elements.base) {
            return;
          }
          const { audio } = (audioEls[element.id] = audioEls[element.id] || {
            button: element,
            audio: Object.assign(document.createElement('audio'), {
              src: source,
              playbackRate: (settings.general.playback.playbackRate * 2) / 100,
              volume: settings.general.playback.playbackVolume / 100,
              onplay: handlers.onPlay(element),
              onplaying: () => updateAudioButton(element, 'playing'),
              onwaiting: () => updateAudioButton(element, 'loading'),
              onpause: handlers.onStop(element),
              onended: handlers.onStop(element),
              onabort: handlers.onStop(element),
            }),
          });
          audio.onerror = () => {
            if (audio.src !== example.sound_url) {
              updateAudioButton(element, 'loading');
              audio.src = example.sound_url;
              void audio.play().catch((error) => {
                updateAudioButton(element, 'idle');
                console.warn(`${script.name}: Audio playback failed`, error);
              });
            } else {
              updateAudioButton(element, 'idle');
              console.warn(
                `${script.name}: Audio could not be loaded`,
                example.sound_url,
              );
            }
          };
          if (!audio.paused) {
            audio.pause();
            return;
          }
          base.append(audio);
          await audio.play();
        } catch (error) {
          updateAudioButton(element, 'idle');
          console.warn(`${script.name}: Audio playback failed`, error);
        } finally {
          loading = false;
        }
      },
      { passive: true },
    );
  }

  async function updateClassListForSpanElement(element, name, value) {
    switch (name) {
      case 'showEnglish':
      case 'showJapanese':
        element.classList.toggle('show-on-click', value === 'onclick');
        element.classList.toggle('show-on-hover', value === 'onhover');
        break;
      case 'showFurigana':
        if (element.classList.contains('base')) {
          element.classList.toggle('hidden', value !== 'never');
        } else if (element.classList.contains('furigana')) {
          element.classList.toggle('show-ruby-on-hover', value === 'onhover');
          element.classList.toggle('hide-ruby', value === 'never');
        }
        break;
    }
  }

  // ----------------------------------------------------ON CLICK---------------------------------------------------- //

  async function updateOnClickListenerForSpanElement(element, name, value) {
    switch (value) {
      case 'always':
      case 'onhover':
      case 'never':
        if (name !== 'showFurigana') {
          removeOnClickEventListener(element);
        }
        break;
      case 'onclick':
        attachShowOnClickEventListener(element);
        break;
      default:
        return;
    }
  }

  function onAudioElementClick(event) {
    if (event.target.classList.contains('show-on-click')) {
      return;
    }
    const button = event.currentTarget.getElementsByClassName(
      state.classNames.audioButton,
    )[0];
    button?.click();
  }

  function attachAudioOnClickListener(element) {
    // Click anywhere plays the audio
    element.addEventListener('click', onAudioElementClick, { passive: true });
  }

  function onShowOnClick(event) {
    event.stopPropagation(); // prevent this click from triggering the audio to play
    event.target.classList.toggle('show-on-click');
  }

  function attachShowOnClickEventListener(element) {
    // Assign an onclick function to toggle the .show-on-click class
    element.addEventListener('click', onShowOnClick, { passive: true });
  }

  function removeOnClickEventListener(element) {
    element.removeEventListener('click', onShowOnClick, { passive: true });
  }

  // ---------------------------------------------------------------------------------------------------------------- //
  // ----------------------------------------------------SETTINGS---------------------------------------------------- //
  // ---------------------------------------------------------------------------------------------------------------- //

  /** Installs the `options` button in the menu */
  function installMenu() {
    const config = {
      name: script.id,
      submenu: 'Settings',
      title: script.name,
      on_click: openSettings,
    };
    wkof.Menu.insert_script_link(config);
  }

  function scheduleMenuInstall() {
    clearTimeout(menuInstallTimer);
    menuInstallTimer = setTimeout(() => {
      menuInstallTimer = null;
      void wkof.ready('Menu').then(installMenu);
    }, 0);
  }

  async function loadSettings() {
    try {
      return mergeSettings(await wkof.Settings.load(script.id, state.settings));
    } catch (e) {
      throw Error('Error loading settings from WaniKani Open Framework', {
        cause: e,
      });
    }
  }

  // Merges the given settings into the state.settings object, using a deep copy and Object.assign() to avoid updating the state.settings object byref.
  // Returns the updated state.settings object
  function mergeSettings(settings) {
    const mergedSettings = window.structuredClone(settings);
    mergedSettings.general.dataFetching.prefetchCount ??=
      state.settings.general.dataFetching.prefetchCount;
    return Object.assign(state.settings, mergedSettings);
  }

  // Deletes pre-4.0.0 settings; date-versioned releases already use the newer format.
  async function migrateSettingsVersion() {
    const majorUpdateVersion = '4.0.0';
    if (
      /^\d{4}-\d{2}-\d{2}$/.test(state.settings.version) ||
      compareVersions(state.settings.version, majorUpdateVersion) >= 0
    ) {
      return;
    }
    if (state.settings.general.advanced.debugging) {
      console.log(
        `Migrating settings from ${state.settings.version} to ${majorUpdateVersion}`,
      );
    }
    const settingsKey = `wkof.settings.${script.id}`;
    if (settingsKey in wkof.file_cache.dir) {
      await wkof.file_cache.delete(settingsKey);
    }
    await loadSettings();
    wkof.settings[script.id].version = script.version;
    try {
      await wkof.Settings.save(script.id);
    } catch (e) {
      throw Error('Error migrating old settings from WaniKani Open Framework', {
        cause: e,
      });
    }
  }

  // Called whenever the settings dialog is closed (e.g., Save/Cancel)
  async function onSettingsClosed(settings) {
    // Revert any modifications that were unsaved or finalize any that were.
    const { appearance, playback, dataFetching, advanced } = settings.general;
    await Promise.all([
      onAppearanceOptionChanged('showOnKanji', appearance.showOnKanji),
      onAppearanceOptionChanged('exampleLimit', appearance.exampleLimit),
      onAppearanceOptionChanged('maxBoxHeight', appearance.maxBoxHeight),
      onAppearanceOptionChanged('showJapanese', appearance.showJapanese),
      onAppearanceOptionChanged('showFurigana', appearance.showFurigana),
      onAppearanceOptionChanged('showEnglish', appearance.showEnglish),
      onPlaybackOptionChanged('playbackRate', playback.playbackRate),
      onPlaybackOptionChanged('playbackVolume', playback.playbackVolume),
      onPlaybackOptionChanged(
        'restartAudioOnPause',
        playback.restartAudioOnPause,
      ),
      onFetchOptionChanged('retryCount', dataFetching.retryCount),
      onFetchOptionChanged('retryDelay', dataFetching.retryDelay),
      onFetchOptionChanged('checkLastModified', dataFetching.checkLastModified),
      onFetchOptionChanged('mediaCacheLimitMB', dataFetching.mediaCacheLimitMB),
      onFetchOptionChanged('prefetchCount', dataFetching.prefetchCount),
      onAdvancedOptionChanged('debugging', advanced.debugging),
      onAdvancedOptionChanged('failWhenHidden', advanced.failWhenHidden),
      onAdvancedOptionChanged(
        'immersionKitAPIVersion',
        advanced.immersionKitAPIVersion,
      ),
    ]);
  }

  // Called when the user clicks the Save button on the Settings dialog.
  async function onSettingsSaved(updatedSettings) {
    const { pending } = state;
    const prefetchCount = state.settings.general.dataFetching.prefetchCount;
    const {
      filters: {
        exactMatch,
        exactSearch,
        jlptLevel,
        waniKaniLevel,
        // lists: {anime: filterAnime, drama: filterDrama, games: filterGames, literature: filterLiterature, news: filterNews},
      },
      general: {
        /*                appearance: {
                    exampleLimit, // changes handled in onSettingsClosed
                    // highlighting, // Not implemented
                    // maxBoxHeight, // changes handled in onSettingsClosed
                    // showEnglish, // changes handled in onSettingsClosed
                    // showFurigana, // changes handled in onSettingsClosed
                    // showJapanese, // changes handled in onSettingsClosed
                    // showOnKanji, // changes handled in onSettingsClosed
                },*/
        /*                playback: {
                    restartAudioOnPause, // changes handled in onSettingsClosed
                    playbackRate, // changes handled in onSettingsClosed
                    playbackVolume, // changes handled in onSettingsClosed
                },*/
        /*                dataFetching: {
                    retryCount, // changes handled in onSettingsClosed
                    retryDelay, // changes handled in onSettingsClosed
                },*/
        advanced: {
          // debugging, // changes handled in onSettingsClosed
          // failWhenHidden, // changes handled in onSettingsClosed
          immersionKitAPIVersion,
        },
      },
      sorting: {
        primary: primarySorting,
        [script.secondarySortingKeyName]: secondarySorting,
        preferredSources,
      },
    } = state.settings;
    const {
      filters: {
        exactMatch: exactMatchNew,
        exactSearch: exactSearchNew,
        jlptLevel: jlptLevelNew,
        waniKaniLevel: waniKaniLevelNew,
        // lists: {anime: filterAnimeNew, drama: filterDramaNew, games: filterGamesNew, literature: filterLiteratureNew, news: filterNewsNew}
      },
      general: {
        /*                appearance: {
                    // exampleLimit: exampleLimitNew,
                    // highlighting: highlightingNew
                },*/
        advanced: { immersionKitAPIVersion: immersionKitAPIVersionNew },
      },
      sorting: {
        primary: primarySortingNew,
        [script.secondarySortingKeyName]: secondarySortingNew,
        preferredSources: preferredSourcesNew,
      },
    } = updatedSettings;
    for (const listKey of Object.keys(state.settings.filters.lists)) {
      if (
        !arrayValuesEqual(
          state.settings.filters.lists[listKey],
          updatedSettings.filters.lists[listKey],
        )
      ) {
        pending.updateDesiredShows = pending.renderSentences = true;
        break;
      }
    }
    mergeSettings(updatedSettings);
    if (prefetchCount !== state.settings.general.dataFetching.prefetchCount) {
      pending.renderSentences = true;
    }

    // if (showOnKanji !== showOnKanjiNew) setWaniKaniItemInfoListener(showOnKanjiNew);
    if (
      exactSearch !== exactSearchNew ||
      jlptLevel !== jlptLevelNew ||
      waniKaniLevel !== waniKaniLevelNew
    ) {
      // Immersion Kit search options changed
      pending.updateSearchUrl = pending.renderSentences = true;
    }
    if (immersionKitAPIVersion !== immersionKitAPIVersionNew) {
      pending.updateDesiredShows = pending.renderSentences = true;
    } else if (
      exactMatch !== exactMatchNew ||
      primarySorting !== primarySortingNew ||
      secondarySorting !== secondarySortingNew ||
      !arrayValuesEqual(
        getPreferredSources(preferredSources),
        getPreferredSources(preferredSourcesNew),
      )
    ) {
      pending.renderSentences = true;
    }

    if (pending.updateIndexUrl) {
      await fetchImmersionKitDecksIndex();
    }
    if (pending.updateSearchUrl && state.wkItemInfo.item) {
      state.immersionKit.currentSearchUrl = getNewImmersionKitUrl(
        state.wkItemInfo.item.characters,
        updatedSettings,
      );
    }
    if (pending.updateDesiredShows) {
      await updateDesiredShows();
    }
    if (
      pending.renderSentences &&
      state.wkItemInfo.item &&
      state.elements.sentences
    ) {
      await renderSentences();
    }
  }

  function onPrimarySortOptionChanged(name, value) {
    // TODO: This method is a somewhat cursed way of handling this and should be replaced by a natively available method via WKOF if/when I can figure one out.
    const options = document.getElementById(
      `${script.id}_${script.secondarySortingKeyName}`,
    )?.options;
    if (options === null) {
      return;
    }
    const keysToHide =
      state.contentOptions.secondarySortingMethodsToHide(value);
    for (let i = 0; i < options.length; i++) {
      const option = options[i],
        optionName = option.getAttribute('name');
      const shouldHide = keysToHide.includes(optionName);
      option.classList.toggle('hidden', shouldHide);
      if (options.selectedIndex === i && shouldHide) {
        options.selectedIndex = 0;
      }
    }
  }

  function openSettings(e) {
    e.stopPropagation();
    new wkof.Settings(state.settingsDialog).open();
    renderPreferredSourcesSettings();
  }

  function getPreferredSources(preferredSources) {
    const sources = Array.isArray(preferredSources)
      ? preferredSources
      : String(preferredSources ?? '').split(',');
    return [
      ...new Set(
        sources
          .filter((source) => typeof source === 'string')
          .map((source) => source.trim())
          .filter(Boolean),
      ),
    ];
  }

  function renderPreferredSourcesSettings() {
    const container = document.getElementById(`${script.id}-preferred-sources`);
    if (!container) {
      return;
    }
    const savedSources = state.settings.sorting.preferredSources;
    const selectedSources = Array.isArray(savedSources)
      ? getPreferredSources(savedSources)
      : getPreferredSources(savedSources).flatMap((source) => {
          const matches = [...state.content.allContent.keys()]
            .filter((title) =>
              title.toLowerCase().includes(source.toLowerCase()),
            )
            .sort((a, b) => a.localeCompare(b));
          return matches.length > 0 ? matches : [source];
        });
    updateFrameworkPreferredSources(selectedSources);
    const list = document.createElement('ol');
    list.className = `${script.id}-preferred-source-list`;
    const addSource = (title) => {
      if (!title || selectedSources.includes(title)) {
        return;
      }
      selectedSources.push(title);
      renderItems();
      updateFrameworkPreferredSources(selectedSources);
    };
    const renderItems = () => {
      list.replaceChildren();
      for (const title of selectedSources) {
        const item = document.createElement('li');
        item.className = `${script.id}-preferred-source`;
        item.draggable = true;
        item.dataset.sourceTitle = title;
        const dragHandle = Object.assign(document.createElement('span'), {
          className: `${script.id}-preferred-source-handle`,
          textContent: '☰',
          title: 'Drag to reorder',
        });
        dragHandle.setAttribute('aria-hidden', 'true');
        const titleElement = Object.assign(document.createElement('span'), {
          textContent: title,
        });
        const moveUp = Object.assign(document.createElement('button'), {
          type: 'button',
          textContent: '↑',
          title: 'Move up',
          disabled: selectedSources.indexOf(title) === 0,
        });
        moveUp.setAttribute('aria-label', `Move ${title} up`);
        const moveDown = Object.assign(document.createElement('button'), {
          type: 'button',
          textContent: '↓',
          title: 'Move down',
          disabled:
            selectedSources.indexOf(title) === selectedSources.length - 1,
        });
        moveDown.setAttribute('aria-label', `Move ${title} down`);
        const remove = Object.assign(document.createElement('button'), {
          type: 'button',
          textContent: 'Remove',
        });
        remove.setAttribute('aria-label', `Remove ${title}`);
        moveUp.addEventListener('click', () => moveSource(title, -1));
        moveDown.addEventListener('click', () => moveSource(title, 1));
        remove.addEventListener('click', () => {
          selectedSources.splice(selectedSources.indexOf(title), 1);
          renderItems();
          updateFrameworkPreferredSources(selectedSources);
          const option = document.createElement('option');
          option.value = title;
          option.textContent = title;
          sourceSelect.append(option);
          Array.from(sourceSelect.options)
            .sort((a, b) => a.textContent.localeCompare(b.textContent))
            .forEach((sortedOption) => sourceSelect.append(sortedOption));
          addButton.disabled = false;
        });
        item.append(dragHandle, titleElement, moveUp, moveDown, remove);
        list.append(item);
      }
    };
    const moveSource = (title, offset) => {
      const index = selectedSources.indexOf(title);
      const nextIndex = index + offset;
      if (index < 0 || nextIndex < 0 || nextIndex >= selectedSources.length) {
        return;
      }
      selectedSources.splice(index, 1);
      selectedSources.splice(nextIndex, 0, title);
      renderItems();
      updateFrameworkPreferredSources(selectedSources);
    };
    let draggedItem = null;
    list.addEventListener('dragstart', (event) => {
      draggedItem = event.target.closest('li[data-source-title]');
      if (!draggedItem) {
        return;
      }
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', draggedItem.dataset.sourceTitle);
    });
    list.addEventListener('dragover', (event) => {
      if (draggedItem && event.target.closest('li[data-source-title]')) {
        event.preventDefault();
      }
    });
    list.addEventListener('drop', (event) => {
      const target = event.target.closest('li[data-source-title]');
      if (!draggedItem || !target || draggedItem === target) {
        return;
      }
      event.preventDefault();
      const draggedTitle = draggedItem.dataset.sourceTitle;
      const targetTitle = target.dataset.sourceTitle;
      const insertAfter =
        event.clientY >
        target.getBoundingClientRect().top + target.offsetHeight / 2;
      selectedSources.splice(
        0,
        selectedSources.length,
        ...movePreferredSourceInOrder(
          selectedSources,
          draggedTitle,
          targetTitle,
          insertAfter,
        ),
      );
      draggedItem = null;
      renderItems();
      updateFrameworkPreferredSources(selectedSources);
    });
    list.addEventListener('dragend', () => {
      draggedItem = null;
    });

    const sourceSelect = document.createElement('select');
    sourceSelect.setAttribute('aria-label', 'Choose a source to prioritize');
    const sourceTitles = [...state.content.allContent.keys()].sort((a, b) =>
      a.localeCompare(b),
    );
    for (const title of sourceTitles) {
      if (selectedSources.includes(title)) {
        continue;
      }
      const option = document.createElement('option');
      option.value = title;
      option.textContent = title;
      sourceSelect.append(option);
    }
    const addButton = Object.assign(document.createElement('button'), {
      type: 'button',
      textContent: 'Add source',
      disabled: sourceSelect.options.length === 0,
    });
    addButton.addEventListener('click', () => {
      addSource(sourceSelect.value);
      const selectedTitle = sourceSelect.value;
      const option = Array.from(sourceSelect.options).find(
        ({ value }) => value === selectedTitle,
      );
      option?.remove();
      addButton.disabled = sourceSelect.options.length === 0;
    });
    renderItems();
    container.replaceChildren(sourceSelect, addButton, list);
  }

  function updateFrameworkPreferredSources(preferredSources) {
    const frameworkSettings = wkof.settings?.[script.id];
    if (!frameworkSettings) {
      throw new Error(
        'WKOF settings are unavailable while editing source priorities',
      );
    }
    frameworkSettings.sorting.preferredSources = [...preferredSources];
  }

  function movePreferredSourceInOrder(
    preferredSources,
    draggedTitle,
    targetTitle,
    insertAfter,
  ) {
    const sources = [...preferredSources];
    const draggedIndex = sources.indexOf(draggedTitle);
    const targetIndex = sources.indexOf(targetTitle);
    if (
      draggedIndex === -1 ||
      targetIndex === -1 ||
      draggedIndex === targetIndex
    ) {
      return sources;
    }
    sources.splice(draggedIndex, 1);
    const adjustedTargetIndex = sources.indexOf(targetTitle);
    sources.splice(adjustedTargetIndex + Number(insertAfter), 0, draggedTitle);
    return sources;
  }

  async function onAppearanceOptionChanged(name, value) {
    if (value === state.settings.general.appearance[name]) {
      return;
    }
    state.settings.general.appearance[name] = value;
    let selector;
    switch (name) {
      case 'exampleLimit': {
        state.pending.updateSearchUrl = state.pending.renderSentences = true;
        if (state.wkItemInfo.item && state.elements.sentences) {
          await renderSentences();
        }
        return;
      }
      case 'maxBoxHeight': {
        if (!Number.isNaN(Number(value))) {
          value += 'px';
          state.settings.general.appearance[name] = wkof.settings[
            script.id
          ].general.appearance.maxBoxHeight = value;
        }
        const replacement = `$1 ${value};`;
        state.elements.styleSheet.innerHTML =
          state.elements.styleSheet.innerHTML.replace(
            script.regex.maxHeightSearch,
            replacement,
          );
        return;
      }
      case 'showOnKanji':
        setWaniKaniItemInfoListener();
        return;
      case 'showEnglish':
        selector = '.example-text .en > span';
        break;
      case 'showFurigana':
      case 'showJapanese':
        selector = '.example-text .ja > span';
        break;
      default:
        return;
    }
    // On reached for the text displaying options
    if (!state.elements.sentences) {
      return;
    }
    const exampleEls = state.elements.sentences.querySelectorAll(selector);
    const promises = [];
    for (let i = 0; i < exampleEls.length; i++) {
      const el = exampleEls[i];
      promises.push(updateClassListForSpanElement(el, name, value));
      promises.push(updateOnClickListenerForSpanElement(el, name, value));
    }
    await Promise.all(promises);
  }

  async function onAdvancedOptionChanged(name, value) {
    if (value === state.settings.general.advanced[name]) {
      return;
    }
    state.settings.general.advanced[name] = value;
    switch (name) {
      case 'debugging':
        break;
      case 'failWhenHidden':
        if (!state.wkItemInfo.item || !state.elements.sentences) {
          return;
        }
        await renderSentences();
        break;
      case 'immersionKitAPIVersion':
        await onImmersionKitAPIVersionOptionChanged(value);
        break;
    }
  }

  // Called by any setting listener to verify the setting is different from the existing value
  async function onPlaybackOptionChanged(name, value) {
    if (value === state.settings.general.playback[name]) {
      return;
    }
    state.settings.general.playback[name] = value;
    const audioContainer = state.elements.base?.querySelectorAll('audio');
    if (audioContainer == null) {
      return;
    }
    switch (name) {
      case 'playbackRate':
        for (const audio of audioContainer) {
          audio.playbackRate = (value * 2) / 100;
        }
        break;
      case 'playbackVolume':
        for (const audio of audioContainer) {
          audio.volume = value / 100;
        }
        break;
      case 'restartAudioOnPause':
        break;
    }
  }

  async function onFetchOptionChanged(name, value) {
    let normalizedValue = value;
    if (name === 'mediaCacheLimitMB') {
      normalizedValue = Number(value);
      if (!Number.isFinite(normalizedValue) || normalizedValue < 0) {
        throw new Error('Media cache limit must be a non-negative number');
      }
    }
    if (name === 'prefetchCount') {
      normalizedValue = Number(value);
      if (!Number.isInteger(normalizedValue) || normalizedValue < 0) {
        throw new Error('Prefetch count must be a non-negative integer');
      }
    }
    if (normalizedValue === state.settings.general.dataFetching[name]) {
      return;
    }
    let prevRetryCount = state.settings.general.dataFetching.retryCount;
    state.settings.general.dataFetching[name] = normalizedValue;
    switch (name) {
      case 'retryCount':
        // TODO: Possibly make this not affect the fetch count when the dialog was canceled instead of saved
        if (!state.elements.sentences) {
          return;
        }
        if (
          state.elements.sentences.childElementCount === 0 &&
          value > prevRetryCount &&
          value >=
            (state.immersionKit.fetchCount[
              state.immersionKit.currentSearchUrl
            ] ?? 0)
        ) {
          await renderSentences();
        }
        break;
      case 'retryDelay':
      case 'checkLastModified':
        break;
      case 'mediaCacheLimitMB':
        await ikMediaCacheDB.trimToLimit(normalizedValue * 1024 * 1024);
        break;
      case 'prefetchCount':
        if (state.wkItemInfo.item?.characters) {
          await prefetchItem(
            state.wkItemInfo.item.characters,
            state.wkItemInfo.item.type,
          );
        }
        break;
    }
  }

  // Called when the flush cached data button is clicked
  async function onFlushCachedDataClicked(name, value, on_change) {
    await deleteCachedImmersionKitData();
    if (state.settings.general.advanced.debugging) {
      console.log('Immersion Kit data has been deleted.');
    }
    state.pending.updateIndexUrl =
      state.pending.updateSearchUrl =
      state.pending.updateDesiredShows =
      state.pending.renderSentences =
        true;
    await on_change();
  }

  async function onImmersionKitAPIVersionOptionChanged(value) {
    let title;
    // Hardcoded the values that need to be swapped based on the API as of version 4.0.0 of this script
    switch (value) {
      case '1':
        for (const title of [
          'Good Morning Call Season 1',
          'Good Morning Call Season 2',
        ]) {
          state.content.drama[title] = title;
        }
        title = 'Good Morning Call';
        if (title in state.content.drama) {
          delete state.content.drama[title];
        }
        sortObjectPropertiesInPlace(state.settings.filters.lists.drama);
        sortObjectPropertiesInPlace(state.content.drama);
        break;
      case '2':
        for (const title of [
          'Good Morning Call Season 1',
          'Good Morning Call Season 2',
        ]) {
          if (!(title in state.content.drama)) {
            continue;
          }
          delete state.content.drama[title];
        }
        title = 'Good Morning Call';
        state.content.drama[title] = title;
        sortObjectPropertiesInPlace(state.content.drama);
        break;
      default:
        return;
    }
    updateKeyMapForTitles();
    state.pending.updateSearchUrl =
      state.pending.updateDesiredShows =
      state.pending.renderSentences =
        true;
  }

  async function updateDesiredShows() {
    // Combine settings objects to a single set containing the desired titles
    const errors = [];
    for (const [category, values] of Object.entries(
      state.settings.filters.lists,
    )) {
      for (const [title, value] of Object.entries(values)) {
        // Always use the full title as the key
        let entry = { category, enabled: value, tags: [], title };
        if (state.content.allContent.has(title)) {
          // Push the settings value to the corresponding entry in the content object
          entry = state.content.allContent.get(title);
          entry.enabled = value;
          // Update the selection set for the settings dialog
          if (!state.content.selections[entry.category]) {
            state.content.selections[entry.category] = {};
          }
          state.content.selections[entry.category][title] = value;
        } else if (typeof value === 'boolean') {
          errors.push(
            Object.assign(
              {
                error: `"title" from "settings.filters.lists.${category}" not found in "allContent"`,
              },
              entry,
            ),
          );
        } else {
          state.content.allContent.set(title, entry);
          errors.push(
            Object.assign(
              { error: 'Unresolved Error. Added "title" to "allContent"' },
              entry,
            ),
          );
        }
      }
    }
    if (errors.length > 0) {
      console.debug(`Error(s) found during updateDesiredShows:`, errors);
    }
    state.pending.updateDesiredShows = false;
  }

  function validateMaxHeight(value) {
    return (
      value === undefined ||
      value === null ||
      value === '' ||
      script.regex.validCssUnit.test(value) ||
      'Number and (optional) valid unit type only'
    );
  }

  function validatePlaybackRate(value) {
    return { valid: value >= 5, msg: `${value * 2}%` };
  }

  function validatePlaybackVolume(value) {
    return { valid: true, msg: `${value}%` };
  }

  // ---------------------------------------------------------------------------------------------------------------- //
  // -----------------------------------------------------STYLES----------------------------------------------------- //
  // ---------------------------------------------------------------------------------------------------------------- //

  async function addStyle() {
    if (document.getElementById(script.styleSheetName)) {
      return;
    }
    const {
      classNames: { audioIdle, audioButton },
      elements,
      settings: {
        general: {
          appearance: { maxBoxHeight },
        },
      },
    } = state;
    elements.styleSheet = Object.assign(document.createElement('style'), {
      id: script.styleSheetName,
      type: 'text/css',
      // language=CSS
      textContent: `
            #${script.id}_dialog button { background-color: #555555; border: 2px solid #555555; color: white; padding: 0 10px; text-align: center; text-decoration: none; display: inline-block; margin: 0 2px; transition-duration: 0.1s; cursor: pointer; }
            #${script.id}_dialog button:hover { background-color: gray; }
            #${script.id}_dialog button:active { background-color: gray; transform: translate(0, 3px); }
            #${script.id} { max-height: ${maxBoxHeight}; overflow-y: auto; }
            #${script.id} > button { display: block; margin: 0.5em auto 1em; padding: 0.5em 1em; border: 1px solid #555; border-radius: 4px; background-color: #555; color: white; font: inherit; cursor: pointer; transition: background-color 0.1s; }
            #${script.id} > button:hover { background-color: #444; }
            #${script.id} > button:disabled { cursor: wait; opacity: 0.7; }
            #${script.id}_dialog .${script.id}-preferred-source-list { list-style: none; margin: 0.5em 0; padding: 0; }
            #${script.id}_dialog .${script.id}-preferred-source { display: flex; align-items: center; gap: 0.5em; margin: 0.25em 0; padding: 0.35em; border: 1px solid #aaa; border-radius: 4px; }
            #${script.id}_dialog .${script.id}-preferred-source-handle { cursor: grab; user-select: none; }
            #${script.id}_dialog .${script.id}-preferred-source > span:nth-child(2) { flex: 1; }
            .${script.id}-settings-btn { font-size: 14px; cursor: pointer; vertical-align: middle; margin-left: 10px; }
            #${script.id}-container { border: none; font-size: 100%; }
            #${script.id} pre { white-space: pre-wrap; white-space: -moz-pre-wrap; white-space: -pre-wrap; white-space: -o-pre-wrap; word-wrap: break-word; }
            #${script.id} .example { display: flex; align-items: center; margin-bottom: 1em; cursor: pointer; }
            #${script.id} .example > * { flex-grow: 1; flex-shrink: 1; flex-basis: min-content; }
            #${script.id} .example img { padding-right: 1em; max-width: 200px; }
            #${script.id} .example .${audioButton} { background-color: transparent; margin-left: 0.25em; }
            #${script.id} .example .${audioButton}.${audioIdle} { opacity: 50%; }
            #${script.id} .example-text { display: table; white-space: normal; }
            #${script.id} .example-text .title { font-weight: var(--font-weight-bold); }
            #${script.id} .example-text .ja { font-size: var(--font-size-xlarge); margin-bottom: 0.25em;}
            /* Set the default and on-hover appearance */
            #${script.id} .show-on-hover:hover, #${script.id} .show-ruby-on-hover:hover ruby rt { background-color: inherit; color: inherit; visibility: visible; }
            /* Set the color/appearance of the marked keyword */
            #${script.id} mark, #${script.id} .show-on-hover:hover mark { background-color: inherit; color: darkcyan; }
            /* Set the appearance for show-on-hover and show-on-click elements when trigger state is inactive */
            #${script.id} .show-on-hover, #${script.id} .show-on-hover mark, #${script.id} .show-on-click, #${script.id} .show-on-click mark { background-color: #ccc; color: transparent; text-shadow: none; }
            /* Set the appearance for hidden and show-ruby-on-hover elements when trigger state is inactive */
            #${script.id} .show-ruby-on-hover ruby rt { visibility: hidden; }
            #${script.id} .hide, #${script.id} .hide-ruby ruby rt { display: none; }
            `.replaceAll(/(\n|^ {2,})/gm, ''),
    });
    document.getElementsByTagName('head')[0].append(elements.styleSheet);
  }

  // ---------------------------------------------------------------------------------------------------------------- //
  // ----------------------------------------------------FURIGANA---------------------------------------------------- //
  // ---------------------------------------------------------------------------------------------------------------- //

  function escapeHtml(text) {
    return text.replace(/[&<>"']/g, (character) => {
      switch (character) {
        case '&':
          return '&amp;';
        case '<':
          return '&lt;';
        case '>':
          return '&gt;';
        case '"':
          return '&quot;';
        case "'":
          return '&#39;';
      }
    });
  }

  function Furigana(expression, expressionWithFurigana) {
    this.expression = expression;
    this.expressionWithFurigana = expressionWithFurigana;
    this.keyword = this.keywordRegex = this.firstKeywordIndex = null;
    this.keywordTag = 'mark';
    this.furiganaSegments = this.parseFurigana(expressionWithFurigana);
  }

  Furigana.prototype.setKeyword = function (keyword) {
    this.keyword = keyword ?? null;
    this.keywordRegex = keyword !== null ? new RegExp(keyword, 'g') : null;
    this.firstKeywordIndex = null; // Reset keyword index
  };

  Furigana.prototype.getExpressionHtml = function () {
    const keywordMatches =
      this.keywordRegex !== null
        ? Array.from(this.expression.matchAll(this.keywordRegex))
        : [];
    let html = '',
      nextIndex = 0;
    for (const match of keywordMatches) {
      if (match.index === undefined) {
        continue;
      }
      html += escapeHtml(this.expression.substring(nextIndex, match.index));
      html += `<${this.keywordTag}>${escapeHtml(match[0])}</${this.keywordTag}>`;
      nextIndex = match.index + match[0].length;
    }
    return html + escapeHtml(this.expression.substring(nextIndex));
  };

  Furigana.prototype.getFuriganaHtml = function () {
    const normalizedSegments = this.normalizeSegments(
      this.furiganaSegments,
      this.expression,
    );
    let html = '';
    for (let i = 0; i < normalizedSegments.length; i++) {
      const { base, furigana } = normalizedSegments[i];
      html +=
        furigana !== null
          ? `<ruby>${base}<rp>[</rp><rt>${escapeHtml(furigana)}</rt><rp>]</rp></ruby>`
          : base;
    }
    return html;
  };

  Furigana.prototype.getFirstKeywordIndex = function () {
    if (this.keyword === null) {
      return -1;
    }
    if (this.firstKeywordIndex !== null) {
      return this.firstKeywordIndex;
    }
    return (this.firstKeywordIndex = this.expression.search(this.keywordRegex));
  };

  Furigana.prototype.parseFurigana = function (expressionWithFurigana) {
    const segments = [],
      regex =
        /([\u3001-\u303F\u3041-\u3096\u30A0-\u30FF\u3400-\u4DB5\u4E00-\u9FCB\uF900-\uFA6A\uFF01-\uFF5E\uFF5F-\uFF9F]+|[^[\]<> \u4E00-\u9FCB]+)(?:\[([^[\]]+)])?/g;
    let match;

    while ((match = regex.exec(expressionWithFurigana)) !== null) {
      segments.push({ base: match[1], furigana: match[2] ?? null });
    }
    return segments;
  };

  Furigana.prototype.normalizeSegments = function (segments, expression) {
    const normalizedSegments = [],
      keywordRegex = this.keywordRegex;
    const keywordMatches =
      keywordRegex !== null
        ? Array.from(expression.matchAll(keywordRegex))
        : [];

    let nextIndex = 0;
    for (let i = 0; i < segments.length; i++) {
      const curIndex = nextIndex;
      if (i === segments.length - 1) {
        nextIndex = expression.length;
      } else {
        nextIndex = expression.indexOf(segments[i + 1].base[0], nextIndex);
        if (nextIndex === -1) {
          nextIndex = curIndex + segments[i].base.length;
        }
      }
      let matchingSection = '',
        textIndex = curIndex;
      for (const match of keywordMatches) {
        if (match.index === undefined) {
          continue;
        }
        const [start, end] = [match.index, match.index + match[0].length];
        if (this.firstKeywordIndex === null && start >= 0) {
          this.firstKeywordIndex = start;
        }
        const markStart = Math.max(start, curIndex),
          markEnd = Math.min(end, nextIndex);
        if (markStart < textIndex || markStart >= markEnd) {
          continue;
        }
        matchingSection += escapeHtml(
          expression.substring(textIndex, markStart),
        );
        matchingSection += `<${this.keywordTag}>${escapeHtml(expression.substring(markStart, markEnd))}</${this.keywordTag}>`;
        textIndex = markEnd;
      }
      matchingSection += escapeHtml(expression.substring(textIndex, nextIndex));
      normalizedSegments.push({
        base: matchingSection,
        furigana: segments[i].furigana,
      });
    }
    return normalizedSegments;
  };
})();
