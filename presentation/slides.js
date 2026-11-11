'use strict';
(() => {
  const config = window.PRESENTATION;
  const slides = Array.from(document.querySelectorAll('.slide'));
  const totalSeconds = slides.reduce((sum, slide) => sum + Number(slide.dataset.seconds), 0);
  const formatTime = seconds => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  let current = Math.max(0, Math.min(slides.length - 1, (Number(location.hash.slice(1)) || 1) - 1));
  let elapsed = 0;
  let runningSince = null;
  const byId = id => document.getElementById(id);
  document.querySelectorAll('[data-value]').forEach(el => { el.textContent = config.guesser[el.dataset.value]; });
  document.querySelectorAll('[data-ref]').forEach(el => { el.textContent = config.referee[el.dataset.ref]; });
  byId('members').textContent = config.members.join(' · ');
  if (config.gameUrl) {
    const url = new URL(config.gameUrl);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Game URL must use HTTP or HTTPS');
    byId('game-link').href = url.href;
    byId('game-link').textContent = url.host + (url.pathname === '/' ? '' : url.pathname);
    byId('qr').src = 'assets/game-qr.png';
    byId('qr').hidden = false;
    byId('qr-pending').hidden = true;
  }
  slides.forEach((slide, index) => { slide.dataset.n = String(index + 1).padStart(2, '0'); slide.setAttribute('aria-label', `Slide ${index + 1} of ${slides.length}`); });
  function show(index) {
    current = Math.max(0, Math.min(slides.length - 1, index));
    slides.forEach((slide, i) => {
      slide.classList.toggle('active', i === current);
      slide.setAttribute('aria-hidden', String(i !== current));
      slide.inert = i !== current;
    });
    byId('count').textContent = `${String(current + 1).padStart(2, '0')} / ${slides.length}`;
    byId('bar').style.width = `${(current + 1) / slides.length * 100}%`;
    document.querySelector('.progress').setAttribute('aria-valuenow', current + 1);
    document.querySelector('.progress').setAttribute('aria-valuemin', 1);
    document.querySelector('.progress').setAttribute('aria-valuemax', slides.length);
    byId('section-label').textContent = slides[current].dataset.label;
    byId('prev').disabled = current === 0;
    byId('next').disabled = current === slides.length - 1;
    byId('note-copy').textContent = slides[current].querySelector('.notes').textContent;
    const start = slides.slice(0, current).reduce((sum, slide) => sum + Number(slide.dataset.seconds), 0);
    byId('note-timing').textContent = `SLIDE ${current + 1} / ${slides[current].dataset.seconds}s / ${formatTime(start)}–${formatTime(start + Number(slides[current].dataset.seconds))}`;
    history.replaceState(null, '', `#${current + 1}`);
    window.scrollTo(0, 0);
  }
  const toggleNotes = () => { byId('notes-panel').hidden = !byId('notes-panel').hidden; byId('notes-toggle').setAttribute('aria-expanded', String(!byId('notes-panel').hidden)); };
  const fullscreen = async () => {
    try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); } catch { /* Browser may restrict fullscreen in embedded previews. */ }
  };
  byId('prev').onclick = () => show(current - 1);
  byId('next').onclick = () => show(current + 1);
  byId('notes-toggle').onclick = toggleNotes;
  byId('fullscreen').onclick = fullscreen;
  byId('timer').onclick = () => { if (runningSince === null) runningSince = performance.now(); else { elapsed += (performance.now() - runningSince) / 1000; runningSince = null; } updateTimer(); };
  function updateTimer() {
    const seconds = elapsed + (runningSince === null ? 0 : (performance.now() - runningSince) / 1000);
    byId('timer').textContent = `${formatTime(Math.floor(seconds))} / ${formatTime(totalSeconds)}`;
    byId('timer').style.color = seconds > totalSeconds ? '#b32030' : '';
    byId('timer').setAttribute('aria-pressed', String(runningSince !== null));
  }
  setInterval(updateTimer, 500);
  let lossVisible = false;
  byId('chart-toggle').onclick = () => { lossVisible = !lossVisible; byId('guesser-chart').src = `assets/guesser-${lossVisible ? 'loss' : 'accuracy'}.png`; byId('guesser-chart').alt = `Original Drive chart comparing Guesser A and B validation ${lossVisible ? 'loss' : 'accuracy'}`; byId('chart-toggle').textContent = lossVisible ? 'View accuracy curve' : 'View loss curve'; };
  document.addEventListener('keydown', event => {
    const target = event.target instanceof Element ? event.target : null;
    if (event.altKey || event.ctrlKey || event.metaKey || target?.closest('input,textarea,select,[contenteditable]')) return;
    if (target?.closest('button,a') && [' ', 'Enter'].includes(event.key)) return;
    if (['ArrowRight', 'PageDown', ' '].includes(event.key)) { event.preventDefault(); show(current + 1); }
    if (['ArrowLeft', 'PageUp'].includes(event.key)) { event.preventDefault(); show(current - 1); }
    if (event.key === 'Home') show(0);
    if (event.key === 'End') show(slides.length - 1);
    if (event.key.toLowerCase() === 'n') toggleNotes();
    if (event.key.toLowerCase() === 'f') fullscreen();
    if (event.key === 'Escape') byId('notes-panel').hidden = true;
  });
  let startTouch = null;
  document.addEventListener('touchstart', event => { if (event.touches.length === 1 && !event.target.closest('button,a,input')) startTouch = { x: event.touches[0].clientX, y: event.touches[0].clientY }; }, { passive: true });
  document.addEventListener('touchend', event => { if (!startTouch || event.changedTouches.length !== 1) return; const dx = event.changedTouches[0].clientX - startTouch.x; const dy = event.changedTouches[0].clientY - startTouch.y; startTouch = null; if (Math.abs(dx) > 90 && Math.abs(dx) > Math.abs(dy) * 1.4) show(current + (dx < 0 ? 1 : -1)); }, { passive: true });
  document.addEventListener('touchcancel', () => { startTouch = null; }, { passive: true });
  window.addEventListener('hashchange', () => show((Number(location.hash.slice(1)) || 1) - 1));
  show(current); updateTimer();
})();
