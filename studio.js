(() => {
  const root = document.documentElement;
  const scene = document.querySelector('.box-scene');
  // Span the elliptical barrel roof with narrow tangent planes, from the
  // back hinge to the front lip. The painted texture wraps across the arc.
  const vault = scene.querySelector('.lid-vault');
  const bands = 24, rise = .148, depth = .48, lipHeight = .047;
  const roof = document.createDocumentFragment();
  for (let i=0;i<bands;i++) {
    const start=Math.PI*(1-i/bands), end=Math.PI*(1-(i+1)/bands);
    const y=-lipHeight-rise*Math.sin(start), z=depth/2*(1+Math.cos(start));
    const dy=rise*(Math.sin(start)-Math.sin(end));
    const dz=depth/2*(Math.cos(end)-Math.cos(start));
    const strip=document.createElement('i');
    strip.className='vault-band';
    strip.style.height='calc(var(--w) * '+Math.hypot(dy,dz)+' + 0.85px)';
    strip.style.transform='translate3d(0,calc(var(--w) * '+y+'),calc(var(--w) * '+z+')) rotateX('+Math.atan2(dz,dy)+'rad)';
    strip.style.setProperty('--row',i/(bands-1)*100+'%');
    strip.style.setProperty('--texture-height',bands*100+'%');
    const shine=Math.cos((start+end)/2-.85);
    strip.style.setProperty('--tone',shine>=0?'rgba(255,217,143,'+.17*shine+')':'rgba(34,14,17,'+(-.46*shine)+')');
    roof.append(strip);
  }
  vault.append(roof);
  const mouth = scene.querySelector('.mouth-origin');
  const landing = document.querySelector('#landing-view');
  const skip = document.querySelector('#skip-intro');
  const roomMotion = document.getElementById('footer-motion');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const timers = new Set();
  const flights = new Map();
  let chestFade;
  const releaseTime = 1380;
  const flightDuration = 1450;
  const contactOffset = .82;
  let dustLayer;
  let generation = 0;
  let paused = false;
  try { paused = localStorage.getItem('studio-motion') === 'paused'; } catch {}

  // Two moving banks of fine strings leave the centre quiet and put motion
  // in the visible margins, including above and below the cards on a phone.
  const canvas = document.querySelector('.sound-garden');
  const ctx = canvas.getContext('2d');
  let width = 0, height = 0, frame = 0, lastDraw = 0, elapsed = 0;
  function ribbonY(x, bank, strand, t) {
    const direction = bank === 0 ? 1 : -1;
    const baseline = bank === 0 ? .12 : .85;
    const amplitude = Math.min(height * .13, 95);
    return height * baseline + direction * (
      Math.sin(x / width * 5.8 + t * .36 + strand * .045) * amplitude +
      Math.cos(x / width * 9.2 - t * .23 + strand * .06) * amplitude * .44 +
      strand * Math.min(2.3, height * .0033)
    );
  }
  // Paint the grooves once. During motion only the finished record rotates.
  function pressRecord(label, light) {
    const surface = document.createElement('canvas');
    surface.width = surface.height = 560;
    const pen = surface.getContext('2d');
    const tau = Math.PI * 2;
    pen.translate(280,280);
    pen.beginPath(); pen.arc(0,0,275,0,tau); pen.clip();
    const sheen = pen.createConicGradient(-.5,0,0);
    ['#121211','#514a45','#141414','#252425','#6b635c','#1e1b1a','#121211'].forEach((c,i)=>sheen.addColorStop(i/6,c));
    pen.fillStyle=sheen; pen.fillRect(-280,-280,560,560);
    for (let radius=78; radius<=274; radius+=2.3) {
      pen.lineWidth = radius%19<2.3 ? 1.6 : .75;
      pen.strokeStyle = radius%19<2.3 ? '#090808a0' : '#e2c89c55';
      pen.beginPath(); pen.arc(0,0,radius,0,tau); pen.stroke();
    }
    pen.beginPath(); pen.arc(0,0,77,0,tau); pen.fillStyle=label; pen.fill();
    pen.save(); pen.clip();
    pen.fillStyle = '#e4c68b80'; pen.fillRect(-80,-44,160,2);pen.fillRect(-80,-40,160,1);
    pen.fillStyle = '#210f1575'; pen.fillRect(-80,34,160,42);
    for (let i=0;i<21;i++) {
      const h = 2+Math.abs(Math.sin(i*.53))*14;
      pen.fillStyle='#e9d2a5bd';pen.fillRect(-29+i*2.8,43-h/2,1.6,h);
    }
    pen.restore();
    pen.strokeStyle='#e2c085a0';pen.lineWidth=2;
    pen.beginPath();pen.arc(0,0,68,0,tau);pen.stroke();
    pen.beginPath();pen.arc(0,0,8,0,tau);pen.fillStyle=light?'#ded7c9':'#211c20';pen.fill();
    return surface;
  }
  let discs = [], lightDiscs;
  function drawRecords(t,light) {
    if (lightDiscs!==light) {
      discs = [pressRecord('#7b302a',light),pressRecord('#28695e',light)];
      lightDiscs = light;
    }
    const radius = Math.max(116,Math.min(width*.19,height*.36,340));
    for (let i=0;i<discs.length;i++) {
      ctx.save();
      ctx.translate(width*(i ? .989 : .012),height*(i ? .77 : .30));
      ctx.rotate((i ? -1 : 1)*(t*.16+.35));
      ctx.globalAlpha = light ? .45 : .79;
      ctx.drawImage(discs[i],-radius,-radius,radius*2,radius*2);
      ctx.restore();
    }
  }
  function drawNote(x,y,angle,rgb,doubleNote) {
    ctx.save(); ctx.translate(x,y); ctx.rotate(angle);ctx.fillStyle=ctx.strokeStyle='rgba('+rgb+',.85)';
    ctx.lineWidth=1.6;ctx.lineCap='round';
    function stem(offset,rise) {
      ctx.beginPath();ctx.ellipse(offset,rise,3.9,2.7,-.38,0,Math.PI*2);ctx.fill();
      ctx.beginPath();ctx.moveTo(offset+3,rise-1);ctx.lineTo(offset+3,rise-15);ctx.stroke();
    }
    stem(0,0);
    if (doubleNote) {stem(9,-2);ctx.fillRect(3,-16,9,2.7);}
    else {ctx.beginPath();ctx.moveTo(3,-15);ctx.quadraticCurveTo(11,-12,8,-7);ctx.stroke();}
    ctx.restore();
  }
  function drawEntrySignal(t,light) {
    // Stereo traces move across the deck grid. The form covers their middle.
    const amplitude = Math.min(height * .085, 64);
    const period = Math.max(100, Math.min(width * .2, 260));
    ctx.save();
    ctx.lineJoin = 'round';
    for (let channel = 0; channel < 2; channel++) {
      const axis = height * (channel ? .71 : .35);
      const ink = channel ? (light ? '#2c518b' : '#8faed9') : (light ? '#086e68' : '#7cd8c2');
      ctx.strokeStyle = ink;
      ctx.globalAlpha = .18;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0,axis); ctx.lineTo(width,axis); ctx.stroke();
      ctx.beginPath();
      for (let x = 0; x <= width + 3; x += 3) {
        const phase = x / period * 2 * Math.PI - t * 1.5 + channel * 2;
        const envelope = .15 + .85 * Math.cos(phase * .26) ** 4;
        const signal = Math.sin(phase * 2) + .32 * Math.sin(phase * 4 + channel);
        const y = axis + amplitude * envelope * signal;
        if (x === 0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
      }
      ctx.lineWidth = 5; ctx.globalAlpha = .06; ctx.stroke();
      ctx.lineWidth = 1.6; ctx.globalAlpha = light ? .46 : .62; ctx.stroke();
    }
    ctx.restore();
  }
  function draw() {
    if (!ctx || !width || !height) return;
    const light = root.dataset.theme === 'light';
    const t = elapsed / 1000;
    ctx.clearRect(0, 0, width, height);
    if (!landing.classList.contains('hidden') && ['create','join'].includes(landing.dataset.entryScreen)) {
      drawEntrySignal(t,light);
      return;
    }
    const roomStage = landing.dataset.entryScreen !== 'home' || landing.classList.contains('hidden');
    if (roomStage) drawRecords(t,light);
    ['207,144,76','52,157,144'].forEach((rgb, bank) => {
      const cx = width * ((bank ? .78 : .19) + .09 * Math.sin(t * .18 + bank));
      const cy = height * (bank ? .80 : .22);
      const radius = Math.max(width * .48,height * .62);
      const glow = ctx.createRadialGradient(cx,cy,0,cx,cy,radius);
      glow.addColorStop(0,'rgba('+rgb+','+(light ? .14 : .20)+')');
      glow.addColorStop(1,'rgba('+rgb+',0)');
      ctx.fillStyle = glow;
      ctx.fillRect(0,0,width,height);
      for (let i = 0; i < 5; i++) {
        const strand=i*3;
        ctx.lineWidth = strand % 5 === 0 ? 1.25 : .8;
        ctx.strokeStyle = 'rgba('+rgb+','+(.13 + (strand%5)*.042)+')';
        ctx.beginPath();
        for (let x = -8; x <= width+8; x += 8) {
          const y = ribbonY(x,bank,strand,t);
          if (x === -8) ctx.moveTo(x,y); else ctx.lineTo(x,y);
        }
        ctx.stroke();
      }
      for (let bead = 0; bead < 7; bead++) {
        const pos = (bead * .381966 + t * (.016 + (bead%3)*.003)) % 1;
        const x = (bank ? 1-pos : pos) * width;
        const y = ribbonY(x,bank,(bead*7)%16,t);
        if (roomStage || bead % 3 === 0) drawNote(x,y,Math.sin(t*.3+bead)*.11,rgb,bead%3===0);
        else {
          ctx.fillStyle = 'rgba('+rgb+',.83)';
          ctx.beginPath(); ctx.arc(x,y,bead%4 === 0 ? 2.4 : 1.55,0,Math.PI*2); ctx.fill();
        }
      }
    });
  }
  function tick(now) {
    if (now-lastDraw >= 40) {
      if (lastDraw) elapsed += Math.min(now-lastDraw,100);
      lastDraw = now; draw();
    }
    frame = requestAnimationFrame(tick);
  }
  function syncBackground() {
    cancelAnimationFrame(frame); frame = 0; lastDraw = 0;
    if (!ctx || document.hidden) return;
    draw();
    if (!paused && !reduced.matches) frame = requestAnimationFrame(tick);
  }
  function resizeCanvas() {
    width = document.documentElement.clientWidth;
    height = window.innerHeight;
    const ratio = Math.min(window.devicePixelRatio || 1,1.5);
    canvas.width = Math.round(width*ratio); canvas.height = Math.round(height*ratio);
    ctx?.setTransform(ratio,0,0,ratio,0,0); draw();
  }
  function syncMotion() {
    root.classList.toggle('motion-paused',paused);
    roomMotion.setAttribute('aria-pressed',String(paused));
    roomMotion.textContent=paused?'Resume motion':'Pause motion';
    roomMotion.hidden=reduced.matches;
    document.dispatchEvent(new Event('studio-motion'));
    syncBackground();
  }
  function later(fn, delay) {
    const timer = setTimeout(() => { timers.delete(timer); fn(); },delay);
    timers.add(timer);
  }
  function dustAtContact(x, y, width, contactTime) {
    const burst = document.createElement('div');
    burst.className = 'landing-impact';
    burst.style.left = x - width / 2 + 'px';
    burst.style.top = Math.min(y,innerHeight - 6) + 'px';
    burst.style.width = width + 'px';
    burst.style.setProperty('--contact', contactTime + 'ms');
    const spread = Math.min(1, Math.max(.66, width / 520));
    for (const side of [-1, 1]) {
      const source = document.createElement('div');
      source.className = 'dust-source';
      source.style.left = (side < 0 ? 10 : 90) + '%';
      const plume = document.createElement('i');
      plume.className = 'dust-plume';
      plume.style.setProperty('--drift', side * (42 + Math.random() * 16) * spread + 'px');
      plume.style.setProperty('--turn', side * (-5 - Math.random()*6) + 'deg');
      source.append(plume);
      for (let i = 0; i < 8; i++) {
        const grain = document.createElement('i');
        grain.className = 'dust-grain';
        const travel = side * (12 + Math.random() * 55) * spread;
        const lift = (5 + Math.random() * 18) * spread;
        grain.style.left = (Math.random() - .5) * 28 + 'px';
        grain.style.setProperty('--crest-x', travel * .58 + 'px');
        grain.style.setProperty('--crest-y', -lift + 'px');
        grain.style.setProperty('--land-x', travel + 'px');
        grain.style.setProperty('--size', 1.7 + Math.random() * 2.6 + 'px');
        source.append(grain);
      }
      burst.append(source);
    }
    return burst;
  }
  const track = document.querySelector('#intro-track');

  let introAudioEvents;

  function finish() {
    introAudioEvents?.abort();
    track.pause();
    generation++;
    timers.forEach(clearTimeout); timers.clear();
    for (const [part,flight] of flights) {
      flight.cancel();
      part.classList.remove('pitara-piece');
    }
    flights.clear();
    dustLayer?.remove(); dustLayer=undefined;
    chestFade?.cancel(); chestFade=undefined;
    scene.hidden = true; skip.hidden = true;
    scene.classList.remove('open','leaving');
    root.classList.remove('pitara-running','pitara-pending');
  }
  function pose(x,y,scale,angle=0) {
    return 'translate('+x+'px,'+y+'px) rotate('+angle+'deg) scale('+scale+')';
  }
  function fly(part, order, origin, overview, insetY) {
    const rect = part.getBoundingClientRect();
    const cx = rect.left + rect.width/2, cy = rect.top + rect.height/2;
    const target = {x:innerWidth/2+(cx-innerWidth/2)*overview, y:insetY+cy*overview};
    const lift = Math.min(132,innerHeight*.16);
    // A recognisable, partially unfolded piece rises above the lip before it
    // turns towards its destination. The front edge masks the first frames.
    const launchScale = Math.min(.94, Math.max(.22,innerWidth*.44/rect.width),175/rect.height);
    const direction = target.x < origin.x ? -1 : 1;
    const arcX = origin.x + (target.x-origin.x)*.50 + direction*Math.min(38,innerWidth*.045);
    const arcY = origin.y - lift + (target.y-origin.y+lift)*.35;
    const end = pose(target.x-cx,target.y-cy,overview);
    const delay = releaseTime + order*370;
    const drop = Math.min(14, Math.max(7, rect.height * overview * .13));
    const compression = {x:1.004,y:.988};
    part.classList.add('pitara-piece');
    const flight = part.animate([
      {transform:pose(origin.x-cx,origin.y-cy,.025,-direction*7),zIndex:8,opacity:0,clipPath:'inset(0 0 100% 0)',offset:0,easing:'ease-out'},
      {transform:pose(origin.x-cx,origin.y-cy-lift*.40,launchScale*.7,-direction*6),opacity:1,clipPath:'inset(0 0 0% 0)',offset:.18},
      {transform:pose(origin.x-cx+direction*8,origin.y-cy-lift,launchScale,-direction*4),opacity:1,clipPath:'inset(0 0 0% 0)',offset:.40},
      {transform:pose(arcX-cx,arcY-cy,launchScale+(overview-launchScale)*.55,-direction*2),zIndex:8,opacity:1,offset:.57,easing:'ease-out'},
      {transform:pose(target.x-cx,target.y-cy-drop,overview,-direction*.55),opacity:1,offset:.74,easing:'ease-in'},
      {transform:pose(target.x-cx+direction,target.y-cy+2,overview) + ' scale('+compression.x+','+compression.y+')',opacity:1,offset:contactOffset,easing:'ease-out'},
      {transform:pose(target.x-cx,target.y-cy-drop*.30,overview,direction*.15),opacity:1,offset:.90,easing:'ease-in-out'},
      {transform:end,opacity:1,zIndex:0,offset:1}
    ], {duration:flightDuration,delay,fill:'both',easing:'linear'});
    flights.set(part,flight);
    const burst = dustAtContact(target.x+direction,target.y+rect.height*overview*compression.y/2,
      rect.width*overview*compression.x,delay+flightDuration*contactOffset);
    return {part,end,burst};
  }
  function canPlayIntro() {
    return !paused && !reduced.matches && !document.hidden && Element.prototype.animate &&
      landing.dataset.entryScreen === 'home' && !landing.classList.contains('hidden');
  }
  function openIntro() {
    finish();
    if (!canPlayIntro()) return;
    root.classList.add('pitara-pending');
    window.scrollTo({top:0,behavior:'instant'});
    scene.hidden = false;
    skip.hidden = false;
    animateIntro(generation);
  }

  function playOpeningTrack(start) {
    const events = new AbortController();
    introAudioEvents = events;
    const options = {signal:events.signal};
    function play() {
      track.play().catch(error => {
        if (error.name !== 'NotAllowedError') events.abort();
      });
    }
    function retry(event) {
      if (!event.isTrusted || !track.paused || skip.contains(event.target) ||
          event.key === 'Tab' || event.key === 'Escape') return;
      play();
    }
    // Keep late permission or buffering aligned to the still-visible landings.
    track.addEventListener('playing', () => {
      events.abort();
      const offset = Math.max(0, (performance.now() - start) / 1000);
      if (offset >= track.duration) track.pause();
      else if (Math.abs(track.currentTime - offset) > .08) track.currentTime = offset;
    }, options);
    document.addEventListener('click', retry, options);
    document.addEventListener('keydown', retry, options);
    track.currentTime = 0;
    play();
  }

  async function animateIntro(run) {
    root.classList.add('pitara-running');
    // Each target is a real piece of the page. The nav's painted backing is
    // separate so its moving children have a stable coordinate system.
    const parts = [...document.querySelectorAll(
      '.studio-header, .action-backdrop, .welcome-intro, #welcome-actions [data-open-screen], .site-footer'
    )].filter(el => el.getBoundingClientRect().width);
    const lip = mouth.getBoundingClientRect();
    const origin = {x:lip.left+lip.width/2,y:lip.top+lip.height/2};
    const pageHeight = Math.max(...parts.map(p=>p.getBoundingClientRect().bottom));
    const overview = Math.min(1,(innerHeight-20)/pageHeight);
    const insetY = overview<1 ? 10 : 0;
    const landings = parts.map((part,i)=>fly(part,i,origin,overview,insetY));
    // Drive the crossfade and the page flights from the same animation clock,
    // including after a slow frame on a phone.
    dustLayer = document.createElement('div');
    dustLayer.className = 'pitara-dust';
    dustLayer.setAttribute('aria-hidden','true');
    dustLayer.append(...landings.map(landing=>landing.burst));
    document.body.append(dustLayer);
    scene.classList.add('open');
    const dustMotions = dustLayer.getAnimations({subtree:true});
    const opening = scene.getAnimations({subtree:true});
    chestFade = scene.animate([
      {opacity:1,offset:0}, {opacity:.56,offset:.18},
      {opacity:.21,offset:.40}, {opacity:.06,offset:.72}, {opacity:0,offset:1}
    ], {delay:releaseTime-100,duration:3150,fill:'both',easing:'linear'});
    const start = document.timeline.currentTime ?? performance.now();
    for (const motion of [chestFade,...opening,...flights.values(),...dustMotions]) motion.startTime=start;
    root.classList.remove('pitara-pending');
    playOpeningTrack(start);
    await Promise.allSettled([...flights.values(),...dustMotions].map(a=>a.finished));
    if (run !== generation) return;
    scene.classList.add('leaving');
    if (overview===1) {finish(); return;}
    // Zoom the complete composition back to reading size on short screens.
    for (const {part,end} of landings) {
      flights.get(part).cancel();
      flights.set(part,part.animate([{transform:end},{transform:'none'}],{duration:490,easing:'ease-in-out',fill:'both'}));
    }
    later(finish,500);
  }
  roomMotion.addEventListener('click', () => {
    finish(); paused = !paused; syncMotion();
    try {localStorage.setItem('studio-motion',paused?'paused':'on');} catch {}
  });
  skip.addEventListener('click',()=>{finish(); landing.querySelector('[data-open-screen="create"]').focus({preventScroll:true});});
  document.addEventListener('keydown', e => {
    if (scene.hidden) return;
    if (e.key === 'Escape') finish();
    if (e.key === 'Tab' && document.activeElement !== skip) {
      e.preventDefault();
      skip.focus();
    } else if (e.key === 'Tab' && (e.shiftKey || document.activeElement === skip)) {
      finish();
    }
  });
  window.addEventListener('resize',()=>{if(!scene.hidden && width !== root.clientWidth) finish();resizeCanvas();});
  document.addEventListener('visibilitychange',()=>{if(document.hidden) finish();syncBackground();});
  window.addEventListener('pagehide',finish);
  new MutationObserver(()=>{if(landing.dataset.entryScreen!=='home'||landing.classList.contains('hidden')) finish();draw();})
    .observe(landing,{attributes:true,attributeFilter:['class','data-entry-screen']});
  new MutationObserver(draw).observe(root,{attributes:true,attributeFilter:['data-theme']});
  reduced.addEventListener('change',()=>{finish();syncMotion();});
  function ready() {
    resizeCanvas(); syncMotion();
    if (location.hash || new URLSearchParams(location.search).has('room')) finish();
    else openIntro();
  }
  if (document.readyState==='loading') document.addEventListener('DOMContentLoaded',ready,{once:true});
  else ready();
})();
