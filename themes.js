(() => {
  const choices = [
    ['dark', 'Dark', '#0c0d0f'],
    ['light', 'Light', '#f5f5f3'],
    ['forest', 'Forest', '#0b1713'],
    ['brass', 'Brass', '#0e0b0a'],
    ['rose', 'Rose', '#1c1018'],
  ];
  const rememberTheme = !document.documentElement.hasAttribute('data-theme-reset');
  let selected = 'light';
  if (rememberTheme) try {
    const saved = localStorage.getItem('sangeetpitara-theme');
    if (choices.some(([key]) => key === saved)) selected = saved;
  } catch {}
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
    document.body.prepend(bar);
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

/* Room artwork follows the same visual playback state as the cassette reels. */
(() => {
  const start = () => {
    const card = document.getElementById('source-card');
    const orb = document.getElementById('source-orb');
    const toggle = document.getElementById('cover-visual-toggle');
    const picker = document.getElementById('cover-visual-picker');
    const canvas = document.getElementById('cover-visual-canvas');
    if (!card || !orb || !toggle || !picker || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const options = [...picker.querySelectorAll('[data-visual]')];
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const assets = new Map();
    const storageKey = 'sangeetpitara-room-visual';
    let selected = 'cassette';
    let img;
    let pending = 0;
    let frame = 0;
    let started = null;
    let visible = false;

    const tau = Math.PI * 2;
    const palette = { ice:'#88fff1', lemon:'#fff190', cyan:'#59f3ff', pink:'#f87ae8', amber:'#ffbc65' };
    const framing = {
      bike: { crop:[132,66,1100,640], fill:'#171717', scale:.96 },
      car: { crop:[81,166,1214,426], fill:'#171717', scale:.94 },
      radio: { crop:[49,354,398,252], fill:'#231910', scale:1 }
    };
    function arc(x,y,r,from,length,color,width,alpha=1,blur=0) {
      ctx.save(); ctx.globalAlpha=alpha; ctx.strokeStyle=color; ctx.lineWidth=width;
      ctx.shadowColor=color; ctx.shadowBlur=blur; ctx.lineCap='round';
      ctx.beginPath(); ctx.arc(x,y,r,from,from+length); ctx.stroke(); ctx.restore();
    }
    function glow(x,y,r,color,alpha) {
      ctx.save(); ctx.globalAlpha=alpha; const g=ctx.createRadialGradient(x,y,0,x,y,r);
      g.addColorStop(0,color); g.addColorStop(1,'transparent');
      ctx.fillStyle=g; ctx.fillRect(x-r,y-r,r*2,r*2); ctx.restore();
    }
    function beat(t) { return Math.pow((1+Math.cos(t*tau*1.5))/2, 5); }
    function levels(t,i) {
      return Math.max(.06,Math.min(1,.39+.22*Math.sin(t*tau*1.125+i*.43)+.15*Math.cos(t*tau*.75-i*.94)+.23*beat(t)));
    }
    function bikeWheel(x,y,t,color,offset) {
      const phase=t*tau/4+offset;
      arc(x,y,163,phase,.63,color,3,.7,15);
      for (let r=117;r<=148;r+=8) arc(x,y,r,phase+.14,1.1,color,2.4,.22+.22*beat(t),8);
      ctx.save(); ctx.translate(x,y); ctx.fillStyle=color;
      for (let i=0;i<32;i++) {
        ctx.save(); ctx.rotate(i*tau/32);
        const height=1+5*levels(t+offset,i);
        for (let j=0;j<Math.ceil(height);j++) {
          ctx.globalAlpha=(.42+.36*j/height)*Math.min(1,height-j);
          ctx.fillRect(-1.7,-(108+5*j),3.4,3);
        }
        ctx.restore();
      }
      ctx.restore();
    }
    function carWheel(x,y,t,offset) {
      const angle=t*tau/4+offset;
      const r=75;
      ctx.save(); ctx.translate(x,y); ctx.rotate(angle);
      ctx.beginPath(); ctx.arc(0,0,r,0,tau); ctx.clip();
      ctx.drawImage(img,x-r,y-r,r*2,r*2,-r,-r,r*2,r*2);
      ctx.restore();
      arc(x,y,85,angle,.9,palette.cyan,4,.58+.32*beat(t),14);
      arc(x,y,85,angle+Math.PI,.71,palette.pink,4,.48+.4*beat(t),13);
      for (const side of [-1,1]) {
        ctx.save(); ctx.translate(x+side*91,y);
        ctx.scale(side,1);
        for (let i=0;i<13;i++) {
          const color=(side===1?palette.pink:palette.cyan);
          const h=(1-i/13)*(8+43*levels(t,i+offset));
          ctx.strokeStyle=color; ctx.globalAlpha=.86*(1-i/15);
          ctx.lineWidth=2; ctx.beginPath(); ctx.moveTo(i*4.3,-h/2); ctx.lineTo(i*4.3,h/2); ctx.stroke();
        }
        ctx.restore();
      }
      const notes=['♫','♪','♩'];
      for (let i=0;i<3;i++) {
        const f=(t/2+i/3+offset*.05)%1;
        const nx=x+Math.cos(i*2.15+offset)*(92+22*f);
        const ny=y-64-50*f+(i%2)*25;
        ctx.save(); ctx.globalAlpha=Math.sin(f*Math.PI)*.85; ctx.font='bold 19px system-ui';
        ctx.fillStyle=i%2?palette.pink:palette.cyan; ctx.shadowColor=ctx.fillStyle; ctx.shadowBlur=9;
        ctx.fillText(notes[i],nx,ny); ctx.restore();
      }
    }
    function radio(t) {
      const wave=(1+Math.sin(t*tau*.5))/2;
      ctx.save();
      ctx.beginPath(); ctx.rect(246,426,183,76); ctx.clip();
      const shimmer=252+170*(1-Math.cos(t*tau/4))/2;
      glow(shimmer,464,63,'#ffc27c',.17+.07*wave);
      ctx.strokeStyle='#ffc77d'; ctx.globalAlpha=.32+.17*wave;
      ctx.lineWidth=1.1;
      ctx.beginPath(); ctx.moveTo(258,475); ctx.lineTo(415,475); ctx.stroke();
      for (let i=0;i<27;i++) {
        const x=259+i*6;
        ctx.beginPath(); ctx.moveTo(x,474); ctx.lineTo(x,i%5===0?464:470); ctx.stroke();
      }
      const needle=347+3.5*Math.sin(t*tau*.5);
      ctx.shadowColor='#ffbb64'; ctx.shadowBlur=8; ctx.globalAlpha=.8;
      ctx.beginPath(); ctx.moveTo(needle,445); ctx.lineTo(needle,482); ctx.stroke();
      ctx.restore();
    }

    const paint = (time, playing) => {
      if (!img || selected === 'cassette') return;
      const { crop: [x, y, w, h], fill, scale } = framing[selected];
      const { width, height } = canvas;
      ctx.fillStyle = fill;
      ctx.fillRect(0, 0, width, height);
      const size = Math.min(width / w, height / h) * scale;
      ctx.save();
      ctx.translate((width - w * size) / 2, (height - h * size) / 2);
      ctx.scale(size, size);
      ctx.beginPath(); ctx.rect(0, 0, w, h); ctx.clip();
      ctx.translate(-x, -y);
      ctx.drawImage(img, 0, 0);
      if (playing && selected === 'bike') {
        bikeWheel(413, 470, time, palette.ice, 0);
        bikeWheel(964, 470, time, palette.lemon, Math.PI);
      } else if (playing && selected === 'car') {
        carWheel(335, 458, time, 0);
        carWheel(1042, 457, time, Math.PI * .9);
      } else if (playing && selected === 'radio') {
        radio(time);
      }
      ctx.restore();
    };

    const animate = (now) => {
      started ??= now;
      paint(((now - started) / 1000) % 8, true);
      frame = requestAnimationFrame(animate);
    };

    const sync = () => {
      const playing = img && visible && !document.hidden && !reduced.matches &&
        card.dataset.playback === 'playing';
      if (playing) {
        if (!frame) frame = requestAnimationFrame(animate);
      } else {
        cancelAnimationFrame(frame);
        frame = 0;
        started = null;
        paint(0, false);
      }
    };

    const load = (key) => {
      if (!assets.has(key)) {
        const artwork = new Image();
        artwork.src = '/branding/sangeetpitara/' + ({
          bike: '11-visual-bicycle.svg',
          car: '12-visual-sports-car.svg',
          radio: '13-visual-vintage-radio.svg',
        })[key];
        assets.set(key, artwork.decode().then(() => artwork).catch((error) => {
          assets.delete(key);
          throw error;
        }));
      }
      return assets.get(key);
    };

    const select = async (key, save = true) => {
      const request = ++pending;
      let artwork;
      if (key !== 'cassette') {
        try { artwork = await load(key); } catch { key = 'cassette'; }
      }
      if (request !== pending) return;
      cancelAnimationFrame(frame);
      frame = 0;
      started = null;
      selected = key;
      img = artwork;
      orb.dataset.visual = key;
      canvas.hidden = !img;
      for (const option of options) option.setAttribute('aria-pressed', String(option.dataset.visual === key));
      if (save) {
        try { localStorage.setItem(storageKey, key); } catch {}
      }
      paint(0, false);
      sync();
    };

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
    new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (!visible) close();
      sync();
    }).observe(orb);
    new MutationObserver(sync).observe(card, { attributes: true, attributeFilter: ['data-playback'] });
    document.addEventListener('visibilitychange', sync);
    reduced.addEventListener('change', sync);
    let saved;
    try { saved = localStorage.getItem(storageKey); } catch {}
    void select(options.some(option => option.dataset.visual === saved) ? saved : 'cassette', false);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
