const JIKAN_BASE = 'https://api.jikan.moe/v4/anime';
const WORKER_RETRY_DELAY = 3500;
const JIKAN_PAGE_LIMIT = 20;
const MAX_EXEC_TIME_MS = 25000;
const AIRING_REFRESH_DAYS = 7;
const ALLOWED_TYPES = ['tv', 'movie', 'ova', 'ona', 'special', 'side story', 'other', 'pvs', 'music', 'tv mini'];
const DB_BATCH_SIZE = 50;
const WORKER_TIMEOUT_MS = 25000;
const WORKER_MAX_RETRIES = 3;
const WORKER_RETRY_BACKOFF = 2000;

// ---------- Backoff delays (in ms) ----------
const BACKOFF_DELAYS = [
  5 * 60 * 1000,     // 5 minutes
  15 * 60 * 1000,    // 15 minutes
  60 * 60 * 1000,    // 1 hour
  4 * 60 * 60 * 1000, // 4 hours
  6 * 60 * 60 * 1000  // 6 hours (max)
];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- Supabase helpers ----------
async function supabaseQuery(path, method = 'GET', body = null, supabaseUrl, supabaseKey) {
  const url = `${supabaseUrl}/rest/v1/${path}`;
  const headers = {
    'apikey': supabaseKey,
    'Authorization': `Bearer ${supabaseKey}`,
    'Content-Type': 'application/json'
  };
  const options = { method, headers };
  if (body) options.body = JSON.stringify(body);
  const res = await fetch(url, options);
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Supabase ${method} ${path} failed: ${res.status} ${errText}`);
  }
  // Handle 204 No Content (e.g., PATCH with no matching rows)
  if (res.status === 204 || res.headers.get('content-length') === '0') {
    return null;
  }
  const text = await res.text();
  if (!text) return null;
  return JSON.parse(text);
}

async function getMemory(key, supabaseUrl, supabaseKey) {
  try {
    const rows = await supabaseQuery(`automation_memory?key=eq.${key}&select=value`, 'GET', null, supabaseUrl, supabaseKey);
    if (rows && rows.length > 0) return rows[0].value;
  } catch (_) {}
  return null;
}

async function setMemory(key, value, supabaseUrl, supabaseKey) {
  const payload = { key, value, updated_at: new Date().toISOString() };
  // Use Supabase upsert: POST with Prefer: resolution=merge-duplicates
  // This inserts if key doesn't exist, or updates if it does (avoids 409 duplicate key)
  const url = `${supabaseUrl}/rest/v1/automation_memory`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'apikey': supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates'
    },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Supabase upsert failed: ${res.status} ${errText}`);
  }
}

async function animeExists(malId, supabaseUrl, supabaseKey) {
  try {
    const rows = await supabaseQuery(`anime_data?mal_id=eq.${malId}&select=id`, 'GET', null, supabaseUrl, supabaseKey);
    return rows && rows.length > 0;
  } catch (_) { return false; }
}

async function insertOrUpdateAnime(record, supabaseUrl, supabaseKey) {
  const payload = { ...record, updated_at: new Date().toISOString() };
  const exists = await animeExists(record.mal_id, supabaseUrl, supabaseKey);
  if (exists) {
    await supabaseQuery(`anime_data?mal_id=eq.${record.mal_id}`, 'PATCH', payload, supabaseUrl, supabaseKey);
  } else {
    await supabaseQuery('anime_data', 'POST', payload, supabaseUrl, supabaseKey);
  }
}

// ---------- Kuromoji romaji conversion ----------
async function getRomaji(japaneseTitle, kuromojiWorkerUrl) {
  if (!japaneseTitle) return null;
  try {
    const url = `${kuromojiWorkerUrl}/convert?text=${encodeURIComponent(japaneseTitle)}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`Kuromoji worker returned ${res.status} for title: ${japaneseTitle}`);
      return null;
    }
    const data = await res.json();
    return data.romaji || null;
  } catch (err) {
    console.warn('Kuromoji conversion failed:', err.message);
    return null;
  }
}

// ---------- Data transformation (all columns from /full) ----------
async function transformAnimeData(workerResponse, malId, kuromojiWorkerUrl) {
  const full = workerResponse.data.full.data;
  const titles = full.titles || [];
  const defaultTitle = titles.find(t => t.type === 'Default')?.title || '';
  const englishTitle = titles.find(t => t.type === 'English')?.title || '';
  const japaneseTitle = titles.find(t => t.type === 'Japanese')?.title || '';
  const synonyms = titles.filter(t => t.type === 'Synonym').map(t => t.title);

  // Generate romaji from Japanese title using Kuromoji
  let romanjiTitle = null;
  if (japaneseTitle) {
    romanjiTitle = await getRomaji(japaneseTitle, kuromojiWorkerUrl);
  }

  // Slug: use default_title, fallback to english_title
  let slugSource = defaultTitle || englishTitle || japaneseTitle;
  const slug = slugSource.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  let seasonString = null;
  if (full.season && full.year) seasonString = `${full.season}-${full.year}`;

  // Genres + themes + demographics
  const allGenres = [
    ...(full.genres || []).map(g => g.name),
    ...(full.themes || []).map(t => t.name),
    ...(full.demographics || []).map(d => d.name)
  ];
  const genresString = allGenres.join(', ');
  const studiosString = (full.studios || []).map(s => s.name).join(', ');
  const producersString = (full.producers || []).map(p => p.name).join(', ');

  // Images
  const images = full.images || {};
  const jpg = images.jpg || {};
  const webp = images.webp || {};

  const trailer = full.trailer || {};
  const broadcast = full.broadcast || {};
  const aired = full.aired || {};
  const from = aired.from ? new Date(aired.from) : null;
  const to = aired.to ? new Date(aired.to) : null;
  const propFrom = aired.prop?.from || {};
  const propTo = aired.prop?.to || {};

  const searchVector = [
    defaultTitle, englishTitle, japaneseTitle, ...synonyms,
    full.synopsis || '',
    genresString,
    full.type || '',
    full.source || '',
    studiosString,
    full.rating || '',
    seasonString || ''
  ].filter(Boolean).join(' ');

  const searchRpc = [
    defaultTitle, englishTitle, japaneseTitle, ...synonyms,
    `Score: ${full.score || ''}`,
    `Genres: ${genresString}`,
    `Studio: ${studiosString}`,
    `Season: ${seasonString || ''}`,
    `Type: ${full.type || ''}`
  ].filter(Boolean).join(' | ');

  const malLink = full.url || `https://myanimelist.net/anime/${malId}`;
  const officialSite = full.external?.find(e => e.name === 'Official Site')?.url || '';

  return {
    media_type: 'anime',
    media_id: `jikan-${malId}`,
    mal_id: malId,
    default_title: defaultTitle,
    english_title: englishTitle,
    romanji_title: romanjiTitle,
    japanese_title: japaneseTitle,
    synonyms: synonyms,
    slug: slug,
    type: full.type || '',
    source: full.source || '',
    episodes: full.episodes || 0,
    status: full.status || '',
    airing: full.airing || false,
    aired_from: from,
    aired_to: to,
    aired_prop_from: propFrom,
    aired_prop_to: propTo,
    aired_string: aired.string || '',
    duration: full.duration || '',
    rating: full.rating || '',
    score: full.score || 0,
    scored_by: full.scored_by || 0,
    popularity: full.popularity || 0,
    rank: full.rank || 0,
    members: full.members || 0,
    favorites: full.favorites || 0,
    synopsis: full.synopsis || '',
    season: full.season || '',
    year: full.year || 0,
    season_string: seasonString,
    broadcast_day: broadcast.day || '',
    broadcast_time: broadcast.time || '',
    broadcast_timezone: broadcast.timezone || '',
    broadcast_string: broadcast.string || '',
    genres: genresString,
    studios: studiosString,
    producers: producersString,
    image_url_jpg: jpg.image_url || '',
    large_image_url_jpg: jpg.large_image_url || '',
    image_url_webp: webp.image_url || '',
    large_image_url_webp: webp.large_image_url || '',
    trailer_embed_url: trailer.embed_url || '',
    official_site: officialSite,
    mal_link: malLink,
    full_cached: workerResponse,
    finished: full.status === 'Finished Airing' ? true : false
  };
}

// ---------- Fetch Jikan page ----------
async function fetchJikanPage(page, filters = {}) {
  const params = new URLSearchParams({ page, limit: JIKAN_PAGE_LIMIT, ...filters });
  const url = `${JIKAN_BASE}?${params}`;
  const res = await fetch(url);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Jikan page ${page} error: ${res.status} ${err}`);
  }
  return res.json();
}

// ---------- Call aggregator worker (with retry & timeout) ----------
async function fetchFromWorker(malId, workerUrl) {
  const url = `${workerUrl}/${malId}`;
  let lastError = null;

  for (let attempt = 0; attempt < WORKER_MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), WORKER_TIMEOUT_MS);

      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Worker returned ${res.status} for ${malId}: ${errText}`);
      }
      return await res.json();
    } catch (err) {
      lastError = err.message;
      if (attempt === WORKER_MAX_RETRIES - 1) throw new Error(`Worker failed after ${WORKER_MAX_RETRIES} attempts: ${lastError}`);
      await sleep(WORKER_RETRY_BACKOFF * (attempt + 1));
    }
  }
  throw new Error(`Worker failed for ${malId}: ${lastError}`);
}

// ---------- Process one anime ----------
async function processAnime(malId, workerUrl, supabaseUrl, supabaseKey, kuromojiWorkerUrl, startTime) {
  if (Date.now() - startTime > MAX_EXEC_TIME_MS - 5000) {
    throw new Error('TIME_LIMIT_NEAR');
  }
  const workerData = await fetchFromWorker(malId, workerUrl);
  const record = await transformAnimeData(workerData, malId, kuromojiWorkerUrl);
  await insertOrUpdateAnime(record, supabaseUrl, supabaseKey);
  return record;
}

// ---------- Process a list (for airing/upcoming insertion) ----------
async function processAnimeList(animes, workerUrl, supabaseUrl, supabaseKey, kuromojiWorkerUrl, startTime) {
  let count = 0;
  for (const anime of animes) {
    if (Date.now() - startTime > MAX_EXEC_TIME_MS - 5000) {
      return { count, paused: true };
    }
    const malId = anime.mal_id;
    const type = anime.type?.toLowerCase();
    if (!ALLOWED_TYPES.includes(type)) continue;
    if ((anime.genres || []).some(g => g.name.toLowerCase() === 'hentai')) continue;
    if (await animeExists(malId, supabaseUrl, supabaseKey)) continue;
    try {
      await processAnime(malId, workerUrl, supabaseUrl, supabaseKey, kuromojiWorkerUrl, startTime);
      await sleep(WORKER_RETRY_DELAY);
      count++;
    } catch (err) {
      if (err.message === 'TIME_LIMIT_NEAR') {
        return { count, paused: true };
      }
      await setMemory('last_error', { malId, error: err.message, time: new Date().toISOString() }, supabaseUrl, supabaseKey);
    }
  }
  return { count, paused: false };
}

// ---------- Main entry point ----------
export default {
  async fetch(request, env, ctx) {
    const supabaseUrl = env.SUPABASE_URL;
    const supabaseKey = env.SUPABASE_KEY;
    const workerUrl = env.WORKER_URL;
    const kuromojiWorkerUrl = env.KUROMOJI_WORKER_URL;
    if (!supabaseUrl || !supabaseKey || !workerUrl || !kuromojiWorkerUrl) {
      return new Response('Missing environment variables', { status: 500 });
    }

    const startTime = Date.now();
    try {
      const memory = await getMemory('automation_state', supabaseUrl, supabaseKey) || {};
      let phase = memory.phase || 'initial_scan';

      // ---------- INITIAL SCAN ----------
      if (phase === 'initial_scan') {
        let currentPage = memory.current_page || 1;
        let offset = memory.offset_in_page || 0;

        let pageData;
        try {
          pageData = await fetchJikanPage(currentPage);
        } catch (err) {
          await setMemory('last_error', { phase: 'initial_scan', page: currentPage, error: err.message }, supabaseUrl, supabaseKey);
          return new Response(`Error: ${err.message}`, { status: 500 });
        }

        const animes = pageData.data || [];
        const totalPages = pageData.pagination?.last_visible_page || 1;

        for (let i = offset; i < animes.length; i++) {
          if (Date.now() - startTime > MAX_EXEC_TIME_MS - 5000) {
            await setMemory('automation_state', { phase: 'initial_scan', current_page: currentPage, offset_in_page: i }, supabaseUrl, supabaseKey);
            return new Response(`Paused at page ${currentPage}, index ${i} (time limit)`, { status: 200 });
          }
          const anime = animes[i];
          const malId = anime.mal_id;
          const type = anime.type?.toLowerCase();
          if (!ALLOWED_TYPES.includes(type)) continue;
          if ((anime.genres || []).some(g => g.name.toLowerCase() === 'hentai')) continue;
          if (await animeExists(malId, supabaseUrl, supabaseKey)) continue;
          try {
            await processAnime(malId, workerUrl, supabaseUrl, supabaseKey, kuromojiWorkerUrl, startTime);
            await sleep(WORKER_RETRY_DELAY);
          } catch (err) {
            if (err.message === 'TIME_LIMIT_NEAR') {
              await setMemory('automation_state', { phase: 'initial_scan', current_page: currentPage, offset_in_page: i }, supabaseUrl, supabaseKey);
              return new Response(`Paused at page ${currentPage}, index ${i} (time limit)`, { status: 200 });
            }
            await setMemory('last_error', { phase: 'initial_scan', page: currentPage, index: i, malId, error: err.message }, supabaseUrl, supabaseKey);
          }
        }

        if (currentPage >= totalPages) {
          await setMemory('automation_state', { phase: 'update', db_offset: 0 }, supabaseUrl, supabaseKey);
          return new Response('Initial scan complete. Entering update mode.', { status: 200 });
        } else {
          await setMemory('automation_state', { phase: 'initial_scan', current_page: currentPage + 1, offset_in_page: 0 }, supabaseUrl, supabaseKey);
          return new Response(`Moved to page ${currentPage + 1}`, { status: 200 });
        }
      }

      // ---------- UPDATE MODE (with smart backoff) ----------
      else {
        // --- Check backoff state ---
        const backoffState = await getMemory('jikan_backoff', supabaseUrl, supabaseKey) || {};
        const failureCount = backoffState.failure_count || 0;
        const nextRetryTime = backoffState.next_retry_time ? new Date(backoffState.next_retry_time).getTime() : 0;

        // If we're in cooldown, skip this run
        if (nextRetryTime > Date.now()) {
          const remainingMinutes = Math.ceil((nextRetryTime - Date.now()) / (60 * 1000));
          await setMemory('automation_state', { phase: 'update', db_offset: memory.db_offset || 0 }, supabaseUrl, supabaseKey);
          return new Response(`Jikan is in cooldown. Retry in ${remainingMinutes} minutes.`, { status: 200 });
        }

        // --- 1. Fetch airing list (CRITICAL) ---
        let airingIds = new Set();
        let airingFetchSuccess = true;
        let page = 1;
        let hasMore = true;
        while (hasMore && airingFetchSuccess) {
          if (Date.now() - startTime > MAX_EXEC_TIME_MS - 5000) {
            await setMemory('automation_state', { phase: 'update', step: 'fetch_airing', page }, supabaseUrl, supabaseKey);
            return new Response(`Paused while fetching airing at page ${page} (time limit)`, { status: 200 });
          }
          try {
            const pageData = await fetchJikanPage(page, { status: 'airing' });
            const animes = pageData.data || [];
            animes.forEach(a => airingIds.add(a.mal_id));
            const result = await processAnimeList(animes, workerUrl, supabaseUrl, supabaseKey, kuromojiWorkerUrl, startTime);
            if (result.paused) {
              await setMemory('automation_state', { phase: 'update', step: 'insert_airing', page }, supabaseUrl, supabaseKey);
              return new Response(`Paused while inserting airing at page ${page} (time limit)`, { status: 200 });
            }
            hasMore = pageData.pagination?.has_next_page || false;
            page++;
          } catch (err) {
            // Airing fetch failed – apply backoff
            const newFailureCount = failureCount + 1;
            const delayIndex = Math.min(newFailureCount, BACKOFF_DELAYS.length - 1);
            const backoffMs = BACKOFF_DELAYS[delayIndex];
            const nextRetry = Date.now() + backoffMs;

            await setMemory('jikan_backoff', {
              failure_count: newFailureCount,
              last_failure_time: new Date().toISOString(),
              next_retry_time: new Date(nextRetry).toISOString(),
              last_error: err.message
            }, supabaseUrl, supabaseKey);

            await setMemory('last_error', { step: 'fetch_airing', error: err.message, time: new Date().toISOString() }, supabaseUrl, supabaseKey);
            airingFetchSuccess = false;
            break;
          }
        }

        if (!airingFetchSuccess) {
          await setMemory('automation_state', { phase: 'update', db_offset: memory.db_offset || 0 }, supabaseUrl, supabaseKey);
          const delayIndex = Math.min(failureCount + 1, BACKOFF_DELAYS.length - 1);
          return new Response(`Airing list fetch failed – backing off for ${Math.ceil(BACKOFF_DELAYS[delayIndex] / (60 * 1000))} minutes.`, { status: 200 });
        }

        // --- SUCCESS: Reset backoff ---
        await setMemory('jikan_backoff', { failure_count: 0, last_success_time: new Date().toISOString() }, supabaseUrl, supabaseKey);

        // --- 2. Fetch upcoming list (optional) ---
        let upcomingIds = new Set();
        page = 1;
        hasMore = true;
        while (hasMore) {
          if (Date.now() - startTime > MAX_EXEC_TIME_MS - 5000) {
            await setMemory('automation_state', { phase: 'update', step: 'fetch_upcoming', page }, supabaseUrl, supabaseKey);
            return new Response(`Paused while fetching upcoming at page ${page} (time limit)`, { status: 200 });
          }
          try {
            const pageData = await fetchJikanPage(page, { status: 'upcoming' });
            const animes = pageData.data || [];
            animes.forEach(a => upcomingIds.add(a.mal_id));
            const result = await processAnimeList(animes, workerUrl, supabaseUrl, supabaseKey, kuromojiWorkerUrl, startTime);
            if (result.paused) {
              await setMemory('automation_state', { phase: 'update', step: 'insert_upcoming', page }, supabaseUrl, supabaseKey);
              return new Response(`Paused while inserting upcoming at page ${page} (time limit)`, { status: 200 });
            }
            hasMore = pageData.pagination?.has_next_page || false;
            page++;
          } catch (err) {
            await setMemory('last_error', { step: 'fetch_upcoming', error: err.message }, supabaseUrl, supabaseKey);
            break;
          }
        }

        // --- 3. Process unfinished DB animes ---
        let dbOffset = memory.db_offset || 0;
        let updatedCount = 0;
        const refreshIntervalMs = AIRING_REFRESH_DAYS * 24 * 60 * 60 * 1000;

        let totalUnfinished = 0;
        try {
          const countRes = await supabaseQuery('anime_data?finished=eq.false&select=id', 'GET', null, supabaseUrl, supabaseKey);
          totalUnfinished = countRes ? countRes.length : 0;
        } catch (err) {
          await setMemory('last_error', { step: 'count_unfinished', error: err.message }, supabaseUrl, supabaseKey);
          return new Response(`Error counting unfinished: ${err.message}`, { status: 500 });
        }

        if (totalUnfinished === 0) {
          await setMemory('automation_state', { phase: 'update', db_offset: 0 }, supabaseUrl, supabaseKey);
          return new Response('No unfinished animes. Reset offset to 0.', { status: 200 });
        }

        if (dbOffset * DB_BATCH_SIZE >= totalUnfinished) {
          dbOffset = 0;
        }

        let rows = [];
        try {
          rows = await supabaseQuery(
            `anime_data?finished=eq.false&select=mal_id,status,updated_at&order=mal_id.asc&limit=${DB_BATCH_SIZE}&offset=${dbOffset * DB_BATCH_SIZE}`,
            'GET', null, supabaseUrl, supabaseKey
          );
        } catch (err) {
          await setMemory('last_error', { step: 'fetch_db_batch', offset: dbOffset, error: err.message }, supabaseUrl, supabaseKey);
          return new Response(`Error fetching DB batch: ${err.message}`, { status: 500 });
        }

        for (const record of rows) {
          if (Date.now() - startTime > MAX_EXEC_TIME_MS - 5000) {
            await setMemory('automation_state', { phase: 'update', db_offset: dbOffset }, supabaseUrl, supabaseKey);
            return new Response(`Paused at offset ${dbOffset}, mal_id ${record.mal_id} (time limit)`, { status: 200 });
          }

          const malId = record.mal_id;
          const isAiring = airingIds.has(malId);
          const isUpcoming = upcomingIds.has(malId);

          if (isAiring) {
            const lastUpdate = record.updated_at ? new Date(record.updated_at) : new Date(0);
            const ageMs = Date.now() - lastUpdate.getTime();
            if (ageMs > refreshIntervalMs) {
              try {
                await processAnime(malId, workerUrl, supabaseUrl, supabaseKey, kuromojiWorkerUrl, startTime);
                await sleep(WORKER_RETRY_DELAY);
                updatedCount++;
              } catch (err) {
                if (err.message === 'TIME_LIMIT_NEAR') {
                  await setMemory('automation_state', { phase: 'update', db_offset: dbOffset }, supabaseUrl, supabaseKey);
                  return new Response(`Paused at offset ${dbOffset}, mal_id ${malId} (time limit)`, { status: 200 });
                }
                await setMemory('last_error', { step: 'refresh_airing', malId, error: err.message }, supabaseUrl, supabaseKey);
              }
            }
          } else if (!isUpcoming) {
            // Finished
            try {
              await processAnime(malId, workerUrl, supabaseUrl, supabaseKey, kuromojiWorkerUrl, startTime);
              await supabaseQuery(`anime_data?mal_id=eq.${malId}`, 'PATCH', { finished: true }, supabaseUrl, supabaseKey);
              await sleep(WORKER_RETRY_DELAY);
              updatedCount++;
            } catch (err) {
              if (err.message === 'TIME_LIMIT_NEAR') {
                await setMemory('automation_state', { phase: 'update', db_offset: dbOffset }, supabaseUrl, supabaseKey);
                return new Response(`Paused at offset ${dbOffset}, mal_id ${malId} (time limit)`, { status: 200 });
              }
              await setMemory('last_error', { step: 'final_update', malId, error: err.message }, supabaseUrl, supabaseKey);
            }
          }
        }

        const nextOffset = dbOffset + 1;
        await setMemory('automation_state', {
          phase: 'update',
          db_offset: nextOffset
        }, supabaseUrl, supabaseKey);

        return new Response(`Update done. Processed ${updatedCount} animes. Next offset: ${nextOffset}`, { status: 200 });
      }
    } catch (err) {
      console.error('Fatal error:', err.message, err.stack);
      try { await setMemory('last_error', { error: err.message, stack: err.stack }, supabaseUrl, supabaseKey); } catch (_) {}
      return new Response(`Fatal: ${err.message}`, { status: 500 });
    }
  }
};