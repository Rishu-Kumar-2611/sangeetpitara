(() => {
  const choices = [
    ['dark', 'Dark', '#0c0d0f'],
    ['light', 'Light', '#f5f5f3'],
    ['forest', 'Forest', '#0b1713'],
    ['brass', 'Brass', '#0e0b0a'],
    ['rose', 'Rose', '#1c1018'],
  ];
  const rememberTheme = !document.documentElement.hasAttribute('data-theme-reset');
  let selected = document.querySelector('link[href^="/studio.css"]') ? 'dark' : 'light';
  if (rememberTheme) try {
    const saved = localStorage.getItem('sangeetpitara-theme');
    if (choices.some(([key]) => key === saved)) selected = saved;
  } catch {}
  // Hold the welcome pieces until their measured flight paths are ready.
  if (selected === 'dark' && !location.hash && !new URLSearchParams(location.search).has('room') &&
      !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    let enableIntro = true;
    try { enableIntro = localStorage.getItem('studio-motion') !== 'paused'; } catch {}
    if (enableIntro) {
      if (matchMedia('(max-width: 600px)').matches) {
        const art = document.createElement('link');
        art.rel = 'preload';
        art.as = 'image';
        art.fetchPriority = 'high';
        art.href = '/guide/img/pitara-peacocks-phone.webp';
        document.head.append(art);
      }
      document.documentElement.classList.add('pitara-pending');
      setTimeout(() => document.documentElement.classList.remove('pitara-pending'), 2200);
    }
  }
  const apply = (key) => {
    document.documentElement.dataset.theme = key;
    const meta = document.querySelector('meta[name="theme-color"]');
    const choice = choices.find(([value]) => value === key);
    if (meta && choice) meta.content = choice[2];
  };
  apply(selected);
  const attach = () => {
    const bar = document.createElement('div'); bar.className = 'theme-bar';
    const howToUse = document.createElement('a');
    howToUse.href = '/guide.html';
    howToUse.target = '_blank';
    howToUse.rel = 'noopener';
    howToUse.className = 'how-to-use-btn';
    howToUse.title = 'Open User Manual in a new tab';
    howToUse.innerHTML = '<span class="how-to-use-icon" aria-hidden="true">📖</span><span>How to Use</span>';
    const label = document.createElement('label'); label.textContent = 'Theme ';
    const picker = document.createElement('select'); picker.id = 'theme-picker'; picker.setAttribute('aria-label','Theme');
    for (const [key,name] of choices) { const option = document.createElement('option'); option.value = key; option.textContent = name; picker.append(option); }
    picker.value = selected;
    picker.addEventListener('change', () => {
      apply(picker.value);
      if (rememberTheme) try { localStorage.setItem('sangeetpitara-theme',picker.value); } catch {}
    });
    label.append(picker);
    bar.append(howToUse, label);
    const studioHeader = document.querySelector(".studio-header");
    if (studioHeader) studioHeader.append(bar); else document.body.prepend(bar);
    const homePosition = document.createComment('Theme control home position');
    bar.before(homePosition);
    const room = document.getElementById('room-view');
    if (room) {
      const place = () => {
        const inRoom = !room.classList.contains('hidden');
        bar.classList.toggle('room-theme-bar', inRoom);
        const actions = room.querySelector('.topbar-actions');
        if (inRoom && actions) {
          if (actions.firstElementChild !== bar) actions.prepend(bar);
        } else if (!inRoom && homePosition.nextSibling !== bar) {
          homePosition.after(bar);
        }
      };
      new MutationObserver(place).observe(room, { attributes:true, attributeFilter:['class'] });
      place();
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded',attach,{once:true}); else attach();
})();

/* The welcome and room headers share their artwork and one visibility-aware clock. */
(() => {
  const start = () => {
    const card = document.getElementById('source-card');
    const orb = document.getElementById('source-orb');
    const toggle = document.getElementById('cover-visual-toggle');
    const picker = document.getElementById('cover-visual-picker');
    const canvas = document.getElementById('cover-visual-canvas');
    if (!card || !orb || !toggle || !picker || !canvas) return;
    const roomArt = canvas.getContext('2d');
    const welcomeCanvas = document.querySelector('.welcome-art');
    const welcomeArt = welcomeCanvas?.getContext('2d');
    if (!roomArt) return;
    const options = [...picker.querySelectorAll('[data-visual]')];
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const storageKey = 'sangeetpitara-room-visual';
    const tau = Math.PI * 2;
    let selected = 'vinyl';
    let roomVisible = false;
    let welcomeVisible = false;
    let welcomeTime = 0;
    const welcomeScenes = ['vinyl', 'spectrum', 'radio'];
    const sceneDuration = 8, dissolveDuration = 1.25;
    const blendCanvas = document.createElement('canvas');
    blendCanvas.width = 640; blendCanvas.height = 405;
    const blendArt = blendCanvas.getContext('2d');
    let frame = 0;
    let playhead = 0, previousFrame = null;
    const radio = new Image();
    radio.onload = sync;
    let vinylDisc;

    function makeVinylDisc() {
      const disc = document.createElement('canvas');
      disc.width = disc.height = 408;
      const pen = disc.getContext('2d');
      pen.translate(204, 204);
      const sweep = pen.createConicGradient(0, 0, 0);
      ['#121015','#a09583','#151218','#38323a','#111016','#aa9276','#151317','#121015'].forEach((c,i) => sweep.addColorStop(i/7,c));
      pen.fillStyle = sweep;
      pen.beginPath(); pen.arc(0,0,202,0,tau); pen.fill();
      pen.lineWidth = 1;
      pen.strokeStyle = '#03030688';
      for (let r=68;r<201;r+=3) { pen.beginPath(); pen.arc(0,0,r,0,tau); pen.stroke(); }
      pen.fillStyle = '#ff9c4e'; pen.beginPath(); pen.arc(0,0,62,0,tau); pen.fill();
      pen.fillStyle = '#702a1b'; pen.fillRect(-24,-27,48,3); pen.fillRect(-16,-20,32,2);
      pen.fillStyle = '#21151a'; pen.beginPath(); pen.arc(0,0,5,0,tau); pen.fill();
      return disc;
    }

    function renderVinyl(ctx, t) {
      const light = ctx.createLinearGradient(0, 0, 620, 405);
      light.addColorStop(0, '#743820');
      light.addColorStop(.58, '#301a23');
      light.addColorStop(1, '#100e18');
      ctx.fillStyle = light;
      ctx.fillRect(0, 0, 640, 405);
      ctx.save();
      ctx.translate(306, 216);
      ctx.rotate(t * .6);
      if (!vinylDisc) vinylDisc = makeVinylDisc();
      ctx.drawImage(vinylDisc, -204, -204);
      ctx.restore();
      ctx.lineCap = 'round'; ctx.strokeStyle = '#bfab91'; ctx.lineWidth = 9;
      ctx.beginPath(); ctx.moveTo(608,26); ctx.lineTo(556,39); ctx.lineTo(475,197); ctx.lineTo(454,215); ctx.stroke();
      ctx.fillStyle = '#ebe0c8'; ctx.save(); ctx.translate(456,214); ctx.rotate(.8); ctx.fillRect(-8,-7,17,32); ctx.restore();
    }
    function renderAurora(ctx, t) {
      const sky = ctx.createLinearGradient(0,0,640,405);
      sky.addColorStop(0,'#061e33'); sky.addColorStop(.55,'#121b35'); sky.addColorStop(1,'#360e39');
      ctx.fillStyle=sky; ctx.fillRect(0,0,640,405);
      for(let i=0;i<54;i++){
        ctx.fillStyle='rgba(227,242,255,'+(.25+(i%6)*.09)+')';
        ctx.fillRect((i*193)%640,(i*61)%350,1.6,1.6);
      }
      ctx.lineWidth=1.6;
      for(let line=0;line<44;line++){
        ctx.strokeStyle='hsla('+(158+line*2.65)+',83%,68%,.55)';
        ctx.beginPath();
        for(let x=0;x<=644;x+=5){
          const y=194+line*1.75+Math.sin(x/124+t*.52+line*.027)*58+Math.sin(x/71-t*.35+line*.055)*32;
          if(!x) ctx.moveTo(x,y); else ctx.lineTo(x,y);
        }
        ctx.stroke();
      }
    }
    function renderSpectrum(ctx, t) {
      ctx.fillStyle='#121020'; ctx.fillRect(0,0,640,405);
      for(let i=0;i<58;i++){
        const x=28+i*10.2;
        const h=19+Math.pow(Math.sin(i*.085+t*.47),2)*98+Math.pow(Math.sin(i*.36-t*.79),2)*63;
        const color='hsl('+(267+i*2.15)+',92%,70%)';
        ctx.fillStyle=color; ctx.fillRect(x,254-h,6.5,h);
        const reflection=ctx.createLinearGradient(0,258,0,365);
        reflection.addColorStop(0,color); reflection.addColorStop(1,'transparent');
        ctx.globalAlpha=.27; ctx.fillStyle=reflection; ctx.fillRect(x,258,6.5,h*.62); ctx.globalAlpha=1;
      }
    }
    function paint(ctx, visual, t) {
      if (visual === 'aurora') return renderAurora(ctx, t);
      if (visual === 'spectrum') return renderSpectrum(ctx, t);
      if (visual === 'radio' && !radio.hasAttribute('src')) {
        radio.src = '/branding/sangeetpitara/13-visual-vintage-radio.svg';
      }
      if (visual === 'radio' && radio.complete && radio.naturalWidth) {
        ctx.fillStyle = '#231910'; ctx.fillRect(0,0,640,405);
        ctx.drawImage(radio,49,354,398,252,0,0,640,405);
        ctx.fillStyle='rgba(255,183,93,'+(.08+.06*Math.sin(t*2))+')';
        ctx.fillRect(324,117,278,75);
        const needle = 365 + 86 * (1 + Math.sin(t * .37));
        ctx.fillStyle = '#f0ab75';
        ctx.fillRect(needle,128,2.4,49);
        return;
      }
      renderVinyl(ctx, t);
    }
    function drawActiveArt(seconds) {
      if (roomVisible) {
        playhead += seconds * (card.dataset.playback === 'playing' ? 1 : .65);
        paint(roomArt, selected, playhead);
      }
      if (!welcomeVisible || !welcomeArt) return;
      welcomeTime += seconds;
      const index = Math.floor(welcomeTime / sceneDuration) % welcomeScenes.length;
      const phase = welcomeTime % sceneDuration;
      paint(welcomeArt, welcomeScenes[index], welcomeTime);
      if (phase > sceneDuration - dissolveDuration && blendArt) {
        const next = welcomeScenes[(index + 1) % welcomeScenes.length];
        paint(blendArt, next, welcomeTime);
        welcomeArt.save();
        welcomeArt.globalAlpha = (phase - sceneDuration + dissolveDuration) / dissolveDuration;
        welcomeArt.drawImage(blendCanvas, 0, 0);
        welcomeArt.restore();
      }
    }
    function animate(now) {
      if (previousFrame === null) previousFrame = now;
      const delta = now - previousFrame;
      if (delta >= 50) {
        drawActiveArt(Math.min(delta, 150) / 1000);
        previousFrame = now;
      }
      frame = requestAnimationFrame(animate);
    }
    function sync() {
      cancelAnimationFrame(frame);
      previousFrame = null;
      if ((!roomVisible && !welcomeVisible) || document.hidden) return;
      drawActiveArt(0);
      if (!reduced.matches && !document.documentElement.classList.contains('motion-paused')) {
        frame = requestAnimationFrame(animate);
      }
    }
    function select(key, save=true) {
      selected=key; orb.dataset.visual=key; canvas.hidden=false;
      orb.closest('.room-stage').dataset.art=key;
      for (const option of options) option.setAttribute('aria-pressed',String(option.dataset.visual===key));
      if (save) try {localStorage.setItem(storageKey,key);} catch {}
      sync();
    }
    document.addEventListener('studio-motion',sync);

    const close = (returnFocus = false) => {
      picker.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
      if (returnFocus) toggle.focus();
    };
    toggle.addEventListener('click', () => {
      if (!picker.hidden) return close();
      picker.hidden = false;
      toggle.setAttribute('aria-expanded', 'true');
      (options.find(option => option.dataset.visual === selected) || options[0]).focus();
    });
    picker.addEventListener('click', (event) => {
      const choice = event.target.closest('[data-visual]');
      if (!choice) return;
      void select(choice.dataset.visual);
      close(true);
    });
    document.addEventListener('click', (event) => {
      if (!picker.hidden && !picker.contains(event.target) && !toggle.contains(event.target)) close();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !picker.hidden) close(true);
    });
    const visibility = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.target === orb) {
          roomVisible = entry.isIntersecting;
          if (!roomVisible) close();
        } else {
          welcomeVisible = entry.isIntersecting;
        }
      }
      sync();
    });
    visibility.observe(orb);
    if (welcomeArt) visibility.observe(welcomeCanvas);
    document.addEventListener('visibilitychange', sync);
    reduced.addEventListener('change', sync);
    let saved;
    try { saved = localStorage.getItem(storageKey); } catch {}
    void select(options.some(option => option.dataset.visual === saved) ? saved : 'vinyl', false);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
