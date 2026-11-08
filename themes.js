(() => {
  const choices = [['dark', 'Mehfil · Dark'], ['light', 'Playground · Light']];
  let selected = 'dark';
  try {
    const saved = localStorage.getItem('sangeetpitara-theme');
    // Older palettes were dark; also accept the light design-preview names.
    if (['light', 'playground', 'courtyard'].includes(saved)) selected = 'light';
  } catch {}
  const apply = (key) => {
    document.documentElement.dataset.theme = key;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = key === 'light' ? '#f1eee5' : '#191715';
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
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded',attach,{once:true}); else attach();
})();
