// const btn = document.getElementById('dashBtn');
// btn.addEventListener('click', () => {
//   window.electronAPI.toggleDashboard();
// });

// function startBuddyBlinking() {
//   const buddy = document.getElementById('buddy');
//   if (!buddy) return;
//   const openSrc = '../assets/buddy/buddy32.png'
//   const blinkSrc = '../assets/buddy/buddy32-2.png';
//   function blinkOnce() {
//     // Close eyes
//     buddy.src = blinkSrc;
//     // Stay closed for 200 ms, then reopen
//     setTimeout(() => {
//       buddy.src = openSrc;
//     }, 200);
//   }
//   // Natural blinking interval: every 4–8 seconds
//   function randomBlinkInterval() {
//     const delay = 4000 + Math.random() * 4000; // 4–8 seconds
//     setTimeout(() => {
//       blinkOnce();
//       randomBlinkInterval();
//     }, delay);
//   }

//   randomBlinkInterval();
// }

// function boot(){
//   startBuddyBlinking();
// }

// buddy-ui/renderer.js
// Safe, robust starter: swaps two image files to create a blink animation.

(function () {
  // run after DOM ready
  document.addEventListener('DOMContentLoaded', () => {
    const buddy = document.getElementById('buddy');
    const dashBtn = document.getElementById('dashBtn');

    // quick guard
    if (!buddy) {
      console.error('blink: #buddy element not found');
      return;
    }

    // Make sure these filenames exactly match what is on disk.
    // They are relative to this HTML file (buddy-ui/index.html).
    const openBase = '../assets/buddy/buddy32.png';      // eyes open
    const blinkBase = '../assets/buddy/buddy32-2.png';   // eyes closed (your second file)

    // small helper: append tiny cache-bust to force reload if needed
    const makeSrc = (base) => `${base}?r=${window.__buddyTick || (window.__buddyTick = Date.now())}`;

    // single blink: close -> stay -> open
    function blinkOnce(closeMs = 180) {
      try {
        buddy.src = makeSrc(blinkBase);                // closed
      } catch (e) {
        console.error('blinkOnce: failed to set blink src', e);
      }

      setTimeout(() => {
        try {
          // rotate the cache-bust token so browser reloads fresh image
          window.__buddyTick = Date.now();
          buddy.src = makeSrc(openBase);              // open again
        } catch (e) {
          console.error('blinkOnce: failed to restore open src', e);
        }
      }, closeMs);
    }

    // random interval loop (natural blinking)
    let blinkTimeoutId = null;
    function scheduleNextBlink() {
      const delay = 3500 + Math.random() * 5500; // 3.5s - 9s
      blinkTimeoutId = setTimeout(() => {
        blinkOnce();
        scheduleNextBlink();
      }, delay);
    }

    // Start initial visual (ensure open image first)
    window.__buddyTick = Date.now();
    buddy.src = makeSrc(openBase);

    // Start the loop
    scheduleNextBlink();

    // Optional: expose controls for debugging in console:
    window.buddyBlink = {
      blinkOnce,
      stop() { if (blinkTimeoutId) { clearTimeout(blinkTimeoutId); blinkTimeoutId = null; } },
      start() { if (!blinkTimeoutId) scheduleNextBlink(); },
      setOpen(src) { buddy.src = src; }
    };

    console.log('Buddy blink started', openBase, blinkBase);

    // keep your dashboard button wiring safe: optional
    if (dashBtn) {
      dashBtn.addEventListener('click', () => {
        // your existing IPC toggle — if you have a preload function:
        if (window.electronAPI?.toggleDashboard) window.electronAPI.toggleDashboard();
        else console.log('dashBtn clicked (no electronAPI toggleDashboard available)');
      });
    }
  });
})();
