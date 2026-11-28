import { HOME_RANDOM_COUNT, TMDB_GENRES, ALPHABET_KEYS } from './config.js';
import { state } from './state.js';
import { dom } from './dom.js';
import { getMovieAlphaKey, createMovieCard } from './utils.js';
import { openMoviePage } from './movie.js';

export function renderHomeRandomMovies() {
    if (!dom.homeRandomSection || !dom.homeRandomGrid || state.moviesDatabase.length === 0) return;

    const shuffled = [...state.moviesDatabase];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    const selectedMovies = shuffled.slice(0, HOME_RANDOM_COUNT);

    dom.homeRandomGrid.innerHTML = '';
    selectedMovies.forEach((movie) => {
        dom.homeRandomGrid.appendChild(
            createMovieCard(movie, (movieId) => openMoviePage(movieId, true, { fromAllMovies: false }))
        );
    });

    dom.homeRandomSection.classList.remove('hidden');
}

export function initHomeCatalogFilters() {
    renderGenreFilterChips();
    renderFloatingAlphabetBar(new Set());
}

export function renderGenreFilterChips() {
    if (!dom.genreFiltersList) return;
    dom.genreFiltersList.innerHTML = '';

    TMDB_GENRES.forEach((genreObj) => {
        const filterState = state.genreFilterStates[genreObj.tmdbName] || 0;
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'genre-chip';

        if (filterState === 1) {
            chip.classList.add('include');
            chip.textContent = `+ ${genreObj.label}`;
        } else if (filterState === -1) {
            chip.classList.add('exclude');
            chip.textContent = `- ${genreObj.label}`;
        } else {
            chip.textContent = genreObj.label;
        }

        chip.addEventListener('click', () => {
            const currentState = state.genreFilterStates[genreObj.tmdbName] || 0;
            // Cycle: 0 (neutral) -> 1 (include) -> -1 (exclude) -> 0 (neutral)
            if (currentState === 0) {
                state.genreFilterStates[genreObj.tmdbName] = 1;
            } else if (currentState === 1) {
                state.genreFilterStates[genreObj.tmdbName] = -1;
            } else {
                delete state.genreFilterStates[genreObj.tmdbName];
            }

            renderGenreFilterChips();
            updateClearFiltersButtonVisibility();
            renderHomeAllMovies();
        });

        dom.genreFiltersList.appendChild(chip);
    });
}

export function renderFloatingAlphabetBar(availableKeysSet = new Set()) {
    if (!dom.floatingAlphabetBar) return;
    dom.floatingAlphabetBar.innerHTML = '';

    ALPHABET_KEYS.forEach((key) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'floating-alpha-btn';
        btn.setAttribute('data-alpha-btn', key);
        btn.textContent = key;

        if (!availableKeysSet.has(key)) {
            btn.classList.add('disabled');
        } else {
            btn.addEventListener('click', () => {
                jumpToAlphabetSection(key);
            });
        }

        dom.floatingAlphabetBar.appendChild(btn);
    });
}

function jumpToAlphabetSection(alphaKey) {
    if (!dom.homeAllMoviesGrid) return;
    const targetCard = dom.homeAllMoviesGrid.querySelector(`.movie-card[data-alpha-anchor="${alphaKey}"]`);
    if (!targetCard) return;

    const isMobileNav = window.innerWidth <= 768 || window.matchMedia('(hover: none) and (pointer: coarse)').matches;
    const topOffset = isMobileNav ? 80 : 24;
    const targetY = targetCard.getBoundingClientRect().top + window.scrollY - topOffset;

    window.scrollTo({
        top: targetY,
        behavior: 'smooth'
    });
}

export function scrollToMovieInAllMovies(movieId, fallbackScrollY = 0) {
    if (!dom.homeAllMoviesGrid) return false;

    const safeId = movieId
        ? (typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
            ? CSS.escape(String(movieId))
            : String(movieId))
        : '';
    const targetCard = safeId
        ? dom.homeAllMoviesGrid.querySelector(`.movie-card[data-movie-id="${safeId}"]`)
        : null;

    if (targetCard) {
        const isMobileNav =
            window.innerWidth <= 768 ||
            window.matchMedia('(hover: none) and (pointer: coarse)').matches;
        const navOffset = isMobileNav ? 64 : 0;
        const rect = targetCard.getBoundingClientRect();
        const cardTopInDoc = rect.top + window.scrollY;
        const centerOffset = Math.max(24, (window.innerHeight - navOffset - rect.height) / 2);
        const targetY = Math.max(0, cardTopInDoc - navOffset - centerOffset);

        window.scrollTo({ top: targetY, behavior: 'auto' });
        return true;
    }

    if (fallbackScrollY > 0) {
        window.scrollTo({ top: fallbackScrollY, behavior: 'auto' });
        return true;
    }

    return false;
}

export function updateFloatingAlphabetVisibility() {
    if (!dom.floatingAlphabetBar || !dom.homeAllMoviesSection) return;

    if (state.currentPage !== 'home-page' || dom.homeAllMoviesSection.classList.contains('hidden')) {
        dom.floatingAlphabetBar.classList.add('hidden');
        return;
    }

    const rect = dom.homeAllMoviesSection.getBoundingClientRect();
    const isInFullView = rect.top <= 140 && rect.bottom >= window.innerHeight * 0.4;

    if (isInFullView) {
        dom.floatingAlphabetBar.classList.remove('hidden');
        highlightCurrentVisibleAlphabet();
    } else {
        dom.floatingAlphabetBar.classList.add('hidden');
    }
}

function highlightCurrentVisibleAlphabet() {
    if (!dom.floatingAlphabetBar || !dom.homeAllMoviesGrid) return;

    const cards = dom.homeAllMoviesGrid.querySelectorAll('.movie-card[data-alpha-group]');
    let currentKey = null;
    const thresholdY = 160;

    for (const card of cards) {
        const rect = card.getBoundingClientRect();
        if (rect.bottom >= thresholdY) {
            currentKey = card.getAttribute('data-alpha-group');
            break;
        }
    }

    const buttons = dom.floatingAlphabetBar.querySelectorAll('.floating-alpha-btn');
    buttons.forEach((btn) => {
        const isMatch = btn.getAttribute('data-alpha-btn') === currentKey;
        btn.classList.toggle('active', isMatch);
    });
}

function updateClearFiltersButtonVisibility() {
    if (!dom.clearAllFiltersBtn) return;
    const hasActiveFilters =
        Object.keys(state.genreFilterStates).length > 0 || state.filterNewOnly;
    dom.clearAllFiltersBtn.classList.toggle('hidden', !hasActiveFilters);
}

export function toggleNewMoviesFilter() {
    state.filterNewOnly = !state.filterNewOnly;
    dom.filterNewBtn?.classList.toggle('active', state.filterNewOnly);
    updateClearFiltersButtonVisibility();
    renderHomeAllMovies();
}

export function clearAllCatalogFilters() {
    state.genreFilterStates = {};
    state.filterNewOnly = false;
    dom.filterNewBtn?.classList.remove('active');
    renderGenreFilterChips();
    updateClearFiltersButtonVisibility();
    renderHomeAllMovies();
}

export function renderHomeAllMovies() {
    if (!dom.homeAllMoviesSection || !dom.homeAllMoviesGrid) return;

    if (state.moviesDatabase.length === 0) {
        dom.homeAllMoviesSection.classList.add('hidden');
        updateFloatingAlphabetVisibility();
        return;
    }

    dom.homeAllMoviesSection.classList.remove('hidden');

    const includedGenres = Object.keys(state.genreFilterStates).filter((g) => state.genreFilterStates[g] === 1);
    const excludedGenres = Object.keys(state.genreFilterStates).filter((g) => state.genreFilterStates[g] === -1);

    const filteredMovies = state.moviesDatabase.filter((movie) => {
        if (state.filterNewOnly && !movie.is_new) return false;

        const movieGenres = (movie.genres || []).map((g) => g.toLowerCase());

        for (const inc of includedGenres) {
            if (!movieGenres.includes(inc.toLowerCase())) return false;
        }
        for (const exc of excludedGenres) {
            if (movieGenres.includes(exc.toLowerCase())) return false;
        }
        return true;
    });

    filteredMovies.sort((a, b) =>
        (a.title || '').localeCompare(b.title || '', undefined, { numeric: true, sensitivity: 'base' })
    );

    if (dom.allMoviesCountBadge) {
        dom.allMoviesCountBadge.textContent = `${filteredMovies.length}`;
    }

    dom.homeAllMoviesGrid.innerHTML = '';
    const availableAlphaKeys = new Set();

    if (filteredMovies.length === 0) {
        dom.homeAllMoviesGrid.innerHTML = `<div class="search-empty-msg" style="grid-column: 1 / -1;">No movies match the selected filters.</div>`;
        renderFloatingAlphabetBar(availableAlphaKeys);
        updateFloatingAlphabetVisibility();
        return;
    }

    filteredMovies.forEach((movie) => {
        const card = createMovieCard(movie, (movieId) =>
            openMoviePage(movieId, true, { fromAllMovies: true })
        );
        const alphaKey = getMovieAlphaKey(movie.title);
        card.setAttribute('data-alpha-group', alphaKey);

        if (!availableAlphaKeys.has(alphaKey)) {
            availableAlphaKeys.add(alphaKey);
            card.setAttribute('data-alpha-anchor', alphaKey);
        }

        dom.homeAllMoviesGrid.appendChild(card);
    });

    renderFloatingAlphabetBar(availableAlphaKeys);
    updateFloatingAlphabetVisibility();
}