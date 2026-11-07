(() => {
  const choices = [['brass','Brass'],['midnight','Midnight'],['forest','Forest'],['rose','Rose']];
  let selected = 'brass';
  try { const saved = localStorage.getItem('sangeetpitara-theme'); if (choices.some(([key]) => key === saved)) selected = saved; } catch {}
  document.documentElement.dataset.theme = selected;
  const attach = () => {
    const bar = document.createElement('div'); bar.className = 'theme-bar';
    const label = document.createElement('label'); label.textContent = 'Theme ';
    const picker = document.createElement('select'); picker.id = 'theme-picker'; picker.setAttribute('aria-label','Theme');
    for (const [key,name] of choices) { const option = document.createElement('option'); option.value = key; option.textContent = name; picker.append(option); }
    picker.value = selected;
    picker.addEventListener('change', () => {
      document.documentElement.dataset.theme = picker.value;
      try { localStorage.setItem('sangeetpitara-theme',picker.value); } catch {}
    });
    label.append(picker); bar.append(label); document.body.prepend(bar);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded',attach,{once:true}); else attach();
})();
