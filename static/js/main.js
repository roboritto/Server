import { state } from './state.js';
import { dom } from './dom.js';
import { triggerDiceRollAnimation } from './utils.js';
import { verifyAndLoadConfig, initAuth } from './api.js';
import {
    updateMobileNavVisibility,
    goBackPage,
    navigateToPage,
    openModal,
    closeModal
} from './navigation.js';
import { performDatabaseSearch, renderSearchResults } from './search.js';
import {
    initHomeCatalogFilters,
    renderHomeRandomMovies,
    toggleNewMoviesFilter,
    clearAllCatalogFilters
} from './home.js';
import { updateRatedFilterHeartsUI, renderRatedMoviesPage } from './rated.js';
import { openRandomMoviePage } from './movie.js';
import {
    performTmdbSearch,
    updateModalHeartsUI,
    openRatingModalForCurrentMovie,
    saveMovieRatingAndReview,
    renderCollectionModalList,
    openCollectionModalForCurrentMovie,
    handleAddNewCollection,
    openAddLinkModalForCurrentMovie,
    handleAddMovieLink,
    openDeleteMovieModal,
    handleDeleteCurrentMovie
} from './modals.js';

// --- 1. Auth Listeners ---
dom.authForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    const inputToken = dom.tokenInput?.value.trim();
    if (inputToken) {
        verifyAndLoadConfig(inputToken);
    }
});

// --- 2. Global Navigation & Scroll Listeners ---
window.addEventListener('scroll', updateMobileNavVisibility);

dom.navHomeBtn?.addEventListener('click', () => navigateToPage('home-page', dom.navHomeBtn));
dom.navRatedBtn?.addEventListener('click', () => navigateToPage('rated-page', dom.navRatedBtn));
dom.navRandomBtn?.addEventListener('click', openRandomMoviePage);
dom.navSearchBtn?.addEventListener('click', () => openModal(dom.dbSearchModal));
dom.navAddBtn?.addEventListener('click', () => openModal(dom.tmdbAddModal));

dom.pageBackBtn?.addEventListener('click', goBackPage);

dom.scrollTopBtn?.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
});

// --- 3. Home Page Listeners ---
dom.homeRerollRandomBtn?.addEventListener('click', () => {
    triggerDiceRollAnimation(dom.homeRerollRandomBtn);
    renderHomeRandomMovies();
});

dom.toggleFiltersBtn?.addEventListener('click', () => {
    if (!dom.allMoviesFiltersDrawer) return;
    const isHidden = dom.allMoviesFiltersDrawer.classList.toggle('hidden');
    dom.toggleFiltersBtn.classList.toggle('active', !isHidden);
});

dom.clearAllFiltersBtn?.addEventListener('click', clearAllCatalogFilters);
dom.filterNewBtn?.addEventListener('click', toggleNewMoviesFilter);

// --- 4. Rated Page Listeners ---
dom.ratedFilterHearts.forEach((heartEl) => {
    heartEl.addEventListener('click', (event) => {
        const heartIndex = parseInt(heartEl.getAttribute('data-heart-index'), 10);
        const rect = heartEl.getBoundingClientRect();
        const clickX = event.clientX - rect.left;
        const isFirstHalf = clickX < rect.width / 2;

        const clickedRating = isFirstHalf ? (heartIndex - 0.5) : heartIndex;
        const nextRating = Math.abs(state.activeRatedFilter - clickedRating) < 0.01 ? 0.0 : clickedRating;

        updateRatedFilterHeartsUI(nextRating);
        renderRatedMoviesPage();
    });
});

// --- 5. Movie Page & Modal Action Listeners ---
dom.openDownloadModalBtn?.addEventListener('click', () => openModal(dom.downloadModal));
dom.openRatingModalBtn?.addEventListener('click', openRatingModalForCurrentMovie);
dom.openCollectionModalBtn?.addEventListener('click', openCollectionModalForCurrentMovie);
dom.openAddLinkModalBtn?.addEventListener('click', openAddLinkModalForCurrentMovie);
dom.deleteMovieBtn?.addEventListener('click', openDeleteMovieModal);

dom.interactiveHearts.forEach((heartEl) => {
    heartEl.addEventListener('click', (event) => {
        const heartIndex = parseInt(heartEl.getAttribute('data-heart-index'), 10);
        const rect = heartEl.getBoundingClientRect();
        const clickX = event.clientX - rect.left;
        const isFirstHalf = clickX < rect.width / 2;

        const newRating = isFirstHalf ? (heartIndex - 0.5) : heartIndex;
        updateModalHeartsUI(newRating);
    });
});

dom.clearRatingBtn?.addEventListener('click', () => updateModalHeartsUI(0.0));
dom.ratingForm?.addEventListener('submit', saveMovieRatingAndReview);

dom.collectionSearchInput?.addEventListener('input', () => {
    renderCollectionModalList(dom.collectionSearchInput.value);
});
dom.collectionSearchForm?.addEventListener('submit', handleAddNewCollection);

dom.addLinkForm?.addEventListener('submit', handleAddMovieLink);
dom.confirmDeleteMovieBtn?.addEventListener('click', handleDeleteCurrentMovie);

// --- 6. Modal Close & Backdrop Dismiss Wiring ---
const modalCloseBindings = [
    { modal: dom.dbSearchModal, closeBtns: [dom.closeDbSearchBtn] },
    { modal: dom.tmdbAddModal, closeBtns: [dom.closeTmdbAddBtn] },
    { modal: dom.ratingModal, closeBtns: [dom.closeRatingModalBtn] },
    { modal: dom.collectionModal, closeBtns: [dom.closeCollectionModalBtn] },
    { modal: dom.downloadModal, closeBtns: [dom.closeDownloadModalBtn] },
    { modal: dom.deleteMovieModal, closeBtns: [dom.closeDeleteModalBtn, dom.cancelDeleteMovieBtn] },
    { modal: dom.addLinkModal, closeBtns: [dom.closeAddLinkModalBtn] }
];

modalCloseBindings.forEach(({ modal, closeBtns }) => {
    if (!modal) return;
    closeBtns.forEach((btn) => {
        btn?.addEventListener('click', () => closeModal(modal));
    });
    modal.addEventListener('click', (event) => {
        if (event.target === modal) closeModal(modal);
    });
});

// --- 7. Shared Search & TMDB Search Listeners ---
dom.homeSearchForm?.addEventListener('submit', (event) => event.preventDefault());
dom.modalSearchForm?.addEventListener('submit', (event) => event.preventDefault());

dom.tmdbSearchForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    const query = dom.tmdbSearchInput ? dom.tmdbSearchInput.value : '';
    clearTimeout(state.tmdbSearchTimeout);
    if (query.trim()) {
        performTmdbSearch(query);
    }
});

dom.homeSearchInput?.addEventListener('input', () => {
    const query = dom.homeSearchInput.value;
    if (!query.trim()) {
        dom.homeSearchResults?.classList.add('hidden');
        if (dom.homeSearchResults) dom.homeSearchResults.innerHTML = '';
        return;
    }
    const matches = performDatabaseSearch(query);
    renderSearchResults(matches, dom.homeSearchResults);
});

dom.homeSearchInput?.addEventListener('focus', () => {
    if (dom.homeSearchInput.value.trim()) {
        const matches = performDatabaseSearch(dom.homeSearchInput.value);
        renderSearchResults(matches, dom.homeSearchResults);
    }
});

dom.modalSearchInput?.addEventListener('input', () => {
    const query = dom.modalSearchInput.value;
    if (!query.trim()) {
        if (dom.modalSearchResults) dom.modalSearchResults.innerHTML = '';
        return;
    }
    const matches = performDatabaseSearch(query);
    renderSearchResults(matches, dom.modalSearchResults);
});

dom.tmdbSearchInput?.addEventListener('input', () => {
    const query = dom.tmdbSearchInput.value;
    clearTimeout(state.tmdbSearchTimeout);

    if (!query.trim()) {
        state.latestTmdbSearchQuery = '';
        if (dom.tmdbSearchResults) dom.tmdbSearchResults.innerHTML = '';
        return;
    }

    state.tmdbSearchTimeout = setTimeout(() => {
        performTmdbSearch(query);
    }, 300);
});

document.addEventListener('click', (event) => {
    if (dom.homeSearchForm && !dom.homeSearchForm.contains(event.target)) {
        dom.homeSearchResults?.classList.add('hidden');
    }
});

// --- 8. Global Keyboard Shortcut ('/' to Search) ---
document.addEventListener('keydown', (event) => {
    if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
    if (!dom.appContainer || dom.appContainer.classList.contains('hidden')) return;

    const activeEl = document.activeElement;
    if (
        activeEl &&
        (activeEl.tagName === 'INPUT' ||
            activeEl.tagName === 'TEXTAREA' ||
            activeEl.isContentEditable)
    ) {
        return;
    }

    if (document.querySelector('.modal-overlay:not(.hidden)')) return;

    event.preventDefault();

    if (state.currentPage === 'home-page' && window.scrollY <= 100 && dom.homeSearchInput) {
        dom.homeSearchInput.focus();
    } else if (dom.dbSearchModal) {
        openModal(dom.dbSearchModal);
    }
});

// --- 9. Initialize App ---
initHomeCatalogFilters();
updateRatedFilterHeartsUI(0.0);
initAuth();