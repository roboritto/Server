import { MAX_SEARCH_RESULTS } from './config.js';
import { state } from './state.js';
import { dom } from './dom.js';
import { closeModal } from './navigation.js';
import { openMoviePage } from './movie.js';
import { openPersonPage } from './person.js';

function levenshteinDistance(a, b) {
    const matrix = Array.from({ length: a.length + 1 }, () =>
        Array(b.length + 1).fill(0)
    );

    for (let i = 0; i <= a.length; i++) matrix[i][0] = i;
    for (let j = 0; j <= b.length; j++) matrix[0][j] = j;

    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            matrix[i][j] = Math.min(
                matrix[i - 1][j] + 1,
                matrix[i][j - 1] + 1,
                matrix[i - 1][j - 1] + cost
            );
        }
    }
    return matrix[a.length][b.length];
}

export function getFuzzyScore(query, targetText) {
    if (!targetText) return 0;
    const q = query.toLowerCase().trim();
    const t = targetText.toLowerCase().trim();

    if (!q) return 0;
    if (t === q) return 100;
    if (t.startsWith(q)) return 90;
    if (t.includes(q)) return 75;

    const queryWords = q.split(/\s+/);
    const targetWords = t.split(/[\s\-:,]+/);

    let totalScore = 0;
    for (const qWord of queryWords) {
        let bestWordScore = 0;

        for (const tWord of targetWords) {
            if (tWord.startsWith(qWord)) {
                bestWordScore = Math.max(bestWordScore, 70);
            } else if (qWord.length >= 3) {
                const maxAllowedTypos = qWord.length >= 6 ? 2 : 1;
                const slicedTarget = tWord.slice(0, qWord.length + 1);
                const dist = Math.min(
                    levenshteinDistance(qWord, tWord),
                    levenshteinDistance(qWord, slicedTarget)
                );
                if (dist <= maxAllowedTypos) {
                    bestWordScore = Math.max(bestWordScore, 55 - dist * 15);
                }
            }
        }

        if (bestWordScore === 0) return 0;
        totalScore += bestWordScore;
    }

    return totalScore / queryWords.length;
}

function getMovieIdSearchScore(query, movieId) {
    const cleanQuery = query.trim();
    const idStr = String(movieId || '').trim();
    if (!cleanQuery || !idStr) return 0;

    if (idStr === cleanQuery) return 110; // Exact ID match ranks above title matches
    if (/^\d+$/.test(cleanQuery)) {
        if (idStr.startsWith(cleanQuery)) return 95;
        if (idStr.includes(cleanQuery)) return 80;
    }
    return 0;
}

export function performDatabaseSearch(query) {
    const cleanQuery = query.trim();
    if (!cleanQuery) return [];

    const movieResults = [];
    const personResults = [];

    state.moviesDatabase.forEach((movie) => {
        const titleScore = getFuzzyScore(cleanQuery, movie.title);
        const idScore = getMovieIdSearchScore(cleanQuery, movie.movie_id);
        const score = Math.max(titleScore, idScore);

        if (score > 0) {
            movieResults.push({
                resultType: 'movie',
                score,
                item: movie
            });
        }
    });

    state.peopleDatabase.forEach((person) => {
        const score = getFuzzyScore(cleanQuery, person.name);
        if (score > 0) {
            personResults.push({
                resultType: 'person',
                score,
                item: person
            });
        }
    });

    movieResults.sort((a, b) => b.score - a.score);
    personResults.sort((a, b) => b.score - a.score);

    return [...movieResults, ...personResults].slice(0, MAX_SEARCH_RESULTS);
}

function setActiveSearchResult(containerElement, nextIndex, { scroll = true } = {}) {
    if (!containerElement) return;
    const items = Array.from(containerElement.querySelectorAll('.search-result-item'));
    items.forEach((item) => item.classList.remove('active'));

    if (items.length === 0 || nextIndex < 0) {
        containerElement.dataset.activeIndex = '-1';
        return;
    }

    const wrappedIndex = ((nextIndex % items.length) + items.length) % items.length;
    const activeItem = items[wrappedIndex];
    activeItem.classList.add('active');
    containerElement.dataset.activeIndex = String(wrappedIndex);

    if (scroll) {
        activeItem.scrollIntoView({ block: 'nearest' });
    }
}

export function handleSearchInputKeydown(event, containerElement, { onEscape = null } = {}) {
    if (!containerElement) return;

    const key = event.key;
    if (key === 'Escape') {
        event.preventDefault();
        if (typeof onEscape === 'function') {
            onEscape();
        }
        return;
    }

    if (key !== 'ArrowDown' && key !== 'ArrowUp' && key !== 'Enter') return;

    const items = containerElement.querySelectorAll('.search-result-item');
    if (items.length === 0) return;

    const isHidden = containerElement.classList.contains('hidden');
    if (isHidden) {
        if (key === 'ArrowDown') {
            event.preventDefault();
            containerElement.classList.remove('hidden');
            const current = parseInt(containerElement.dataset.activeIndex ?? '-1', 10);
            setActiveSearchResult(containerElement, current >= 0 ? current : 0);
        }
        return;
    }

    const currentIndex = parseInt(containerElement.dataset.activeIndex ?? '-1', 10);

    if (key === 'ArrowDown') {
        event.preventDefault();
        const nextIndex = currentIndex < 0 ? 0 : currentIndex + 1;
        setActiveSearchResult(containerElement, nextIndex);
    } else if (key === 'ArrowUp') {
        event.preventDefault();
        const nextIndex = currentIndex < 0 ? items.length - 1 : currentIndex - 1;
        setActiveSearchResult(containerElement, nextIndex);
    } else if (key === 'Enter') {
        event.preventDefault();
        const targetIndex = currentIndex >= 0 && currentIndex < items.length ? currentIndex : 0;
        items[targetIndex]?.click();
    }
}

export function renderSearchResults(results, containerElement) {
    if (!containerElement) return;
    containerElement.innerHTML = '';
    containerElement.dataset.activeIndex = '-1';

    if (results.length === 0) {
        const statusMsg = state.isDatabaseLoading
            ? `Loading database (${state.moviesDatabase.length}/${state.rawCsvMovies.length})... keep typing!`
            : 'No matching movies, actors, or directors found.';
        containerElement.innerHTML = `<div class="search-empty-msg">${statusMsg}</div>`;
        containerElement.classList.remove('hidden');
        return;
    }

    results.forEach((entry, index) => {
        const row = document.createElement('div');
        row.className = 'search-result-item';

        row.addEventListener('mousemove', () => {
            if (!row.classList.contains('active')) {
                setActiveSearchResult(containerElement, index, { scroll: false });
            }
        });

        if (entry.resultType === 'movie') {
            const movie = entry.item;
            if (movie.is_hidden) {
                row.classList.add('is-hidden-movie');
            }
            const posterHtml = movie.poster_path
                ? `<img src="${movie.poster_path}" alt="${movie.title}" class="search-result-poster">`
                : `<div class="search-result-poster search-result-placeholder">No Poster</div>`;

            row.innerHTML = `
                ${posterHtml}
                <div class="search-result-info">
                    <div class="search-result-title">${movie.title}</div>
                    <div class="search-result-sub">${movie.release_year || 'Unknown Year'}</div>
                </div>
            `;

            row.addEventListener('click', (event) => {
                event.stopPropagation();
                dom.homeSearchResults?.classList.add('hidden');
                dom.homeSearchInput?.blur();
                dom.modalSearchInput?.blur();
                closeModal(dom.dbSearchModal);
                openMoviePage(movie.movie_id);
            });
        } else {
            const person = entry.item;
            const avatarHtml = person.profile_path
                ? `<img src="${person.profile_path}" alt="${person.name}" class="search-result-avatar">`
                : `<div class="search-result-avatar search-result-placeholder">No Photo</div>`;

            row.innerHTML = `
                ${avatarHtml}
                <div class="search-result-info">
                    <div class="search-result-title">${person.name}</div>
                    <div class="search-result-sub">${person.role}</div>
                </div>
            `;

            row.addEventListener('click', (event) => {
                event.stopPropagation();
                dom.homeSearchResults?.classList.add('hidden');
                dom.homeSearchInput?.blur();
                dom.modalSearchInput?.blur();
                closeModal(dom.dbSearchModal);
                openPersonPage(person.id || person.name);
            });
        }

        containerElement.appendChild(row);
    });

    containerElement.classList.remove('hidden');
    setActiveSearchResult(containerElement, 0, { scroll: false });
}