import { state } from './state.js';
import { dom } from './dom.js';
import {
    getHeartSvgMarkup,
    parseCollectionArray,
    parseLinkArray,
    triggerDiceRollAnimation
} from './utils.js';
import { pushCurrentStateToHistory, navigateToPage } from './navigation.js';
import { openPersonPage } from './person.js';
import { updatePlayButtonForMovie } from './player.js';
import { refreshMoviePrecacheButton } from './precache.js';

function renderRatingHearts(ratingValue) {
    if (!dom.movieHearts) return;
    dom.movieHearts.innerHTML = '';

    const fullCount = Math.floor(ratingValue);
    const hasHalf = (ratingValue - fullCount) >= 0.5;

    for (let i = 0; i < fullCount; i++) {
        dom.movieHearts.innerHTML += getHeartSvgMarkup('full', `page-full-${i}`);
    }
    if (hasHalf) {
        dom.movieHearts.innerHTML += getHeartSvgMarkup('half', 'page-half');
    }
}

async function handleDownloadCollection(colName, matchingMovies, downloadBtnEl) {
    if (state.isDemoMode) {
        alert('Collection ZIP downloads require the self-hosted Python backend.');
        return;
    }
    if (!colName || !downloadBtnEl) return;

    const btnTextEl = downloadBtnEl.querySelector('.collection-download-btn-text');
    const titlesMap = {};
    const movieOrder = [];

    matchingMovies.forEach((m) => {
        const idStr = String(m.movie_id);
        const yearSuffix = m.release_year ? ` (${m.release_year})` : '';
        titlesMap[idStr] = `${m.title || `Movie_${idStr}`}${yearSuffix}`;
        movieOrder.push(idStr);
    });

    downloadBtnEl.disabled = true;
    if (btnTextEl) btnTextEl.textContent = 'Preparing...';

    try {
        const response = await fetch('/api/collections/download-ticket', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-token': state.serverApiToken
            },
            body: JSON.stringify({
                collection: colName,
                titles: titlesMap,
                movie_order: movieOrder
            })
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(data.detail || 'Could not prepare collection download.');
        }

        const downloadUrl = `/api/collections/download?ticket=${encodeURIComponent(data.ticket)}`;
        const tempLink = document.createElement('a');
        tempLink.href = downloadUrl;
        tempLink.style.display = 'none';
        document.body.appendChild(tempLink);
        tempLink.click();
        tempLink.remove();

        if (data.skipped_count > 0) {
            alert(
                `Downloading ${data.downloadable_count} movie(s). ${data.skipped_count} movie(s) could not be direct-downloaded and are listed in _skipped_movies.txt inside the ZIP.`
            );
        }
    } catch (error) {
        console.error('Collection download error:', error);
        alert(error.message || 'Failed to download collection.');
    } finally {
        downloadBtnEl.disabled = false;
        if (btnTextEl) btnTextEl.textContent = 'Download All';
    }
}

export function renderMovieCollections(movie) {
    if (!dom.movieCollectionsContainer) return;
    dom.movieCollectionsContainer.innerHTML = '';

    const collectionNames = parseCollectionArray(movie.collection);
    if (collectionNames.length === 0) return;

    collectionNames.forEach((colName) => {
        const matchingMovies = state.moviesDatabase.filter((m) => {
            const mCols = parseCollectionArray(m.collection).map((c) => c.toLowerCase());
            return mCols.includes(colName.toLowerCase());
        });

        matchingMovies.sort((a, b) => {
            const dateA = a.release_date || '9999-99-99';
            const dateB = b.release_date || '9999-99-99';
            return dateA.localeCompare(dateB);
        });

        const sectionEl = document.createElement('div');
        sectionEl.className = 'movie-collection-block';

        const headerRowEl = document.createElement('div');
        headerRowEl.className = 'collection-header-row';

        const headingEl = document.createElement('h2');
        headingEl.className = 'movie-section-heading';
        headingEl.textContent = colName;
        headerRowEl.appendChild(headingEl);

        const hasAnyLink = matchingMovies.some((m) => (m.link || '').trim().length > 0);
        if (hasAnyLink && state.permissions.download_collection) {
            const downloadAllBtn = document.createElement('button');
            downloadAllBtn.type = 'button';
            downloadAllBtn.className = 'collection-download-btn';
            downloadAllBtn.innerHTML = `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                    <polyline points="7 10 12 15 17 10"></polyline>
                    <line x1="12" y1="15" x2="12" y2="3"></line>
                </svg>
                <span class="collection-download-btn-text">Download All</span>
            `;
            downloadAllBtn.addEventListener('click', () => {
                handleDownloadCollection(colName, matchingMovies, downloadAllBtn);
            });
            headerRowEl.appendChild(downloadAllBtn);
        }

        sectionEl.appendChild(headerRowEl);

        const listEl = document.createElement('div');
        listEl.className = 'collection-list';

        matchingMovies.forEach((colMovie) => {
            const cardEl = document.createElement('div');
            cardEl.className = 'collection-card';
            if (String(colMovie.movie_id) === String(movie.movie_id)) {
                cardEl.classList.add('current-collection-movie');
            }

            const bgImg = colMovie.backdrop_path || colMovie.poster_path;
            if (bgImg) {
                cardEl.style.backgroundImage = `url('${bgImg}')`;
            }

            cardEl.innerHTML = `
                <div class="collection-card-overlay">
                    <div class="collection-card-title">${colMovie.title}</div>
                </div>
            `;

            cardEl.addEventListener('click', () => {
                if (String(colMovie.movie_id) !== String(movie.movie_id)) {
                    openMoviePage(colMovie.movie_id);
                }
            });

            listEl.appendChild(cardEl);
        });

        sectionEl.appendChild(listEl);
        dom.movieCollectionsContainer.appendChild(sectionEl);
    });
}

function isHttpLink(entry) {
    return /^https?:\/\//i.test((entry || '').trim());
}

async function handleDownloadLocalFile(movieId, filePath, btnEl) {
    if (state.isDemoMode) {
        alert('Local file downloads require the self-hosted Python backend.');
        return;
    }

    const labelEl = btnEl?.querySelector('span');
    const originalLabel = labelEl ? labelEl.textContent : '';

    if (btnEl) btnEl.disabled = true;
    if (labelEl) labelEl.textContent = 'Preparing...';

    try {
        const response = await fetch('/api/local-files/download-ticket', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-token': state.serverApiToken
            },
            body: JSON.stringify({
                movie_id: String(movieId),
                path: filePath
            })
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(data.detail || 'Could not download local file.');
        }

        const downloadUrl = `/api/local-files/download?ticket=${encodeURIComponent(data.ticket)}`;
        const tempLink = document.createElement('a');
        tempLink.href = downloadUrl;
        tempLink.style.display = 'none';
        document.body.appendChild(tempLink);
        tempLink.click();
        tempLink.remove();
    } catch (error) {
        console.error('Local file download error:', error);
        alert(error.message || 'Failed to download local file.');
    } finally {
        if (btnEl) btnEl.disabled = false;
        if (labelEl) labelEl.textContent = originalLabel;
    }
}

export function openMoviePage(movieId, recordHistory = true) {
    const movie = state.moviesDatabase.find((m) => String(m.movie_id) === String(movieId));
    if (!movie || !dom.moviePage) return;

    updateHideMovieButtonState(Boolean(movie.is_hidden));

    if (recordHistory && (state.currentPage !== 'movie-page' || String(state.currentMovieId) !== String(movieId))) {
        pushCurrentStateToHistory();
    }

    state.currentMovieId = String(movie.movie_id);

    // 1. Standardized Backdrop Image
    const backdropUrl = movie.backdrop_path || movie.poster_path || '';
    if (dom.movieBackdropImage) {
        dom.movieBackdropImage.style.backgroundImage = backdropUrl ? `url('${backdropUrl}')` : 'none';
    }

    // 2. Release Year & Title
    if (dom.movieReleaseYear) {
        dom.movieReleaseYear.textContent = movie.release_year || '';
        dom.movieReleaseYear.classList.toggle('hidden', !movie.release_year);
    }
    if (dom.movieTitle) dom.movieTitle.textContent = movie.title;

    // 3. Clickable Director(s)
    if (dom.movieDirectors) {
        dom.movieDirectors.innerHTML = '';
        if (movie.directors && movie.directors.length > 0) {
            const prefix = document.createElement('span');
            prefix.textContent = 'Directed by ';
            dom.movieDirectors.appendChild(prefix);

            movie.directors.forEach((dir, index) => {
                const dirSpan = document.createElement('span');
                dirSpan.className = 'director-link';
                dirSpan.textContent = dir.name;
                dirSpan.addEventListener('click', () => {
                    openPersonPage(dir.id || dir.name);
                });
                dom.movieDirectors.appendChild(dirSpan);

                if (index < movie.directors.length - 1) {
                    const comma = document.createElement('span');
                    comma.textContent = ', ';
                    dom.movieDirectors.appendChild(comma);
                }
            });
        }
    }

    // 4. Rating Hearts & Last Watch
    const numericRating = parseFloat(movie.rating) || 0;
    if (dom.movieRatingRow && dom.movieHearts && dom.movieLastWatch) {
        if (numericRating > 0) {
            renderRatingHearts(numericRating);
            dom.movieLastWatch.textContent = movie.last_watch || '';
            dom.movieRatingRow.classList.remove('hidden');
        } else {
            dom.movieRatingRow.classList.add('hidden');
            dom.movieHearts.innerHTML = '';
            dom.movieLastWatch.textContent = '';
        }
    }

    // 5. Synopsis
    if (dom.movieSynopsis) {
        dom.movieSynopsis.textContent = movie.overview || 'No synopsis available.';
    }

    // 6. Download Links & Play Button (Populated inside #download-modal-links)
    const links = parseLinkArray(movie.link);
    updatePlayButtonForMovie(movie);
    refreshMoviePrecacheButton(movie);

    if (dom.downloadModalLinks && dom.openDownloadModalBtn) {
        dom.downloadModalLinks.innerHTML = '';

        if (links.length > 0) {
            dom.openDownloadModalBtn.classList.remove('hidden');
            links.forEach((entry, idx) => {
                const isUrl = isHttpLink(entry);
                const baseLabel = links.length > 1 ? `Download ${idx + 1}` : 'Download';

                if (isUrl) {
                    const linkBtn = document.createElement('a');
                    linkBtn.href = entry;
                    linkBtn.target = '_blank';
                    linkBtn.rel = 'noopener noreferrer';
                    linkBtn.className = 'download-link-btn';
                    linkBtn.innerHTML = `
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                            <polyline points="7 10 12 15 17 10"></polyline>
                            <line x1="12" y1="15" x2="12" y2="3"></line>
                        </svg>
                        <span>${baseLabel}</span>
                    `;
                    dom.downloadModalLinks.appendChild(linkBtn);
                } else {
                    const localBtn = document.createElement('button');
                    localBtn.type = 'button';
                    localBtn.className = 'download-link-btn';
                    localBtn.title = entry;
                    localBtn.innerHTML = `
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                            <polyline points="7 10 12 15 17 10"></polyline>
                            <line x1="12" y1="15" x2="12" y2="3"></line>
                        </svg>
                        <span>${baseLabel}</span>
                    `;
                    localBtn.addEventListener('click', () => {
                        handleDownloadLocalFile(movie.movie_id, entry, localBtn);
                    });
                    dom.downloadModalLinks.appendChild(localBtn);
                }
            });
        } else {
            dom.openDownloadModalBtn.classList.add('hidden');
        }
    }

    // 7. Cast List
    if (dom.movieCastList) {
        dom.movieCastList.innerHTML = '';
        (movie.cast || []).forEach((actor) => {
            const card = document.createElement('div');
            card.className = 'cast-card';

            const imgHtml = actor.profile_path
                ? `<img src="${actor.profile_path}" alt="${actor.name}" class="cast-card-img">`
                : `<div class="cast-card-placeholder">No Photo</div>`;

            card.innerHTML = `
                ${imgHtml}
                <div class="cast-card-info">
                    <div class="cast-card-name" title="${actor.name}">${actor.name}</div>
                    <div class="cast-card-character" title="${actor.character || ''}">${actor.character || ''}</div>
                </div>
            `;

            card.addEventListener('click', () => {
                openPersonPage(actor.id || actor.name);
            });

            dom.movieCastList.appendChild(card);
        });
    }

    // 8. Collections
    renderMovieCollections(movie);

    // 9. Switch View
    navigateToPage('movie-page', null, false);
}

export function openRandomMoviePage() {
    if (state.moviesDatabase.length === 0) return;
    triggerDiceRollAnimation(dom.navRandomBtn);

    let pool = state.moviesDatabase;
    if (state.currentPage === 'movie-page' && state.currentMovieId && state.moviesDatabase.length > 1) {
        pool = state.moviesDatabase.filter((m) => String(m.movie_id) !== String(state.currentMovieId));
    }

    const randomIndex = Math.floor(Math.random() * pool.length);
    openMoviePage(pool[randomIndex].movie_id);
}

const EYE_VISIBLE_SVG = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
        <circle cx="12" cy="12" r="3"></circle>
    </svg>
`;

const EYE_HIDDEN_SVG = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>
        <line x1="1" y1="1" x2="23" y2="23"></line>
    </svg>
`;

function updateHideMovieButtonState(isHidden) {
    if (!dom.hideMovieBtn) return;
    dom.hideMovieBtn.classList.toggle('is-hidden-movie', Boolean(isHidden));
    dom.hideMovieBtn.innerHTML = isHidden ? EYE_HIDDEN_SVG : EYE_VISIBLE_SVG;
    const label = isHidden
        ? 'Hidden from public (click to unhide)'
        : 'Hide movie from public';
    dom.hideMovieBtn.title = label;
    dom.hideMovieBtn.setAttribute('aria-label', label);
}

export async function handleToggleHideMovie() {
    if (!state.isAdmin || state.isDemoMode || !state.currentMovieId) return;

    const targetId = String(state.currentMovieId);
    if (dom.hideMovieBtn) dom.hideMovieBtn.disabled = true;

    try {
        const response = await fetch(`/api/movies/${targetId}/toggle-hide`, {
            method: 'POST',
            headers: { 'x-api-token': state.serverApiToken }
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(data.detail || 'Could not update movie visibility');
        }

        const isNowHidden = Boolean(data.is_hidden);
        const movie = state.moviesDatabase.find((m) => String(m.movie_id) === targetId);
        if (movie) movie.is_hidden = isNowHidden;

        const rawRow = state.rawCsvMovies.find((r) => String(r.movie_id) === targetId);
        if (rawRow) rawRow.is_hidden = isNowHidden;

        updateHideMovieButtonState(isNowHidden);
    } catch (error) {
        console.error('Error toggling movie visibility:', error);
        alert(error.message || 'Failed to update movie visibility.');
    } finally {
        if (dom.hideMovieBtn) dom.hideMovieBtn.disabled = false;
    }
}