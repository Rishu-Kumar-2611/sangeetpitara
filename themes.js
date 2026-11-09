(() => {
  const choices = [['dark', 'Console · Dark'], ['light', 'Console · Light']];
  // Light is the default; only an explicit earlier choice of Dark keeps it.
  let selected = 'light';
  try {
    if (localStorage.getItem('sangeetpitara-theme') === 'dark') selected = 'dark';
  } catch {}
  const apply = (key) => {
    document.documentElement.dataset.theme = key;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = key === 'light' ? '#f5f5f3' : '#0c0d0f';
  };
  apply(selected);
  const attach = () => {
    const bar = document.createElement('div'); bar.className = 'theme-bar';
    const label = document.createElement('label'); label.textContent = 'Theme ';
    const picker = document.createElement('select'); picker.id = 'theme-picker'; picker.setAttribute('aria-label','Theme');
    for (const [key,name] of choices) { const option = document.createElement('option'); option.value = key; option.textContent = name; picker.append(option); }
    picker.value = selected;
    picker.addEventListener('change', () => {
      apply(picker.value);
      try { localStorage.setItem('sangeetpitara-theme',picker.value); } catch {}
    });
    label.append(picker); bar.append(label); document.body.prepend(bar);
    const homePosition = document.createComment('Theme control home position');
    bar.before(homePosition);
    const room = document.getElementById('room-view');
    const tabs = document.getElementById('room-tabs');
    if (room && tabs) {
      const place = () => {
        const inRoom = !room.classList.contains('hidden');
        bar.classList.toggle('room-theme-bar', inRoom);
        if (inRoom && tabs.nextElementSibling !== bar) tabs.after(bar);
        else if (!inRoom && homePosition.nextSibling !== bar) homePosition.after(bar);
      };
      new MutationObserver(place).observe(room, { attributes:true, attributeFilter:['class'] });
      place();
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded',attach,{once:true}); else attach();
})();
