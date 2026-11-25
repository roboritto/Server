import {
    TOKEN_STORAGE_KEY,
    TMDB_CACHE_KEY,
    CHUNK_SIZE,
    CHUNK_DELAY_MS,
    CUSTOM_MOVIE_ID_MIN
} from './config.js';
import { state } from './state.js';
import { dom } from './dom.js';
import { sleep } from './utils.js';
import { updateMobileNavVisibility } from './navigation.js';
import { renderHomeRandomMovies, renderHomeAllMovies } from './home.js';
import { renderRatedMoviesPage } from './rated.js';
import { openMoviePage, renderMovieCollections } from './movie.js';
import { openPersonPage } from './person.js';
import { playWelcomeCurtain } from './welcome.js';

export function isMovieInDatabase(movieId) {
    const idStr = String(movieId);
    return (
        state.rawCsvMovies.some((row) => String(row.movie_id) === idStr) ||
        state.moviesDatabase.some((m) => String(m.movie_id) === idStr)
    );
}

export function getCustomMovieMetadata(movieId) {
    const raw = state.customMoviesData[String(movieId)];
    if (!raw) return null;

    const releaseDate = raw.release_date || '';
    const releaseYear = raw.release_year || (releaseDate ? releaseDate.slice(0, 4) : '');

    const directors = (raw.directors || []).map((d) =>
        typeof d === 'string'
            ? { id: null, name: d, profile_path: '' }
            : {
                  id: d.id || null,
                  name: d.name || 'Unknown',
                  profile_path: d.profile_path || ''
              }
    );

    const cast = (raw.cast || []).map((a) =>
        typeof a === 'string'
            ? { id: null, name: a, character: '', profile_path: '' }
            : {
                  id: a.id || null,
                  name: a.name || 'Unknown',
                  character: a.character || '',
                  profile_path: a.profile_path || ''
              }
    );

    return {
        title: raw.title || `Movie #${movieId}`,
        original_title: raw.original_title || raw.title || '',
        release_date: releaseDate,
        release_year: releaseYear,
        runtime: raw.runtime || 0,
        genres: raw.genres || [],
        overview: raw.overview || '',
        poster_path: raw.poster_path || '',
        backdrop_path: raw.backdrop_path || '',
        tmdb_rating: raw.tmdb_rating || 0,
        directors,
        cast
    };
}

export async function fetchSingleTmdbMovie(movieId) {
    const idStr = String(movieId);

    // Bypass TMDB API and server cache for custom movie IDs (>= 8000000)
    if (Number(idStr) >= CUSTOM_MOVIE_ID_MIN) {
        return getCustomMovieMetadata(idStr);
    }

    if (state.tmdbCache[idStr]) {
        return state.tmdbCache[idStr];
    }

    const url = `https://api.themoviedb.org/3/movie/${idStr}?api_key=${state.tmdbApiKey}&append_to_response=credits`;
    const response = await fetch(url);

    if (!response.ok) {
        console.warn(`TMDB fetch failed for movie_id ${idStr}: ${response.status}`);
        return null;
    }

    const tmdbData = await response.json();

    const directors = (tmdbData.credits?.crew || [])
        .filter((member) => member.job === 'Director')
        .map((d) => ({
            id: d.id,
            name: d.name,
            profile_path: d.profile_path
                ? `https://image.tmdb.org/t/p/w185${d.profile_path}`
                : ''
        }));

    const topCast = (tmdbData.credits?.cast || [])
        .slice(0, 20)
        .map((actor) => ({
            id: actor.id,
            name: actor.name,
            character: actor.character || '',
            profile_path: actor.profile_path
                ? `https://image.tmdb.org/t/p/w185${actor.profile_path}`
                : ''
        }));

    const simplifiedTmdb = {
        title: tmdbData.title || 'Unknown Title',
        original_title: tmdbData.original_title || '',
        release_date: tmdbData.release_date || '',
        release_year: tmdbData.release_date ? tmdbData.release_date.slice(0, 4) : '',
        runtime: tmdbData.runtime || 0,
        genres: (tmdbData.genres || []).map((g) => g.name),
        overview: tmdbData.overview || '',
        poster_path: tmdbData.poster_path
            ? `https://image.tmdb.org/t/p/w500${tmdbData.poster_path}`
            : '',
        backdrop_path: tmdbData.backdrop_path
            ? `https://image.tmdb.org/t/p/w1280${tmdbData.backdrop_path}`
            : '',
        tmdb_rating: tmdbData.vote_average || 0,
        directors,
        cast: topCast
    };

    state.tmdbCache[idStr] = simplifiedTmdb;
    return simplifiedTmdb;
}

export function rebuildPeopleIndex() {
    const peopleMap = new Map();

    state.moviesDatabase.forEach((movie) => {
        (movie.directors || []).forEach((dir) => {
            const key = dir.id || dir.name;
            if (!peopleMap.has(key)) {
                peopleMap.set(key, {
                    id: dir.id,
                    name: dir.name,
                    profile_path: dir.profile_path || '',
                    isDirector: true,
                    isActor: false
                });
            } else {
                const existing = peopleMap.get(key);
                existing.isDirector = true;
                if (!existing.profile_path && dir.profile_path) {
                    existing.profile_path = dir.profile_path;
                }
            }
        });

        (movie.cast || []).forEach((actor) => {
            const key = actor.id || actor.name;
            if (!peopleMap.has(key)) {
                peopleMap.set(key, {
                    id: actor.id,
                    name: actor.name,
                    profile_path: actor.profile_path || '',
                    isDirector: false,
                    isActor: true
                });
            } else {
                const existing = peopleMap.get(key);
                existing.isActor = true;
                if (!existing.profile_path && actor.profile_path) {
                    existing.profile_path = actor.profile_path;
                }
            }
        });
    });

    state.peopleDatabase = Array.from(peopleMap.values()).map((person) => {
        let role = 'Actor';
        if (person.isDirector && person.isActor) {
            role = 'Actor / Director';
        } else if (person.isDirector) {
            role = 'Director';
        }
        return {
            id: person.id,
            name: person.name,
            profile_path: person.profile_path,
            role
        };
    });
}

export function updateTopLoadingBar(loadedCount, totalCount) {
    if (totalCount > 0) {
        const halfLoadedThreshold = Math.ceil(totalCount / 2);
        if (!state.hasInitializedHomeRandom && loadedCount >= halfLoadedThreshold) {
            state.hasInitializedHomeRandom = true;
            renderHomeRandomMovies();
        }
    }

    if (!dom.topLoadingBarContainer || !dom.topLoadingBar) return;

    if (totalCount <= 0) {
        dom.topLoadingBarContainer.classList.add('hidden');
        return;
    }

    const percentage = Math.min(100, Math.round((loadedCount / totalCount) * 100));
    dom.topLoadingBar.style.width = `${percentage}%`;
}

export async function saveTmdbCacheEntries(entries) {
    if (state.isDemoMode || !state.serverApiToken || !entries) return false;
    if (Object.keys(entries).length === 0) return true;

    try {
        const response = await fetch('/api/tmdb-cache', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-token': state.serverApiToken
            },
            body: JSON.stringify({ entries })
        });
        return response.ok;
    } catch (error) {
        console.warn('Could not persist TMDB cache to server:', error);
        return false;
    }
}

async function migrateLegacyLocalStorageCache() {
    const rawLegacy = localStorage.getItem(TMDB_CACHE_KEY);
    if (!rawLegacy) return;

    try {
        const legacyCache = JSON.parse(rawLegacy);
        if (!legacyCache || typeof legacyCache !== 'object') {
            localStorage.removeItem(TMDB_CACHE_KEY);
            return;
        }

        const missingOnServer = {};
        Object.entries(legacyCache).forEach(([movieId, metadata]) => {
            const idStr = String(movieId).trim();
            if (
                idStr &&
                Number(idStr) < CUSTOM_MOVIE_ID_MIN &&
                metadata &&
                typeof metadata === 'object' &&
                !state.tmdbCache[idStr]
            ) {
                state.tmdbCache[idStr] = metadata;
                missingOnServer[idStr] = metadata;
            }
        });

        const migrateCount = Object.keys(missingOnServer).length;
        if (migrateCount === 0) {
            localStorage.removeItem(TMDB_CACHE_KEY);
            return;
        }

        const saved = await saveTmdbCacheEntries(missingOnServer);
        if (saved) {
            localStorage.removeItem(TMDB_CACHE_KEY);
            console.log(`Migrated ${migrateCount} cached TMDB movies from localStorage to server.`);
        }
    } catch (error) {
        console.warn('Skipping legacy localStorage TMDB cache migration:', error);
    }
}

export async function startBackgroundDatabaseLoad() {
    if (state.isDatabaseLoading || state.isDatabaseLoaded || !state.serverApiToken) return;
    state.isDatabaseLoading = true;

    if (dom.topLoadingBarContainer && dom.topLoadingBar) {
        dom.topLoadingBar.style.width = '0%';
        dom.topLoadingBarContainer.classList.remove('hidden');
    }

    try {
        const authHeaders = { 'x-api-token': state.serverApiToken };
        const [moviesRes, customRes, cacheRes] = await Promise.all([
            fetch('/api/movies', { method: 'GET', headers: authHeaders }),
            fetch('/api/custom-movies', { method: 'GET', headers: authHeaders }),
            fetch('/api/tmdb-cache', { method: 'GET', headers: authHeaders })
        ]);

        if (!moviesRes.ok) {
            throw new Error('Failed to fetch movies from CSV');
        }

        state.rawCsvMovies = await moviesRes.json();
        state.customMoviesData = customRes.ok ? await customRes.json() : {};
        state.tmdbCache = cacheRes.ok ? await cacheRes.json() : {};
        state.moviesDatabase = [];

        // One-time migration from browser localStorage -> server tmdb_cache.json
        await migrateLegacyLocalStorageCache();

        const totalMovies = state.rawCsvMovies.length;
        if (totalMovies === 0) {
            dom.topLoadingBarContainer?.classList.add('hidden');
            state.isDatabaseLoaded = true;
            return;
        }

        const loadQueue = [...state.rawCsvMovies];
        if (state.pendingInitialMovieId) {
            const targetIdx = loadQueue.findIndex(
                (row) => String(row.movie_id) === String(state.pendingInitialMovieId)
            );
            if (targetIdx > 0) {
                const [priorityRow] = loadQueue.splice(targetIdx, 1);
                loadQueue.unshift(priorityRow);
            } else if (targetIdx === -1) {
                state.pendingInitialMovieId = null;
                window.history.replaceState(null, '', '/');
            }
        }

        const syncVisibleViews = () => {
            rebuildPeopleIndex();

            if (state.currentPage === 'person-page' && state.currentPersonId) {
                openPersonPage(state.currentPersonId, false);
            }
            if (state.currentPage === 'rated-page') {
                renderRatedMoviesPage();
            }

            updateTopLoadingBar(state.moviesDatabase.length, totalMovies);
            renderHomeAllMovies();

            if (state.currentPage === 'movie-page' && state.currentMovieId) {
                const activeMovie = state.moviesDatabase.find(
                    (m) => m.movie_id === String(state.currentMovieId)
                );
                if (activeMovie) renderMovieCollections(activeMovie);
            }
        };

        for (let i = 0; i < totalMovies; i += CHUNK_SIZE) {
            const chunk = loadQueue.slice(i, i + CHUNK_SIZE);
            const missingIdsInChunk = new Set(
                chunk
                    .filter(
                        (row) =>
                            Number(row.movie_id) < CUSTOM_MOVIE_ID_MIN &&
                            !state.tmdbCache[String(row.movie_id)]
                    )
                    .map((row) => String(row.movie_id))
            );
            const needsNetworkCall = missingIdsInChunk.size > 0;

            const chunkResults = await Promise.all(
                chunk.map(async (csvRow) => {
                    const tmdbInfo = await fetchSingleTmdbMovie(csvRow.movie_id);
                    return {
                        movie_id: String(csvRow.movie_id),
                        link: csvRow.link || '',
                        collection: csvRow.collection || '',
                        rating: csvRow.rating !== '' ? parseFloat(csvRow.rating) : 0,
                        last_watch: csvRow.last_watch || '',
                        review: csvRow.review || '',
                        is_new: Boolean(csvRow.is_new),
                        is_hidden: Boolean(csvRow.is_hidden),
                        ...(tmdbInfo || {
                            title: `Movie #${csvRow.movie_id}`,
                            release_date: '',
                            release_year: '',
                            genres: [],
                            directors: [],
                            cast: [],
                            overview: '',
                            poster_path: '',
                            backdrop_path: ''
                        })
                    };
                })
            );

            state.moviesDatabase.push(...chunkResults);

            if (state.pendingInitialMovieId) {
                const initialMovie = state.moviesDatabase.find(
                    (m) => String(m.movie_id) === String(state.pendingInitialMovieId)
                );
                if (initialMovie) {
                    const targetId = state.pendingInitialMovieId;
                    state.pendingInitialMovieId = null;
                    openMoviePage(targetId, false);
                }
            }

            if (needsNetworkCall) {
                const newlyFetched = {};
                missingIdsInChunk.forEach((idStr) => {
                    if (state.tmdbCache[idStr]) {
                        newlyFetched[idStr] = state.tmdbCache[idStr];
                    }
                });
                if (Object.keys(newlyFetched).length > 0) {
                    await saveTmdbCacheEntries(newlyFetched);
                }

                syncVisibleViews();

                if (i + CHUNK_SIZE < totalMovies) {
                    await sleep(CHUNK_DELAY_MS);
                }
            }
        }

        // Single final render pass (handles all cached chunks in one shot)
        syncVisibleViews();

        state.isDatabaseLoaded = true;
        console.log(
            `Database load complete: ${state.moviesDatabase.length} movies, ${state.peopleDatabase.length} people ready.`
        );

        await sleep(300);
        dom.topLoadingBarContainer?.classList.add('hidden');
    } catch (error) {
        console.error('Database load error:', error);
        dom.topLoadingBarContainer?.classList.add('hidden');
    } finally {
        state.isDatabaseLoading = false;
    }
}

export function applyPermissionsToUi() {
    const perms = state.permissions;
    dom.hideMovieBtn?.classList.toggle('hidden', !state.isAdmin);
    dom.navAddBtn?.classList.toggle('hidden', !perms.add_movie);
    dom.deleteMovieBtn?.classList.toggle('hidden', !perms.delete);
    dom.openAddLinkModalBtn?.classList.toggle('hidden', !perms.add_link);
    dom.openRatingModalBtn?.classList.toggle('hidden', !perms.edit_rating);
    dom.openCollectionModalBtn?.classList.toggle('hidden', !perms.edit_collection);
}

export async function verifyAndLoadConfig(token, showWelcome = false) {
    dom.authError?.classList.add('hidden');
    if (dom.authSubmitBtn) {
        dom.authSubmitBtn.disabled = true;
        dom.authSubmitBtn.textContent = 'Verifying...';
    }

    try {
        const response = await fetch('/api/config', {
            method: 'GET',
            headers: { 'x-api-token': token }
        });

        if (!response.ok) {
            throw new Error('Unauthorized');
        }

        const data = await response.json();
        state.tmdbApiKey = data.tmdb_api_key;
        state.isAdmin = Boolean(data.is_admin);
        state.permissions = {
            ...state.permissions,
            ...(data.permissions || {})
        };
        state.serverApiToken = token;

        localStorage.setItem(TOKEN_STORAGE_KEY, token);

        applyPermissionsToUi();
        const loadPromise = startBackgroundDatabaseLoad();
        if (showWelcome) {
            playWelcomeCurtain(loadPromise);
        }
        dom.authScreen?.classList.add('hidden');
        dom.appContainer?.classList.remove('hidden');
        updateMobileNavVisibility();
    } catch (error) {
        localStorage.removeItem(TOKEN_STORAGE_KEY);
        state.serverApiToken = '';
        dom.authScreen?.classList.remove('hidden');
        dom.appContainer?.classList.add('hidden');
        dom.authError?.classList.remove('hidden');
    } finally {
        if (dom.authSubmitBtn) {
            dom.authSubmitBtn.disabled = false;
            dom.authSubmitBtn.textContent = 'Unlock Database';
        }
    }
}

function isDemoEnvironment() {
    const params = new URLSearchParams(window.location.search);
    return (
        Boolean(window.__CINEMA_DEMO_MODE__) ||
        window.location.hostname.endsWith('.github.io') ||
        params.get('demo') === '1'
    );
}

async function loadDemoDatabase() {
    const demoLoadPromise = (async () => {
        try {
            const response = await fetch('./demo_movies.json');
            if (!response.ok) {
                throw new Error('Could not load demo_movies.json');
            }

            const demoMovies = await response.json();
            state.moviesDatabase = demoMovies.map((m) => ({
                ...m,
                movie_id: String(m.movie_id),
                rating: parseFloat(m.rating) || 0,
                is_new: Boolean(m.is_new)
            }));
            state.rawCsvMovies = state.moviesDatabase.map((m) => ({
                movie_id: m.movie_id,
                link: m.link || '',
                collection: m.collection || '',
                rating: m.rating || '',
                last_watch: m.last_watch || '',
                review: m.review || '',
                is_new: m.is_new
            }));

            rebuildPeopleIndex();
            state.hasInitializedHomeRandom = true;
            state.isDatabaseLoaded = true;

            renderHomeRandomMovies();
            renderHomeAllMovies();
            renderRatedMoviesPage();

            if (state.pendingInitialMovieId) {
                const exists = state.moviesDatabase.some(
                    (m) => String(m.movie_id) === String(state.pendingInitialMovieId)
                );
                const targetId = state.pendingInitialMovieId;
                state.pendingInitialMovieId = null;
                if (exists) {
                    openMoviePage(targetId, false);
                }
            }
        } catch (error) {
            console.error('Demo load error:', error);
        }
    })();

    playWelcomeCurtain(demoLoadPromise);
    dom.authScreen?.classList.add('hidden');
    dom.appContainer?.classList.remove('hidden');
    updateMobileNavVisibility();

    await demoLoadPromise;
}

export function initAuth() {
    if (isDemoEnvironment()) {
        state.isDemoMode = true;
        loadDemoDatabase();
        return;
    }

    if (state.serverApiToken) {
        verifyAndLoadConfig(state.serverApiToken);
    }
}