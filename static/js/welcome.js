import { dom } from './dom.js';
import { sleep } from './utils.js';

const PRE_SPOTLIGHT_DARK_MS = 280;
const SPOTLIGHT_TO_TITLE_DELAY_MS = 220;
const TITLE_FADE_AND_HOLD_MS = 1550;
const CURTAIN_OPEN_TO_BLACK_MS = 2650;
const BLACKOUT_HOLD_MS = 240;
const MAX_FONT_WAIT_MS = 450;
const MAX_EXTRA_LOAD_WAIT_MS = 1200;

let activeRunId = 0;

function waitTwoFrames() {
    return new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
}

export async function playWelcomeCurtain(loadPromise = Promise.resolve()) {
    const screen = dom.welcomeScreen;
    if (!screen) return;

    const runId = ++activeRunId;
    let skipped = false;

    // Start in dark closed-curtain state over a pure black backdrop
    screen.classList.remove('hidden', 'spotlight-on', 'title-visible', 'opening');
    screen.setAttribute('aria-hidden', 'false');

    const cleanupSkipListeners = () => {
        screen.removeEventListener('click', revealImmediately);
        document.removeEventListener('keydown', onKeyDown);
    };

    const revealImmediately = () => {
        if (skipped || runId !== activeRunId) return;
        skipped = true;
        cleanupSkipListeners();
        screen.classList.add('hidden');
        screen.classList.remove('spotlight-on', 'title-visible', 'opening');
        screen.setAttribute('aria-hidden', 'true');
    };

    const onKeyDown = (event) => {
        if (event.key === 'Escape') revealImmediately();
    };

    screen.addEventListener('click', revealImmediately);
    document.addEventListener('keydown', onKeyDown);

    // Preload Roller Coaster Serif while the theater is dark
    const fontReady = document.fonts?.load
        ? Promise.race([
              document.fonts.load('400 48px "Roller Coaster Serif"').catch(() => {}),
              sleep(MAX_FONT_WAIT_MS)
          ])
        : Promise.resolve();

    // Ensure the browser paints the initial dark state before snapping the spotlight on
    await waitTwoFrames();
    await sleep(PRE_SPOTLIGHT_DARK_MS);
    if (skipped || runId !== activeRunId) return;

    // Step 1: Spotlight snaps on suddenly
    screen.classList.add('spotlight-on');

    await Promise.all([sleep(SPOTLIGHT_TO_TITLE_DELAY_MS), fontReady]);
    if (skipped || runId !== activeRunId) return;

    // Step 2: Welcome title fades in slowly inside the lit spotlight
    screen.classList.add('title-visible');
    await sleep(TITLE_FADE_AND_HOLD_MS);
    if (skipped || runId !== activeRunId) return;

    // Step 3: Curtains part while spotlight & title fade out slowly to pure black
    screen.classList.add('opening');
    await sleep(CURTAIN_OPEN_TO_BLACK_MS);
    if (skipped || runId !== activeRunId) return;

    // Brief pure-black pause while waiting for any remaining initial DB paint
    await Promise.all([
        sleep(BLACKOUT_HOLD_MS),
        Promise.race([
            Promise.resolve(loadPromise).catch(() => {}),
            sleep(MAX_EXTRA_LOAD_WAIT_MS)
        ])
    ]);
    await waitTwoFrames();
    if (skipped || runId !== activeRunId) return;

    // Step 4: Snap black screen off instantaneously (all stage lights turn on at once)
    cleanupSkipListeners();
    screen.classList.add('hidden');
    screen.classList.remove('spotlight-on', 'title-visible', 'opening');
    screen.setAttribute('aria-hidden', 'true');
}