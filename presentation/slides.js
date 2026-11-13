'use strict';
(() => {
  const config = window.PRESENTATION;
  const slides = Array.from(document.querySelectorAll('.slide'));
  // Short translations follow the English phrase they explain.
  const translations = {
    'THE IDEA': [['h1','描画ゲームにおける描画途中のスケッチのVision Transformerによる認識'],['.lead','AIより先に絵を当てられる？']],
    'THE INSPIRATION': [['.lead','一人がお題を描き、他の人が推測します。'],['.caption','次のプレイヤーが描きます。']],
    'OUR TWIST': [['.box.blue p','人間と同時に絵を推測します。'],['.box.pink p','文字の可能性を警告。公平かはプレイヤーが判断します。'],['.caption','時計や看板の文字は絵の一部にもなります。']],
    'GUESSER DATA': [['.lead','345種類の人間のスケッチ。線と描画時刻を保存。'],['.caption','時刻から描画途中の状態を再現できます。']],
    'GUESSER / PREPARE': [['.pipeline li:nth-child(1)','整理してサンプルを選択'],['.pipeline li:nth-child(2)','元の絵を学習・検証・テストに分割'],['.pipeline li:nth-child(3)','完成画・途中画を生成'],['.pipeline li:nth-child(4)','切り抜き・余白追加・224×224'],['.lesson','同じ元の絵の画像は同じ分割に保ち、データ漏洩を防ぎます。']],
    'GUESSER / LESSON': [['.sizes div:nth-child(1) p','各クラス500枚'],['.sizes div:nth-child(2) p','各クラス2,000枚'],['.sizes div:nth-child(3) p','各クラス5,000枚'],['.lesson','345種類を維持し、画像数を減らして実験を速めます。']],
    'GUESSER / TRAIN': [['.lead','事前学習済みViT-Tinyと345クラスの分類器'],['.box.yellow p','完成したスケッチで学習'],['.box.lime p','完成画20%、描画時間10〜90%の途中画80%'],['.caption','初期重みと学習量を合わせ、検証結果でチェックポイントを選択。']],
    'REFEREE DATA': [['.lead','通常とは異なる内容を含むスケッチ'],['.caption','文字と数字の存在に注目します。']],
    'REFEREE / PIPELINE': [['.pipeline li:nth-child(1)','画像と注釈を読み込み'],['.pipeline li:nth-child(2)','文字・数字の有無をラベル化'],['.pipeline li:nth-child(3)','ViTを追加学習'],['.pipeline li:nth-child(4)','適合率・再現率・F1で評価'],['.caption','文字や数字を手がかりの可能性として警告します。']],
    'REFEREE / MISTAKE': [['.polarity figure:nth-child(1) figcaption','学習画像：黒地に白'],['.polarity figure:nth-child(3) figcaption','ゲーム：白地に黒'],['.callout p','配備モデルの試験で白い空白画面に約50%'],['.lesson','空白画面も含め、モデルへの入力画像を確認します。']],
    'REFEREE / REPAIR': [['.box.lime p','どちらの極性でも前景を正規化'],['.box.pink p','一様な画面を文字分類の前に空白と判定'],['.lesson','前処理は確認済み。修正版の本番再学習は未完了です。']],
    'GUESSER / RESULTS': [['.metrics p:nth-child(1) span','A：完成画'],['.metrics p:nth-child(2) span','B：途中画'],['.caption','学習中の完成画の検証結果。描画途中や未使用テストでの性能は示していません。']],
    'GUESSER / FIRST CORRECT': [['.lead','10段階のうち、初めて正解を予測した段階。'],['.caption','未使用テスト172,500枚。ゲームの得点ではありません。']],
    'GUESSER / EXAMPLES': [['.specimen-status','モデルAの完成画の検証例。予測クラスの信頼度です。'],['.specimen-row h3','信頼度が低い例'],['.specimen-row + .specimen-row h3','信頼度が高い例']],
    'REFEREE / RESULTS': [['.metrics p:nth-child(1) span','文字'],['.metrics p:nth-child(2) span','数字'],['.caption','代理ラベルと閾値0.5による過去の評価。実ゲームや修正版の性能は未検証です。']],
    'REFEREE / TRAINING': [['.chart:nth-child(1) figcaption','文字の平均適合率'],['.chart:nth-child(2) figcaption','検証損失'],['.caption','過去の学習の検証曲線。平均適合率は正解率ではありません。']],
    'LIVE DEMO': [['h2','Guesserに勝てる？']]
  };
  slides.forEach(slide => {
    (translations[slide.dataset.label] || []).forEach(([selector, text]) => {
      const target = slide.querySelector(selector);
      if (!target) return;
      const translation = document.createElement('span');
      translation.className = 'japanese-translation';
      translation.lang = 'ja';
      translation.hidden = true;
      translation.textContent = text;
      target.append(translation);
    });
  });
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
  byId('japanese-toggle').onclick = () => {
    const enabled = byId('japanese-toggle').getAttribute('aria-pressed') !== 'true';
    byId('japanese-toggle').setAttribute('aria-pressed', String(enabled));
    document.body.classList.toggle('japanese-enabled', enabled);
    document.querySelectorAll('.japanese-translation').forEach(el => { el.hidden = !enabled; });
  };
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
