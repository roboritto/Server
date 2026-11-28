import { state } from './state.js';
import { dom } from './dom.js';
import { updateFloatingAlphabetVisibility, scrollToMovieInAllMovies } from './home.js';
import { renderRatedMoviesPage } from './rated.js';
import { openMoviePage } from './movie.js';
import { openPersonPage } from './person.js';

export function syncBrowserUrl() {
    // Keep the initial deep-link URL intact until that movie finishes loading
    if (state.pendingInitialMovieId) return;

    if (state.isDemoMode) {
        const baseUrl = `${window.location.pathname}${window.location.search}`;
        const targetUrl = (state.currentPage === 'movie-page' && state.currentMovieId)
            ? `${baseUrl}#/${state.currentMovieId}`
            : baseUrl;
        if (`${window.location.pathname}${window.location.search}${window.location.hash}` !== targetUrl) {
            window.history.replaceState(null, '', targetUrl);
        }
        return;
    }

    const targetPath = (state.currentPage === 'movie-page' && state.currentMovieId)
        ? `/${state.currentMovieId}`
        : '/';

    if (window.location.pathname !== targetPath) {
        window.history.replaceState(null, '', targetPath);
    }
}

export function updateMobileNavVisibility() {
    // 1. Mobile top nav visibility on home-page
    if (state.currentPage === 'home-page' && window.scrollY <= 10) {
        dom.mainNav?.classList.add('mobile-nav-hidden');
    } else {
        dom.mainNav?.classList.remove('mobile-nav-hidden');
    }

    // 2. Global Scroll-to-Top button visibility (everywhere once scrolled down)
    if (dom.scrollTopBtn) {
        if (window.scrollY > 300) {
            dom.scrollTopBtn.classList.remove('hidden');
        } else {
            dom.scrollTopBtn.classList.add('hidden');
        }
    }

    // 3. Floating Alphabet Jump Bar visibility (only when All Movies section is in full view)
    updateFloatingAlphabetVisibility();
}

export function updateBackButtonVisibility() {
    if (!dom.pageBackBtn) return;
    if (state.currentPage === 'movie-page' || state.currentPage === 'person-page') {
        dom.pageBackBtn.classList.remove('hidden');
    } else {
        dom.pageBackBtn.classList.add('hidden');
    }
}

function isViewingAllMoviesSection() {
    if (state.currentPage !== 'home-page' || !dom.homeAllMoviesSection) return false;
    if (dom.homeAllMoviesSection.classList.contains('hidden')) return false;
    const rect = dom.homeAllMoviesSection.getBoundingClientRect();
    return rect.top <= 140 && rect.bottom > 0;
}

export function pushCurrentStateToHistory(meta = {}) {
    const inAllMoviesSection =
        state.currentPage === 'home-page'
            ? (typeof meta.fromAllMovies === 'boolean'
                ? meta.fromAllMovies
                : isViewingAllMoviesSection())
            : false;

    state.navigationHistory.push({
        pageId: state.currentPage,
        movieId: state.currentMovieId,
        personId: state.currentPersonId,
        inAllMoviesSection,
        scrollY: window.scrollY
    });
}

export function goBackPage() {
    if (state.navigationHistory.length === 0) {
        navigateToPage('home-page', dom.navHomeBtn, false);
        return;
    }

    const leavingPage = state.currentPage;
    const leavingMovieId = state.currentMovieId;
    const prevState = state.navigationHistory.pop();

    if (prevState.pageId === 'movie-page' && prevState.movieId) {
        openMoviePage(prevState.movieId, false);
    } else if (prevState.pageId === 'person-page' && prevState.personId) {
        openPersonPage(prevState.personId, false);
    } else {
        const btnMap = {
            'home-page': dom.navHomeBtn,
            'rated-page': dom.navRatedBtn
        };
        const shouldSkipToMovie =
            leavingPage === 'movie-page' &&
            prevState.pageId === 'home-page' &&
            Boolean(prevState.inAllMoviesSection);

        navigateToPage(prevState.pageId, btnMap[prevState.pageId] || null, false, {
            preserveScroll: shouldSkipToMovie
        });

        if (shouldSkipToMovie) {
            const scrolled = scrollToMovieInAllMovies(leavingMovieId, prevState.scrollY || 0);
            if (!scrolled) {
                window.scrollTo(0, 0);
            }
            updateMobileNavVisibility();
        }
    }
}

export function navigateToPage(targetPageId, activeBtn, recordHistory = true, options = {}) {
    if (recordHistory && targetPageId !== state.currentPage) {
        pushCurrentStateToHistory();
    }

    state.currentPage = targetPageId;

    if (recordHistory) {
        state.pendingInitialMovieId = null;
    }
    syncBrowserUrl();

    dom.allPages.forEach((page) => {
        if (!page) return;
        if (page.id === targetPageId) {
            page.classList.remove('hidden');
        } else {
            page.classList.add('hidden');
        }
    });

    dom.pageNavButtons.forEach((btn) => {
        if (btn) btn.classList.remove('active');
    });
    if (activeBtn) {
        activeBtn.classList.add('active');
    }

    if (targetPageId === 'rated-page') {
        renderRatedMoviesPage();
    }

    if (!options.preserveScroll) {
        window.scrollTo(0, 0);
    }
    updateMobileNavVisibility();
    updateBackButtonVisibility();
}

export function openModal(modalElement) {
    if (!modalElement) return;
    modalElement.classList.remove('hidden');
    if (modalElement === dom.dbSearchModal) {
        dom.modalSearchInput?.focus();
    } else if (modalElement === dom.tmdbAddModal) {
        dom.tmdbSearchInput?.focus();
    } else if (modalElement === dom.addLinkModal) {
        dom.addLinkInput?.focus();
    }
}

export function closeModal(modalElement) {
    modalElement?.classList.add('hidden');
}