import { MAX_SEARCH_RESULTS, CUSTOM_MOVIE_ID_MIN } from './config.js';
import { state } from './state.js';
import { dom } from './dom.js';
import {
    getHeartSvgMarkup,
    getKualaLumpurTimestamp,
    parseCollectionArray,
    parseLinkArray
} from './utils.js';
import {
    isMovieInDatabase,
    getCustomMovieMetadata,
    fetchSingleTmdbMovie,
    rebuildPeopleIndex,
    saveTmdbCacheEntries
} from './api.js';
import { openModal, closeModal, goBackPage } from './navigation.js';
import { getFuzzyScore } from './search.js';
import { renderHomeAllMovies, renderHomeRandomMovies } from './home.js';
import { renderRatedMoviesPage } from './rated.js';
import { openMoviePage, renderMovieCollections } from './movie.js';

// =========================================================================
// 1. Add Movie from TMDB Modal
// =========================================================================
export async function performTmdbSearch(query) {
    if (state.isDemoMode) {
        if (dom.tmdbSearchResults) {
            dom.tmdbSearchResults.innerHTML = `<div class="search-empty-msg">Live TMDB search is disabled in Demo Mode. Self-host with your own TMDB API key to add movies.</div>`;
        }
        return;
    }
    const cleanQuery = query.trim();
    state.latestTmdbSearchQuery = cleanQuery;

    if (!cleanQuery || !dom.tmdbSearchResults) {
        if (dom.tmdbSearchResults) dom.tmdbSearchResults.innerHTML = '';
        return;
    }

    // Intercept custom movie IDs (>= 8000000) instead of querying TMDB
    if (/^\d+$/.test(cleanQuery) && Number(cleanQuery) >= CUSTOM_MOVIE_ID_MIN) {
        renderCustomMovieLookup(cleanQuery);
        return;
    }

    dom.tmdbSearchResults.innerHTML = `<div class="search-empty-msg">Searching TMDB...</div>`;

    try {
        const url = `https://api.themoviedb.org/3/search/movie?api_key=${state.tmdbApiKey}&query=${encodeURIComponent(cleanQuery)}&include_adult=false`;
        const response = await fetch(url);
        if (!response.ok) throw new Error('TMDB search failed');

        const data = await response.json();
        if (state.latestTmdbSearchQuery !== cleanQuery) return;

        const results = (data.results || []).slice(0, MAX_SEARCH_RESULTS);
        renderTmdbSearchResults(results);
    } catch (error) {
        console.error('TMDB search error:', error);
        if (state.latestTmdbSearchQuery === cleanQuery) {
            dom.tmdbSearchResults.innerHTML = `<div class="search-empty-msg">Failed to search TMDB. Please check your connection.</div>`;
        }
    }
}

function renderTmdbSearchResults(results) {
    if (!dom.tmdbSearchResults) return;
    dom.tmdbSearchResults.innerHTML = '';

    if (results.length === 0) {
        dom.tmdbSearchResults.innerHTML = `<div class="search-empty-msg">No movies found on TMDB.</div>`;
        return;
    }

    results.forEach((tmdbMovie) => {
        const movieId = String(tmdbMovie.id);
        const alreadyExists = isMovieInDatabase(movieId);
        const releaseYear = tmdbMovie.release_date ? tmdbMovie.release_date.slice(0, 4) : 'Unknown Year';
        const posterUrl = tmdbMovie.poster_path
            ? `https://image.tmdb.org/t/p/w185${tmdbMovie.poster_path}`
            : '';

        const row = document.createElement('div');
        row.className = 'search-result-item';
        if (alreadyExists) row.style.cursor = 'default';

        const posterHtml = posterUrl
            ? `<img src="${posterUrl}" alt="${tmdbMovie.title}" class="search-result-poster">`
            : `<div class="search-result-poster search-result-placeholder">No Poster</div>`;

        row.innerHTML = `
            ${posterHtml}
            <div class="search-result-info">
                <div class="search-result-title">${tmdbMovie.title || 'Unknown Title'}</div>
                <div class="search-result-sub">${releaseYear}</div>
            </div>
            <button type="button" class="tmdb-add-action-btn" ${alreadyExists ? 'disabled' : ''}>
                ${alreadyExists ? 'Added' : 'Add'}
            </button>
        `;

        if (!alreadyExists) {
            const addBtn = row.querySelector('.tmdb-add-action-btn');
            row.addEventListener('click', (event) => {
                event.stopPropagation();
                handleAddMovieFromTmdb(movieId, addBtn);
            });
        }

        dom.tmdbSearchResults.appendChild(row);
    });
}

async function handleAddMovieFromTmdb(movieId, buttonEl) {
    const idStr = String(movieId);
    if (isMovieInDatabase(idStr)) return;

    if (buttonEl) {
        buttonEl.disabled = true;
        buttonEl.textContent = 'Adding...';
    }

    try {
        const response = await fetch('/api/movies', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-token': state.serverApiToken
            },
            body: JSON.stringify({
                movie_id: idStr,
                link: '',
                rating: 0.0,
                last_watch: '',
                review: '',
                collection: ''
            })
        });

        if (!response.ok) {
            throw new Error('Failed to add movie to CSV');
        }

        const tmdbInfo = await fetchSingleTmdbMovie(idStr);
        if (tmdbInfo) {
            await saveTmdbCacheEntries({ [idStr]: tmdbInfo });
        }

        state.rawCsvMovies.push({
            movie_id: idStr,
            link: '',
            collection: '',
            rating: '',
            last_watch: '',
            review: '',
            is_new: true
        });

        state.moviesDatabase.push({
            ...(tmdbInfo || {
                title: `Movie #${idStr}`,
                release_date: '',
                release_year: '',
                genres: [],
                directors: [],
                cast: [],
                overview: '',
                poster_path: '',
                backdrop_path: ''
            }),
            movie_id: idStr,
            link: '',
            collection: '',
            rating: 0,
            last_watch: '',
            review: '',
            is_new: true
        });

        rebuildPeopleIndex();
        renderHomeAllMovies();

        if (dom.tmdbSearchInput) {
            dom.tmdbSearchInput.value = '';
            dom.tmdbSearchInput.blur();
        }
        if (dom.tmdbSearchResults) {
            dom.tmdbSearchResults.innerHTML = '';
        }
        closeModal(dom.tmdbAddModal);
        openMoviePage(idStr);
    } catch (error) {
        console.error('Error adding movie from TMDB:', error);
        alert('Could not add movie. Please try again.');
        if (buttonEl) {
            buttonEl.disabled = false;
            buttonEl.textContent = 'Add';
        }
    }
}

function renderCustomMovieLookup(movieId) {
    if (!dom.tmdbSearchResults) return;
    dom.tmdbSearchResults.innerHTML = '';

    const idStr = String(movieId);
    const alreadyInDb = isMovieInDatabase(idStr);
    const existingMeta = getCustomMovieMetadata(idStr);

    // Case 1 & 2: Already in database OR already defined in custom_movies.json
    if (alreadyInDb || existingMeta) {
        const dbMovie = state.moviesDatabase.find((m) => String(m.movie_id) === idStr);
        const title = dbMovie?.title || existingMeta?.title || `Movie #${idStr}`;
        const releaseYear = dbMovie?.release_year || existingMeta?.release_year || `Custom #${idStr}`;
        const posterUrl = dbMovie?.poster_path || existingMeta?.poster_path || '';

        const row = document.createElement('div');
        row.className = 'search-result-item';
        if (alreadyInDb) row.style.cursor = 'default';

        const posterHtml = posterUrl
            ? `<img src="${posterUrl}" alt="${title}" class="search-result-poster">`
            : `<div class="search-result-poster search-result-placeholder">Custom</div>`;

        row.innerHTML = `
            ${posterHtml}
            <div class="search-result-info">
                <div class="search-result-title">${title}</div>
                <div class="search-result-sub">${releaseYear} • ID ${idStr}</div>
            </div>
            <button type="button" class="tmdb-add-action-btn" ${alreadyInDb ? 'disabled' : ''}>
                ${alreadyInDb ? 'Added' : 'Add'}
            </button>
        `;

        if (!alreadyInDb) {
            const addBtn = row.querySelector('.tmdb-add-action-btn');
            row.addEventListener('click', (event) => {
                event.stopPropagation();
                handleAddExistingCustomMovie(idStr, addBtn);
            });
        }

        dom.tmdbSearchResults.appendChild(row);
        return;
    }

    // Case 3: New custom movie ID -> render inline creation form
    const form = document.createElement('form');
    form.className = 'custom-movie-form';
    form.innerHTML = `
        <div class="custom-movie-form-header">New Custom Movie #${idStr}</div>

        <input type="text" name="title" class="custom-movie-input" placeholder="Title *" required autocomplete="off">

        <div class="custom-movie-row">
            <input type="text" name="release_date" class="custom-movie-input" placeholder="Release Date (YYYY-MM-DD or YYYY)" autocomplete="off">
            <input type="text" name="genres" class="custom-movie-input" placeholder="Genres (Action, Drama)" autocomplete="off">
        </div>

        <input type="text" name="directors" class="custom-movie-input" placeholder="Director(s) (comma-separated)" autocomplete="off">
        <input type="text" name="cast" class="custom-movie-input" placeholder="Cast (Actor or Actor (Character), comma-separated)" autocomplete="off">

        <div class="custom-movie-row">
            <input type="text" name="poster_path" class="custom-movie-input" placeholder="Poster URL or /custom_images/..." autocomplete="off">
            <input type="text" name="backdrop_path" class="custom-movie-input" placeholder="Backdrop URL or /custom_images/..." autocomplete="off">
        </div>

        <input type="text" name="link" class="custom-movie-input" placeholder="Download Link (optional)" autocomplete="off">
        <textarea name="overview" class="custom-movie-textarea" rows="3" placeholder="Synopsis / overview (optional)"></textarea>

        <button type="submit" class="custom-movie-submit-btn">Add Custom Movie</button>
    `;

    form.addEventListener('submit', (event) => {
        handleCreateCustomMovie(event, idStr, form);
    });

    dom.tmdbSearchResults.appendChild(form);
}

async function handleAddExistingCustomMovie(movieId, buttonEl) {
    const idStr = String(movieId);
    if (isMovieInDatabase(idStr)) return;

    if (buttonEl) {
        buttonEl.disabled = true;
        buttonEl.textContent = 'Adding...';
    }

    try {
        const response = await fetch('/api/movies', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-token': state.serverApiToken
            },
            body: JSON.stringify({
                movie_id: idStr,
                link: '',
                rating: 0.0,
                last_watch: '',
                review: '',
                collection: ''
            })
        });

        if (!response.ok) {
            throw new Error('Failed to add custom movie to CSV');
        }

        const customInfo = getCustomMovieMetadata(idStr);
        finalizeAddedCustomMovie(idStr, '', customInfo);
    } catch (error) {
        console.error('Error adding existing custom movie:', error);
        alert('Could not add custom movie. Please try again.');
        if (buttonEl) {
            buttonEl.disabled = false;
            buttonEl.textContent = 'Add';
        }
    }
}

async function handleCreateCustomMovie(event, movieId, formEl) {
    event.preventDefault();
    const idStr = String(movieId);
    if (isMovieInDatabase(idStr)) return;

    const formData = new FormData(formEl);
    const title = String(formData.get('title') || '').trim();
    if (!title) return;

    const releaseDate = String(formData.get('release_date') || '').trim();
    const releaseYear = releaseDate ? releaseDate.slice(0, 4) : '';
    const genres = String(formData.get('genres') || '')
        .split(',')
        .map((g) => g.trim())
        .filter(Boolean);

    const directors = String(formData.get('directors') || '')
        .split(',')
        .map((d) => d.trim())
        .filter(Boolean)
        .map((name) => ({ id: null, name, profile_path: '' }));

    const cast = String(formData.get('cast') || '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => {
            const match = entry.match(/^(.+?)\s*\((.+)\)$/);
            if (match) {
                return {
                    id: null,
                    name: match[1].trim(),
                    character: match[2].trim(),
                    profile_path: ''
                };
            }
            return { id: null, name: entry, character: '', profile_path: '' };
        });

    const posterPath = String(formData.get('poster_path') || '').trim();
    const backdropPath = String(formData.get('backdrop_path') || '').trim();
    const overview = String(formData.get('overview') || '').trim();
    const link = String(formData.get('link') || '').trim();

    const metadata = {
        title,
        original_title: title,
        release_date: releaseDate,
        release_year: releaseYear,
        runtime: 0,
        genres,
        overview,
        poster_path: posterPath,
        backdrop_path: backdropPath,
        tmdb_rating: 0,
        directors,
        cast
    };

    const submitBtn = formEl.querySelector('.custom-movie-submit-btn');
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Saving...';
    }

    try {
        // 1. Save metadata to custom_movies.json
        const metaRes = await fetch('/api/custom-movies', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-token': state.serverApiToken
            },
            body: JSON.stringify({
                movie_id: idStr,
                ...metadata
            })
        });

        if (!metaRes.ok) {
            throw new Error('Failed to save custom movie metadata');
        }

        // 2. Append movie row to CSV
        const csvRes = await fetch('/api/movies', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-token': state.serverApiToken
            },
            body: JSON.stringify({
                movie_id: idStr,
                link,
                rating: 0.0,
                last_watch: '',
                review: '',
                collection: ''
            })
        });

        if (!csvRes.ok) {
            throw new Error('Failed to add custom movie to CSV');
        }

        state.customMoviesData[idStr] = metadata;
        finalizeAddedCustomMovie(idStr, link, getCustomMovieMetadata(idStr));
    } catch (error) {
        console.error('Error creating custom movie:', error);
        alert('Could not create custom movie. Please try again.');
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Add Custom Movie';
        }
    }
}

function finalizeAddedCustomMovie(idStr, link, customInfo) {
    state.rawCsvMovies.push({
        movie_id: idStr,
        link,
        collection: '',
        rating: '',
        last_watch: '',
        review: '',
        is_new: true
    });

    state.moviesDatabase.push({
        ...(customInfo || {
            title: `Movie #${idStr}`,
            release_date: '',
            release_year: '',
            genres: [],
            directors: [],
            cast: [],
            overview: '',
            poster_path: '',
            backdrop_path: ''
        }),
        movie_id: idStr,
        link,
        collection: '',
        rating: 0,
        last_watch: '',
        review: '',
        is_new: true
    });

    rebuildPeopleIndex();
    renderHomeAllMovies();

    if (dom.tmdbSearchInput) {
        dom.tmdbSearchInput.value = '';
        dom.tmdbSearchInput.blur();
    }
    if (dom.tmdbSearchResults) {
        dom.tmdbSearchResults.innerHTML = '';
    }
    closeModal(dom.tmdbAddModal);
    openMoviePage(idStr);
}

// =========================================================================
// 2. Rating & Review Modal
// =========================================================================
export function updateModalHeartsUI(ratingVal) {
    state.selectedModalRating = Math.max(0, Math.min(5, parseFloat(ratingVal) || 0));

    dom.interactiveHearts.forEach((heartEl, idx) => {
        const heartNumber = idx + 1;
        let fillState = 'empty';
        if (state.selectedModalRating >= heartNumber) {
            fillState = 'full';
        } else if (state.selectedModalRating >= heartNumber - 0.5) {
            fillState = 'half';
        }
        heartEl.innerHTML = getHeartSvgMarkup(fillState, `modal-${heartNumber}`);
    });

    if (dom.ratingValueDisplay) {
        dom.ratingValueDisplay.textContent = `${state.selectedModalRating.toFixed(1)} / 5.0`;
    }
}

export function openRatingModalForCurrentMovie() {
    const movie = state.moviesDatabase.find((m) => String(m.movie_id) === String(state.currentMovieId));
    if (!movie) return;

    updateModalHeartsUI(parseFloat(movie.rating) || 0.0);

    if (dom.reviewTextarea) {
        dom.reviewTextarea.value = movie.review || '';
    }

    openModal(dom.ratingModal);
}

export async function saveMovieRatingAndReview(event) {
    event.preventDefault();
    if (!state.currentMovieId) return;

    const movie = state.moviesDatabase.find((m) => String(m.movie_id) === String(state.currentMovieId));
    if (!movie) return;

    const floatRating = parseFloat(state.selectedModalRating.toFixed(1));
    const reviewText = dom.reviewTextarea ? dom.reviewTextarea.value.trim() : '';
    const klTimestamp = getKualaLumpurTimestamp();

    if (dom.saveRatingBtn) {
        dom.saveRatingBtn.disabled = true;
        dom.saveRatingBtn.textContent = 'Saving...';
    }

    try {
        if (!state.isDemoMode) {
            const response = await fetch(`/api/movies/${state.currentMovieId}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-token': state.serverApiToken
                },
                body: JSON.stringify({
                    rating: floatRating,
                    last_watch: klTimestamp,
                    review: reviewText
                })
            });

            if (!response.ok) {
                throw new Error('Failed to save rating and review to CSV');
            }
        }

        movie.rating = floatRating;
        movie.last_watch = klTimestamp;
        movie.review = reviewText;

        openMoviePage(state.currentMovieId, false);
        renderHomeAllMovies();
        renderRatedMoviesPage();
        closeModal(dom.ratingModal);
    } catch (error) {
        console.error('Error updating rating/review:', error);
        alert('Could not save rating/review. Please check your connection.');
    } finally {
        if (dom.saveRatingBtn) {
            dom.saveRatingBtn.disabled = false;
            dom.saveRatingBtn.textContent = 'Save Review';
        }
    }
}

// =========================================================================
// 3. Add to Collection Modal
// =========================================================================
function getAllUniqueCollections() {
    const colMap = new Map();
    state.moviesDatabase.forEach((movie) => {
        parseCollectionArray(movie.collection).forEach((colName) => {
            const lower = colName.toLowerCase();
            if (!colMap.has(lower)) {
                colMap.set(lower, colName);
            }
        });
    });

    return Array.from(colMap.values()).sort((a, b) => a.localeCompare(b));
}

async function updateMovieCollectionsInCsv(movie, updatedCollectionsArray) {
    const newCollectionString = updatedCollectionsArray.join(', ');

    try {
        if (!state.isDemoMode) {
            const response = await fetch(`/api/movies/${movie.movie_id}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-token': state.serverApiToken
                },
                body: JSON.stringify({
                    collection: newCollectionString
                })
            });

            if (!response.ok) {
                throw new Error('Failed to update collections in CSV');
            }
        }

        movie.collection = newCollectionString;
        renderMovieCollections(movie);
    } catch (error) {
        console.error('Error saving collection update:', error);
        alert('Could not update collection. Please check your connection.');
    }
}

export function renderCollectionModalList(filterQuery = '') {
    if (!dom.collectionListContainer || !state.currentMovieId) return;

    const movie = state.moviesDatabase.find((m) => String(m.movie_id) === String(state.currentMovieId));
    if (!movie) return;

    const currentMovieColsLower = parseCollectionArray(movie.collection).map((c) => c.toLowerCase());
    const allCollections = getAllUniqueCollections();
    const cleanQuery = filterQuery.trim();

    const filteredCollections = cleanQuery
        ? allCollections.filter((colName) => getFuzzyScore(cleanQuery, colName) > 0)
        : allCollections;

    dom.collectionListContainer.innerHTML = '';

    if (filteredCollections.length === 0) {
        const emptyMsg = cleanQuery
            ? `No existing collection matches "${cleanQuery}". Tap "Add" to create it!`
            : 'No collections exist yet. Type a name above and tap "Add"!';
        dom.collectionListContainer.innerHTML = `<div class="search-empty-msg">${emptyMsg}</div>`;
        return;
    }

    filteredCollections.forEach((colName) => {
        const isSelected = currentMovieColsLower.includes(colName.toLowerCase());

        const itemEl = document.createElement('div');
        itemEl.className = `collection-option-item${isSelected ? ' selected' : ''}`;

        itemEl.innerHTML = `
            <div class="collection-checkmark-box">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="20 6 9 17 4 12"></polyline>
                </svg>
            </div>
            <span class="collection-option-name">${colName}</span>
        `;

        itemEl.addEventListener('click', async () => {
            const latestCols = parseCollectionArray(movie.collection);
            const existsIdx = latestCols.findIndex((c) => c.toLowerCase() === colName.toLowerCase());

            if (existsIdx > -1) {
                latestCols.splice(existsIdx, 1);
            } else {
                latestCols.push(colName);
            }

            await updateMovieCollectionsInCsv(movie, latestCols);
            renderCollectionModalList(dom.collectionSearchInput ? dom.collectionSearchInput.value : '');
        });

        dom.collectionListContainer.appendChild(itemEl);
    });
}

export function openCollectionModalForCurrentMovie() {
    if (!state.currentMovieId) return;
    if (dom.collectionSearchInput) {
        dom.collectionSearchInput.value = '';
    }
    renderCollectionModalList('');
    openModal(dom.collectionModal);
    dom.collectionSearchInput?.focus();
}

export async function handleAddNewCollection(event) {
    event.preventDefault();
    if (!state.currentMovieId || !dom.collectionSearchInput) return;

    const cleanNewName = dom.collectionSearchInput.value.trim().replace(/,/g, '').trim();
    if (!cleanNewName) return;

    const movie = state.moviesDatabase.find((m) => String(m.movie_id) === String(state.currentMovieId));
    if (!movie) return;

    const allCollections = getAllUniqueCollections();
    const existingMatch = allCollections.find((c) => c.toLowerCase() === cleanNewName.toLowerCase());
    const finalCollectionName = existingMatch || cleanNewName;

    const currentMovieCols = parseCollectionArray(movie.collection);
    const alreadyInMovie = currentMovieCols.some(
        (c) => c.toLowerCase() === finalCollectionName.toLowerCase()
    );

    if (!alreadyInMovie) {
        currentMovieCols.push(finalCollectionName);
        if (dom.addNewCollectionBtn) dom.addNewCollectionBtn.disabled = true;
        await updateMovieCollectionsInCsv(movie, currentMovieCols);
        if (dom.addNewCollectionBtn) dom.addNewCollectionBtn.disabled = false;
    }

    dom.collectionSearchInput.value = '';
    renderCollectionModalList('');
}

// =========================================================================
// 4. Add Download Link Modal
// =========================================================================
export function openAddLinkModalForCurrentMovie() {
    if (!state.currentMovieId || !dom.addLinkModal) return;
    if (dom.addLinkInput) {
        dom.addLinkInput.value = '';
    }
    openModal(dom.addLinkModal);
}

export async function handleAddMovieLink(event) {
    event.preventDefault();
    if (!state.currentMovieId || !dom.addLinkInput) return;

    let newLink = dom.addLinkInput.value.trim();
    if (!newLink) return;

    if (!/^https?:\/\//i.test(newLink)) {
        newLink = newLink
            .replace(/^["']|["']$/g, '')
            .replace(/\\/g, '/')
            .replace(/^(\.\/)+/, '')
            .replace(/^\/+/, '');
    }

    if (!newLink) return;

    if (newLink.includes(',')) {
        alert('Links and local file paths cannot contain commas.');
        return;
    }

    const movie = state.moviesDatabase.find((m) => String(m.movie_id) === String(state.currentMovieId));
    if (!movie) return;

    const existingLinks = parseLinkArray(movie.link);
    if (existingLinks.some((l) => l.toLowerCase() === newLink.toLowerCase())) {
        alert('This link or file path is already saved for this movie.');
        return;
    }

    const updatedLinkString = existingLinks.length > 0
        ? `${existingLinks.join(', ')}, ${newLink}`
        : newLink;

    if (dom.saveAddLinkBtn) {
        dom.saveAddLinkBtn.disabled = true;
        dom.saveAddLinkBtn.textContent = 'Saving...';
    }

    try {
        if (!state.isDemoMode) {
            const response = await fetch(`/api/movies/${state.currentMovieId}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-token': state.serverApiToken
                },
                body: JSON.stringify({
                    link: updatedLinkString
                })
            });

            if (!response.ok) {
                throw new Error('Failed to save link to CSV');
            }
        }

        movie.link = updatedLinkString;
        const rawRow = state.rawCsvMovies.find((row) => String(row.movie_id) === String(state.currentMovieId));
        if (rawRow) rawRow.link = updatedLinkString;

        openMoviePage(state.currentMovieId, false);
        dom.addLinkInput.value = '';
        closeModal(dom.addLinkModal);
    } catch (error) {
        console.error('Error adding movie link:', error);
        alert('Could not save link. Please check your connection.');
    } finally {
        if (dom.saveAddLinkBtn) {
            dom.saveAddLinkBtn.disabled = false;
            dom.saveAddLinkBtn.textContent = 'Add Link';
        }
    }
}

// =========================================================================
// 5. Confirm Remove Movie Modal
// =========================================================================
export function openDeleteMovieModal() {
    if (!state.currentMovieId || !dom.deleteMovieModal) return;

    const movie = state.moviesDatabase.find((m) => String(m.movie_id) === String(state.currentMovieId));
    const movieTitleText = movie ? movie.title : `Movie #${state.currentMovieId}`;

    if (dom.deleteMovieTargetTitle) {
        dom.deleteMovieTargetTitle.textContent = `"${movieTitleText}"`;
    }

    openModal(dom.deleteMovieModal);
}

export async function handleDeleteCurrentMovie() {
    if (!state.currentMovieId) return;

    const idToDelete = String(state.currentMovieId);
    if (dom.deleteMovieBtn) dom.deleteMovieBtn.disabled = true;
    if (dom.cancelDeleteMovieBtn) dom.cancelDeleteMovieBtn.disabled = true;
    if (dom.confirmDeleteMovieBtn) {
        dom.confirmDeleteMovieBtn.disabled = true;
        dom.confirmDeleteMovieBtn.textContent = 'Removing...';
    }

    try {
        if (!state.isDemoMode) {
            const response = await fetch(`/api/movies/${idToDelete}`, {
                method: 'DELETE',
                headers: { 'x-api-token': state.serverApiToken }
            });

            if (!response.ok) {
                throw new Error('Failed to delete movie from server');
            }
        }

        state.rawCsvMovies = state.rawCsvMovies.filter((row) => String(row.movie_id) !== idToDelete);
        state.moviesDatabase = state.moviesDatabase.filter((m) => String(m.movie_id) !== idToDelete);
        rebuildPeopleIndex();

        renderHomeAllMovies();
        if (state.hasInitializedHomeRandom) {
            renderHomeRandomMovies();
        }
        renderRatedMoviesPage();

        state.navigationHistory = state.navigationHistory.filter((entry) => {
            if (entry.pageId === 'movie-page' && String(entry.movieId) === idToDelete) {
                return false;
            }
            if (entry.pageId === 'person-page' && entry.personId) {
                return state.peopleDatabase.some(
                    (p) =>
                        (p.id && String(p.id) === String(entry.personId)) ||
                        p.name.toLowerCase() === String(entry.personId).toLowerCase()
                );
            }
            return true;
        });

        state.currentMovieId = null;

        closeModal(dom.deleteMovieModal);
        goBackPage();
    } catch (error) {
        console.error('Error deleting movie:', error);
        alert('Could not remove movie. Please check your connection.');
    } finally {
        if (dom.deleteMovieBtn) dom.deleteMovieBtn.disabled = false;
        if (dom.cancelDeleteMovieBtn) dom.cancelDeleteMovieBtn.disabled = false;
        if (dom.confirmDeleteMovieBtn) {
            dom.confirmDeleteMovieBtn.disabled = false;
            dom.confirmDeleteMovieBtn.textContent = 'Remove';
        }
    }
}